"""流水线编排接口：触发各阶段、审查门总开关、中间产物总览（按项目隔离）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ... import artifacts as A
from ... import jobs as jobq
from ...db import get_session
from ...models import ArtifactKind, ArtifactStatus, Project, StageModel

router = APIRouter(tags=["pipeline"])

# 阶段顺序：S1 正文（酒馆桥）→ S2 分格 → S3 提示词 → S4 出图 → S5 合成 → S6 导出
# S1 由扩展领取，不在此表内（见 bridge.py）。
STAGE_ORDER = [
    ("S2", "script"),
    ("S3", "prompt"),
    ("S4", "image"),
    ("S5", "compose"),
    ("S6", "book"),
]

# 各阶段对应的产物类型与人类可读名（供前端展示中间产物）
STAGE_ARTIFACTS = {
    "S1": (ArtifactKind.PROSE.value, "正文分段"),
    "S2": (ArtifactKind.PAGE_SCRIPT.value, "分页分格"),
    "S3": (ArtifactKind.PANEL_PROMPT.value, "分镜提示词"),
    "S4": (ArtifactKind.IMAGE.value, "候选图"),
    "S5": (ArtifactKind.PAGE_IMAGE.value, "整页成图"),
    "S6": (ArtifactKind.BOOK.value, "成书导出"),
}


@router.post("/projects/{project_id}/run/{stage}")
def run_stage(project_id: int, stage: str, body: dict | None = None, session: Session = Depends(get_session)) -> dict:
    """触发某个阶段。"""
    stage = stage.upper()
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    kinds = {s: k for s, k in STAGE_ORDER}
    if stage not in kinds:
        raise HTTPException(400, f"未知阶段：{stage}（S1 正文请用 /prose/request）")
    job = jobq.enqueue(kinds[stage], project_id=project_id, stage=stage, payload={"project_id": project_id, **(body or {})})
    return {"job_id": job.id, "stage": stage, "status": job.status}


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
    """阶段级审查门状态（每个阶段各产物类型的通过/待审/需重跑统计）。"""
    out: dict = {"stages": {}}
    for stage, (kind, _label) in STAGE_ARTIFACTS.items():
        rows = A.all_current(session, project_id, kind)
        st = [r.status for r in rows]
        out["stages"][stage] = {
            "count": len(rows),
            "approved": st.count(ArtifactStatus.APPROVED.value),
            "review": st.count(ArtifactStatus.REVIEW.value),
            "stale": st.count(ArtifactStatus.STALE.value),
            "pending": st.count(ArtifactStatus.PENDING.value),
            "failed": st.count(ArtifactStatus.FAILED.value),
        }
    return out


@router.get("/projects/{project_id}/stage-artifacts")
def stage_artifacts(project_id: int, session: Session = Depends(get_session)) -> dict:
    """按阶段返回各中间产物摘要（供“流水线”页展示）。"""
    out: dict = {}
    for stage, (kind, label) in STAGE_ARTIFACTS.items():
        rows = A.all_current(session, project_id, kind)
        out[stage] = {
            "kind": kind,
            "label": label,
            "items": [
                {
                    "id": a.id,
                    "ref": a.ref,
                    "version": a.version,
                    "status": a.status,
                    "summary": _summarize(a),
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
                for a in sorted(rows, key=lambda x: x.ref)
            ],
        }
    return out


def _summarize(a) -> str:
    p = a.payload or {}
    if a.kind == ArtifactKind.PROSE.value:
        t = (p.get("text") or "").replace("\n", " ")
        return (t[:80] + "…") if len(t) > 80 else t
    if a.kind == ArtifactKind.PAGE_SCRIPT.value:
        return f"{p.get('template_id', '?')} · {len(p.get('panels', []))} 格"
    if a.kind == ArtifactKind.PANEL_PROMPT.value:
        s = (p.get("prompt_pos") or "")
        return (s[:70] + "…") if len(s) > 70 else s
    if a.kind == ArtifactKind.IMAGE.value:
        return f"{len(p.get('candidates', []))} 张候选（已选 {p.get('selected_index')}）"
    if a.kind == ArtifactKind.PAGE_IMAGE.value:
        return f"已放 {p.get('placed', '?')} 格"
    if a.kind == ArtifactKind.BOOK.value:
        return f"{p.get('pages', '?')} 页 · {list((p.get('files') or {}).keys())}"
    return ""


@router.patch("/projects/{project_id}/stage-models")
def set_stage_models(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """设置阶段→供应商绑定：{"S2": 1, "S3": 2}。"""
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
    for stage, (kind, label) in STAGE_ARTIFACTS.items():
        for a in A.all_current(session, project_id, kind):
            if a.status == ArtifactStatus.STALE.value:
                out.append({"stage": stage, "kind": a.kind, "label": label, "ref": a.ref, "version": a.version})
    return out
