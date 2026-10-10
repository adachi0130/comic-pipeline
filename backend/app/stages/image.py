"""S4 逐格出图（原 S5）。

payload: {"project_id", "panel_ref": "panel:1.1", "count": 4, "params": {...}, "loras": [...]}
提示词未随 payload 带来时，自动从该格的 S3 提示词产物取；LoRA 按角色/项目/单格三级解析。
产出：该格的 ``IMAGE`` 产物（一批候选图 + selected_index）。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..artifacts import create, current, set_status
from ..config import get_settings
from ..models import ArtifactKind, ArtifactStatus, Job, Project
from .select import select_index

KIND = "image"


def resolve_loras(session: Session, project_id: int, panel_ref: str, character_names: list[str]) -> list[dict]:
    """解析该格最终使用的 LoRA 列表。

    合并顺序（同名后者覆盖）：出场角色 LoRA → 项目默认 → 单格覆盖。
    角色 ``use_lora=False`` 时不会加入（用于“一键关掉角色 LoRA 纯提示词出图”）。
    """
    from ..models import Character, LoraSelection

    result: dict[str, dict] = {}
    if character_names:
        chars = session.scalars(
            select(Character).where(
                Character.project_id == project_id, Character.name.in_(character_names)
            )
        ).all()
        for c in chars:
            if c.use_lora and c.lora_name:
                result[c.lora_name] = {"name": c.lora_name, "weight": c.lora_weight}

    rows = session.scalars(
        select(LoraSelection)
        .where(
            LoraSelection.project_id == project_id,
            LoraSelection.enabled.is_(True),
            LoraSelection.scope.in_(("project", "panel")),
        )
        .order_by(LoraSelection.scope, LoraSelection.order_index)
    ).all()
    for r in rows:
        if r.scope == "panel" and r.panel_ref != panel_ref:
            continue
        result[r.lora_name] = {"name": r.lora_name, "weight": r.weight}
    return list(result.values())


def handle(session: Session, job: Job) -> dict:
    from ..comfy.service import GenRequest, generate, save_images  # 延迟导入，避免加载即连网

    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    panel_ref = str(payload.get("panel_ref") or "")
    if not project_id or not panel_ref:
        raise ValueError("payload 缺少 project_id / panel_ref")

    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    # 该格的 S3 提示词产物：提示词/尺寸/LoRA 的权威来源（S3 已按画框算好宽高、合并好 LoRA）
    s3_art = current(session, project_id, ArtifactKind.PANEL_PROMPT.value, panel_ref)
    s3_payload: dict = (s3_art.payload or {}) if s3_art is not None else {}

    prompt_pos = payload.get("prompt_pos")
    if prompt_pos is None:
        prompt_pos = s3_payload.get("prompt_pos", "")
    prompt_neg = payload.get("prompt_neg")
    if prompt_neg is None:
        prompt_neg = s3_payload.get("prompt_neg", "")
    prompt_pos = prompt_pos or ""
    prompt_neg = prompt_neg or ""

    count = int(payload.get("count") or project.candidates_per_panel or 4)
    # 出图参数：优先 payload，其次该格 S3 产物里烙好的（steps/cfg/sampler/scheduler/denoise/ckpt），
    # 最后才用项目级默认
    params = dict(payload.get("params") or s3_payload.get("params") or project.gen_params or {})
    # 尺寸：优先 payload，其次该格 S3 按画框算好的宽高（出图与排版一致）
    if not params.get("width"):
        params["width"] = payload.get("width") or s3_payload.get("width")
    if not params.get("height"):
        params["height"] = payload.get("height") or s3_payload.get("height")
    # LoRA：优先 payload，其次该格 S3 产物（已合并预设+角色），最后才按项目/单格/角色解析
    loras = payload.get("loras")
    if loras is None:
        loras = s3_payload.get("loras")
    if loras is None:
        loras = resolve_loras(session, project_id, panel_ref, payload.get("character_names") or [])

    req = GenRequest(
        prompt_pos=prompt_pos,
        prompt_neg=prompt_neg,
        seed=payload.get("seed"),
        steps=params.get("steps"),
        cfg=params.get("cfg"),
        sampler=params.get("sampler"),
        scheduler=params.get("scheduler"),
        width=params.get("width"),
        height=params.get("height"),
        ckpt_name=params.get("ckpt_name"),
        denoise=params.get("denoise"),
        loras=list(loras),
        count=count,
    )

    job.message = f"出图中：{panel_ref} × {count}"
    session.commit()

    images = generate(req)

    safe_ref = panel_ref.replace(":", "_").replace("/", "_")
    out_dir = get_settings().data_dir / "projects" / str(project_id) / "candidates" / safe_ref
    paths = save_images(images, out_dir, stem="cand")
    candidates = [{"index": i, "path": str(p), "seed": req.seed, "params": params} for i, p in enumerate(paths)]

    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.IMAGE.value,
        ref=panel_ref,
        payload={
            "prompt_pos": req.prompt_pos,
            "prompt_neg": req.prompt_neg,
            "params": params,
            "loras": req.loras,
            "candidates": candidates,
            "selected_index": None,
        },
        path=str(out_dir),
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto":
        idx = select_index(candidates, project.select_strategy)
        art.payload = {**art.payload, "selected_index": idx}
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()

    job.progress = count
    job.total = count
    return {"panel_ref": panel_ref, "candidates": len(candidates), "selected": art.payload.get("selected_index")}
