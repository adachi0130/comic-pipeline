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

from sqlalchemy.orm import Session

from ..artifacts import create, set_status
from ..config import get_settings
from ..models import ArtifactKind, ArtifactStatus, Job, Project
from .select import select_index

KIND = "s5_image"


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

    count = int(payload.get("count") or project.candidates_per_panel or 4)
    params = dict(payload.get("params") or project.gen_params or {})

    req = GenRequest(
        prompt_pos=str(payload.get("prompt_pos") or ""),
        prompt_neg=str(payload.get("prompt_neg") or ""),
        seed=payload.get("seed"),
        steps=params.get("steps"),
        cfg=params.get("cfg"),
        sampler=params.get("sampler"),
        scheduler=params.get("scheduler"),
        width=params.get("width"),
        height=params.get("height"),
        ckpt_name=params.get("ckpt_name"),
        denoise=params.get("denoise"),
        loras=list(payload.get("loras") or []),
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
