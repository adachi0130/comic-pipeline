"""S5 逐格出图作业。

payload:
    {
      "project_id": 1,
      "panel_ref": "panel:3.2",
      "prompt_pos": "...", "prompt_neg": "...",
      "count": 4,
      "params": {"steps":28,"cfg":7,"sampler":"euler","scheduler":"normal",
                 "width":832,"height":1216,"ckpt_name":"...","denoise":1.0},
      "loras": [{"name":"anima.safetensors","weight":0.8}]
    }

产出：为该格写一个 ``IMAGE`` 产物，``payload.candidates`` 是本次批次的所有候选，
按版本递增；``selected_index`` 记录选中的那张。自动模式下按策略直接选中并置 approved。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..artifacts import create, set_status
from ..config import get_settings
from ..models import ArtifactKind, ArtifactStatus, Job, Project
from .select import select_index

KIND = "s5_image"


def resolve_loras(
    session: Session, project_id: int, panel_ref: str, character_names: list[str]
) -> list[dict]:
    """解析该格最终使用的 LoRA 列表。

    合并顺序（去重，后者覆盖前者权重）：
    1. 出场角色的 LoRA（use_lora=True 才加；**一键关掉角色 LoRA 就传 use_lora=False**）
    2. 项目默认 LoRA（scope=project）
    3. 单格覆盖 LoRA（scope=panel, panel_ref 匹配）
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

    # 提示词若未随 payload 带来，就从该格的 S4 产物取
    prompt_pos = payload.get("prompt_pos")
    prompt_neg = payload.get("prompt_neg")
    if prompt_pos is None or prompt_neg is None:
        from ..artifacts import current
        from ..models import ArtifactKind

        par = current(session, project_id, ArtifactKind.PANEL_PROMPT.value, panel_ref)
        if par is not None:
            prompt_pos = prompt_pos if prompt_pos is not None else par.payload.get("prompt_pos", "")
            prompt_neg = prompt_neg if prompt_neg is not None else par.payload.get("prompt_neg", "")
            if not payload.get("loras") and par.payload.get("loras"):
                payload = {**payload, "loras": par.payload["loras"]}
    prompt_pos = prompt_pos or ""
    prompt_neg = prompt_neg or ""

    count = int(payload.get("count") or project.candidates_per_panel or 4)
    params = dict(payload.get("params") or project.gen_params or {})

    # LoRA：优先用 payload.loras；否则按“项目默认 + 单格覆盖”解析（含角色 LoRA 开关）
    loras = payload.get("loras")
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

    candidates = [
        {"index": i, "path": str(p), "seed": req.seed, "params": params}
        for i, p in enumerate(paths)
    ]

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
