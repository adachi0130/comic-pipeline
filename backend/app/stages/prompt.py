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
from ..models import ArtifactKind, ArtifactStatus, Character, Job, LoraSelection, Project, Technique
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

    log = LLMLogContext(session=session, stage="S3", project_id=project_id, provider_id=provider.id)
    out: list[str] = []
    for page in pages:
        geom = (page.payload or {}).get("geometry") or {}
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
        )
        # 格数适配校验：必须与分页脚本的 panels 一一对应
        expected = len((page.payload or {}).get("panels", []))
        if len(prompts.panels) != expected:
            raise ValueError(
                f"{page.ref} 需 {expected} 格提示词（按该页模板格数），模型给了 {len(prompts.panels)} 格"
            )

        for item in prompts.panels:
            loras = item.loras or default_loras
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
                    "width": item.width,
                    "height": item.height,
                },
                inputs=[page],
                status=ArtifactStatus.REVIEW.value,
            )
            if project.review_mode == "auto":
                set_status(session, art, ArtifactStatus.APPROVED.value)
            out.append(item.panel_ref)

    session.commit()
    return {"panels": out}
