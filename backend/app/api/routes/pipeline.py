"""流水线编排接口：触发各阶段、按顺序推进、审查门总开关。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ... import artifacts as A
from ... import jobs as jobq
from ...db import get_session
from ...models import ArtifactKind, ArtifactStatus, Project, StageModel

router = APIRouter(tags=["pipeline"])

# 阶段顺序与对应的作业类型
STAGE_ORDER = [
    ("S1", "s1_structure"),
    ("S3", "s3_script"),
    ("S4", "s4_prompt"),
    ("S5", "s5_image"),
    ("S6", "s6_compose"),
    ("S7", "s7_book"),
]


@router.post("/projects/{project_id}/run/{stage}")
def run_stage(project_id: int, stage: str, body: dict | None = None, session: Session = Depends(get_session)) -> dict:
    """触发某个阶段。S3/S4/S6 等按 ref 处理单页/单场。"""
    stage = stage.upper()
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    kinds = {s: k for s, k in STAGE_ORDER}
    if stage not in kinds:
        raise HTTPException(400, f"未知阶段：{stage}")
    payload = {"project_id": project_id, **(body or {})}
    job = jobq.enqueue(kinds[stage], project_id=project_id, stage=stage, payload=payload)
    return {"job_id": job.id, "stage": stage, "status": job.status}


@router.post("/projects/{project_id}/run-all")
def run_all(project_id: int, session: Session = Depends(get_session)) -> dict:
    """一键跑（M1 版：只推进到 S1，后续需按页/按场扩展）。"""
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    job = jobq.enqueue("s1_structure", project_id=project_id, stage="S1",
                       payload={"project_id": project_id})
    return {"job_id": job.id, "note": "已触发 S1；后续按页推进请调用 run/{stage}"}


@router.patch("/projects/{project_id}/review-mode")
def set_review_mode(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """全局审查总开关：auto=全部自动通过，manual=到门停住。"""
    mode = body.get("mode")
    if mode not in ("auto", "manual"):
        raise HTTPException(400, "mode 必须是 auto 或 manual")
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    p.review_mode = mode
    session.commit()
    return {"review_mode": p.review_mode}


@router.get("/projects/{project_id}/gates")
def gates(project_id: int, session: Session = Depends(get_session)) -> dict:
    """双粒度审查门状态：阶段级 + 页级。"""
    out: dict = {"stages": {}, "pages": {}}
    stage_kinds = {
        "S1": ArtifactKind.STRUCTURE.value,
        "S3": ArtifactKind.PAGE_SCRIPT.value,
        "S4": ArtifactKind.PANEL_PROMPT.value,
        "S5": ArtifactKind.IMAGE.value,
        "S6": ArtifactKind.PAGE_IMAGE.value,
    }
    for stage, kind in stage_kinds.items():
        rows = A.all_current(session, project_id, kind)
        statuses = [r.status for r in rows]
        out["stages"][stage] = {
            "count": len(rows),
            "approved": statuses.count(ArtifactStatus.APPROVED.value),
            "review": statuses.count(ArtifactStatus.REVIEW.value),
            "stale": statuses.count(ArtifactStatus.STALE.value),
            "pending": statuses.count(ArtifactStatus.PENDING.value),
        }
    for row in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value):
        out["pages"][row.ref] = row.status
    return out


@router.patch("/projects/{project_id}/stage-models")
def set_stage_models(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """设置阶段→供应商绑定：{"S1": 1, "S3": 2, "S4": 2}。"""
    for stage, provider_id in body.items():
        sm = session.get(StageModel, stage)
        if sm is None:
            session.add(StageModel(stage=stage, provider_id=int(provider_id)))
        else:
            sm.provider_id = int(provider_id)
    session.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/stale")
def stale_list(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    """列出所有因上游变更而待重跑（stale）的产物。"""
    out = []
    for kind in (ArtifactKind.STRUCTURE.value, ArtifactKind.PAGE_SCRIPT.value,
                 ArtifactKind.PANEL_PROMPT.value, ArtifactKind.IMAGE.value,
                 ArtifactKind.PAGE_IMAGE.value):
        for a in A.all_current(session, project_id, kind):
            if a.status == ArtifactStatus.STALE.value:
                out.append({"kind": a.kind, "ref": a.ref, "version": a.version})
    return out
