"""S3 分镜提示词（原 S4）。

输入：每页分格脚本（S2 产出）+ 角色资产（LoRA/词块）+ 技法库。
输出：该页每一格的 ``PANEL_PROMPT`` 产物（ref="panel:{页}.{格}"），供 S4 出图。
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..artifacts import all_current, create, current, set_status
from ..llm import LLMClient, LLMLogContext
from ..models import Artifact, ArtifactKind, ArtifactStatus, Character, Job, LoraSelection, Project, Technique
from ..schemas import PagePrompts
from . import promptlib

KIND = "prompt"


def _characters(session: Session, project_id: int) -> str:
    rows = session.scalars(select(Character).where(Character.project_id == project_id)).all()
    data = {
        c.name: {
            "trigger_words": c.trigger_words,
            "prompt_block": c.prompt_block,
            "lora_name": c.lora_name,
            "lora_weight": c.lora_weight,
            "use_lora": c.use_lora and bool(c.lora_name),
        }
        for c in rows
    }
    return json.dumps(data, ensure_ascii=False)


def _default_presets(session: Session, project_id: int) -> tuple[str, str]:
    """取项目默认的正/负向提示词预设（没有就用全局默认，再没有就空）。"""
    from ..models import PromptPreset

    def pick(kind: str) -> str:
        for scope in ("project", "global"):
            stmt = select(PromptPreset).where(
                PromptPreset.kind == kind, PromptPreset.scope == scope, PromptPreset.is_default.is_(True)
            )
            if scope == "project":
                stmt = stmt.where(PromptPreset.project_id == project_id)
            row = session.scalars(stmt.limit(1)).first()
            if row is not None and row.text.strip():
                return row.text
        return ""

    return pick("positive"), pick("negative")


def _project_loras(session: Session, project_id: int) -> list[dict]:
    rows = session.scalars(
        select(LoraSelection)
        .where(
            LoraSelection.project_id == project_id,
            LoraSelection.scope == "project",
            LoraSelection.enabled.is_(True),
        )
        .order_by(LoraSelection.order_index)
    ).all()
    return [{"name": r.lora_name, "weight": r.weight} for r in rows]


# 出图参数（写进提示词产物，出图时直接套用；不想烙进去就把 comfy 默认参数清空）
_GEN_PARAM_KEYS = ("steps", "cfg", "sampler", "scheduler", "denoise", "ckpt_name")


def _default_gen_params() -> dict:
    """当前出图后端配置里的默认参数快照，生成提示词时一并带上。"""
    try:
        from ..comfy import store

        dp = store.load_comfy_config().default_params or {}
    except Exception:  # noqa: BLE001 - 配置读不到就不带参数
        return {}
    return {k: dp[k] for k in _GEN_PARAM_KEYS if dp.get(k) is not None}


def _preset_loras(session: Session, project_id: int) -> list[dict]:
    """默认预设（正向+负向）里绑定的 LoRA，生成提示词时一并合入每格。"""
    from ..models import PromptPreset

    out: list[dict] = []
    for kind in ("positive", "negative"):
        for scope in ("project", "global"):
            stmt = select(PromptPreset).where(
                PromptPreset.kind == kind, PromptPreset.scope == scope, PromptPreset.is_default.is_(True)
            )
            if scope == "project":
                stmt = stmt.where(PromptPreset.project_id == project_id)
            row = session.scalars(stmt.limit(1)).first()
            if row is not None:
                out.extend(row.loras or [])
                break
    return out


def _character_loras(session: Session, project_id: int, names: list[str]) -> list[dict]:
    """出场角色里配了 LoRA 的（use_lora 且 lora_name 非空）。"""
    if not names:
        return []
    rows = session.scalars(
        select(Character).where(Character.project_id == project_id, Character.name.in_(names))
    ).all()
    # 按分格里的出场顺序返回
    order = {n: i for i, n in enumerate(names)}
    rows = sorted(rows, key=lambda c: order.get(c.name, 99))
    return [{"name": c.lora_name, "weight": c.lora_weight} for c in rows if c.use_lora and c.lora_name]


def _merge_loras(*groups: list[dict] | None) -> list[dict]:
    """按顺序合并多组 LoRA，同名以后出现者为准（覆盖权重）。"""
    out: dict[str, dict] = {}
    for g in groups:
        for l in g or []:
            name = (l or {}).get("name")
            if not name:
                continue
            out[name] = {"name": name, "weight": l.get("weight", 0.8)}
    return list(out.values())


# 出图基准长边像素（按排版换算宽高；保持与画框一致的宽高比）
_BASE_LONG_SIDE = 1216


def _size_from_geometry(gpan: dict, canvas: list | None) -> tuple[int, int] | None:
    """按该格在页面里的画框（几何）算出建议出图宽高，长边取 _BASE_LONG_SIDE。

    gpan 形如 {"shape":"landscape","width_pct":99.7,"height_pct":51.0,...}；
    canvas 形如 [672.0, 950.4]（模板画布像素）。
    """
    if not gpan:
        return None
    try:
        cw, ch = (canvas or [0, 0])[0], (canvas or [0, 0])[1]
        w_px = float(gpan.get("width_pct", 0)) / 100.0 * (cw or 0)
        h_px = float(gpan.get("height_pct", 0)) / 100.0 * (ch or 0)
    except (TypeError, ValueError, IndexError):
        return None
    if w_px <= 0 or h_px <= 0:
        return None
    aspect = w_px / h_px
    if aspect >= 1:  # 横格：宽为长边
        w = _BASE_LONG_SIDE
        h = _BASE_LONG_SIDE / aspect
    else:            # 竖格：高为长边
        h = _BASE_LONG_SIDE
        w = _BASE_LONG_SIDE * aspect
    return (_round64(w), _round64(h))


def _round64(v: float) -> int:
    n = max(64, int(round(v / 64.0)) * 64)
    return n


def backfill_panel_sizes(session: Session) -> int:
    """把已有提示词产物的宽高按画框重算（早期版本按长边 832/1216，导致长边过大）。

    只改“宽高”一项，不动提示词/LoRA；返回改动条数。每次启动跑一次即可。
    """
    from .. import artifacts as A

    changed = 0
    for art in session.scalars(
        select(Artifact).where(
            Artifact.kind == ArtifactKind.PANEL_PROMPT.value, Artifact.is_current.is_(True)
        )
    ).all():
        payload = dict(art.payload or {})
        ref = art.ref  # panel:<页>.<格>
        try:
            page_no, _, order_part = ref.split(":", 1)[1].partition(".")
        except (IndexError, ValueError):
            continue
        page = A.current(session, art.project_id, ArtifactKind.PAGE_SCRIPT.value, f"page:{page_no}")
        geom = ((page.payload or {}).get("geometry") if page is not None else None) or {}
        gpan = next((gp for gp in geom.get("panels") or [] if str(gp.get("index")) == order_part), None)
        size = _size_from_geometry(gpan or {}, geom.get("canvas"))
        if not size:
            continue
        if (payload.get("width"), payload.get("height")) != size:
            payload["width"], payload["height"] = size
            payload["frame"] = (gpan or {}).get("shape") or payload.get("frame", "")
            art.payload = payload
            changed += 1
    if changed:
        session.commit()
    return changed


def _techniques(session: Session) -> str:
    rows = session.scalars(select(Technique).where(Technique.enabled.is_(True))).all()
    return json.dumps({t.name: t.prompt_block for t in rows}, ensure_ascii=False)


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    if payload.get("page_ref"):
        page = current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, payload["page_ref"])
        pages = [page] if page is not None else []
    else:
        pages = [
            p
            for p in all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value)
            if p.status in (ArtifactStatus.APPROVED.value, ArtifactStatus.REVIEW.value)
        ]
    if not pages:
        raise ValueError("没有可处理的分页脚本（先跑 S2 分页分格）")

    provider, cfg = promptlib.resolve_provider(session, "S3")
    client = LLMClient(cfg)
    system, user_tpl = promptlib.get_prompt(session, "s3_prompt")
    chars = _characters(session, project_id)
    techs = _techniques(session)
    default_loras = _project_loras(session, project_id)
    preset_pos, preset_neg = _default_presets(session, project_id)
    # 预设自带的 LoRA（主人的“风格预设”里可能绑了 LoRA）
    preset_loras = _preset_loras(session, project_id)
    # 出图参数快照（steps/cfg/sampler/scheduler/denoise/ckpt），写进每格出图时直接套用
    gen_params = _default_gen_params()

    log = LLMLogContext(session=session, stage="S3", project_id=project_id, provider_id=provider.id)
    # 只生成指定的某一格（panel_ref）时，其余格跳过（从任务 payload 取，别被下面覆盖）
    only_panel = payload.get("panel_ref")
    out: list[str] = []
    from .. import jobs as jobq
    job.total = len(pages)
    job.progress = 0
    session.commit()
    for page in pages:
        if jobq.is_cancelled(job.id):
            break
        page_payload = page.payload or {}
        job.message = f"正在生成第 {page.ref.split(':', 1)[-1]} 页提示词，等待模型返回"
        session.commit()
        geom = page_payload.get("geometry") or {}
        geometry_by_order = {p.get("index"): p for p in (geom.get("panels") or [])}
        user = promptlib.render(
            user_tpl,
            {
                "PAGE_SCRIPT_JSON": json.dumps(page.payload, ensure_ascii=False),
                "CHARACTERS_JSON": chars,
                "TECHNIQUES_JSON": techs,
                "PANEL_GEOMETRY_JSON": json.dumps(geom, ensure_ascii=False),
                "PRESET_POSITIVE": preset_pos or "（无，按系统提示词默认）",
                "PRESET_NEGATIVE": preset_neg or "（无，按系统提示词默认）",
            },
        )
        prompts: PagePrompts = client.structured(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            PagePrompts,
            log=log,
            should_cancel=lambda: jobq.is_cancelled(job.id),
        )
        if jobq.is_cancelled(job.id):
            break
        # 格数适配校验：必须与分页脚本的 panels 一一对应
        expected = len(page_payload.get("panels", []))
        if len(prompts.panels) != expected:
            raise ValueError(
                f"{page.ref} 需 {expected} 格提示词（按该页模板格数），模型给了 {len(prompts.panels)} 格"
            )

        # 该页每格的分格脚本（取 characters / panel_order）
        script_by_order = {p.get("panel_order"): p for p in page_payload.get("panels", [])}
        for item in prompts.panels:
            if only_panel and item.panel_ref != only_panel:
                continue
            # 第几格（panel_ref = panel:<页>.<格>）
            try:
                order = int(item.panel_ref.rsplit(".", 1)[1])
            except (ValueError, IndexError):
                order = None
            script_panel = script_by_order.get(order) or {}
            char_loras = _character_loras(session, project_id, script_panel.get("characters") or [])
            # LoRA 合并顺序：预设 → 项目默认 → 出场角色 → 模型给的角色 LoRA（后者覆盖权重）
            loras = _merge_loras(preset_loras, default_loras, char_loras, item.loras)

            # 尺寸：按该格排版（模板几何）算出，保证与画框一致；几何缺失才退回模型给的
            gpan = geometry_by_order.get(order) or {}
            size = _size_from_geometry(gpan, geom.get("canvas"))
            width = size[0] if size else item.width
            height = size[1] if size else item.height

            art = create(
                session,
                project_id=project_id,
                kind=ArtifactKind.PANEL_PROMPT.value,
                ref=item.panel_ref,
                payload={
                    "prompt_pos": item.prompt_pos,
                    "prompt_neg": item.prompt_neg,
                    "loras": loras,
                    "seed": item.seed,
                    "width": width,
                    "height": height,
                    "frame": gpan.get("shape") or "",
                    "params": dict(gen_params),
                },
                inputs=[page],
                status=ArtifactStatus.REVIEW.value,
            )
            if project.review_mode == "auto":
                set_status(session, art, ArtifactStatus.APPROVED.value)
            out.append(item.panel_ref)

        job.progress += 1
        job.message = f"已完成 {job.progress}/{job.total} 页提示词 · {len(out)} 格"
        session.commit()

    session.commit()
    return {"panels": out}
