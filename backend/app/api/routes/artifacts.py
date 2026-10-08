"""产物接口：列表、当前版、历史版本、审查（通过/驳回）、选图、失效下游预览。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import artifacts as A
from ...db import get_session
from ...models import Artifact, ArtifactStatus
from ...schemas import ReviewAction

router = APIRouter(tags=["artifacts"])


@router.get("/projects/{project_id}/artifacts")
def list_artifacts(
    project_id: int,
    kind: str | None = None,
    ref_prefix: str | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id, Artifact.is_current.is_(True)
    )
    if kind:
        stmt = stmt.where(Artifact.kind == kind)
    if ref_prefix:
        stmt = stmt.where(Artifact.ref.like(f"{ref_prefix}%"))
    rows = session.scalars(stmt.order_by(Artifact.ref)).all()
    return [_brief(a) for a in rows]


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: int, session: Session = Depends(get_session)) -> dict:
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    return _full(a)


@router.get("/projects/{project_id}/artifacts/versions")
def list_versions(
    project_id: int, kind: str, ref: str, session: Session = Depends(get_session)
) -> list[dict]:
    return [_full(a) for a in A.versions_of(session, project_id, kind, ref)]


@router.post("/artifacts/{artifact_id}/review")
def review(
    artifact_id: int, body: ReviewAction, session: Session = Depends(get_session)
) -> dict:
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    status = (
        ArtifactStatus.APPROVED.value if body.verdict == "approve" else ArtifactStatus.REJECTED.value
    )
    A.set_status(session, a, status, comment=body.comment)
    session.commit()
    session.refresh(a)
    return _full(a)


@router.post("/artifacts/{artifact_id}/select")
def select_candidate(
    artifact_id: int, body: dict, session: Session = Depends(get_session)
) -> dict:
    """人工选定候选图（G5）。"""
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    idx = int(body.get("index", 0))
    candidates = (a.payload or {}).get("candidates") or []
    if not (0 <= idx < len(candidates)):
        raise HTTPException(400, f"候选序号越界：{idx}")
    a.payload = {**(a.payload or {}), "selected_index": idx}
    A.set_status(session, a, ArtifactStatus.APPROVED.value)
    session.commit()
    session.refresh(a)
    return _full(a)


@router.get("/artifacts/{artifact_id}/downstream")
def downstream(artifact_id: int, session: Session = Depends(get_session)) -> list[dict]:
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    return [_brief(d) for d in A.downstream(session, a)]


@router.patch("/artifacts/{artifact_id}/payload")
def update_payload(artifact_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """在线编辑产物负载：写一个**新版本**（保留旧版），并触发下游失效传播。

    用于“改提示词/改台词”这类人工修改——不覆盖历史，下游自动标 stale。
    """
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    merged = {**(a.payload or {}), **body}
    new = A.create(
        session,
        project_id=a.project_id,
        kind=a.kind,
        ref=a.ref,
        payload=merged,
        path=a.path,
        status=ArtifactStatus.REVIEW.value,
    )
    session.commit()
    session.refresh(new)
    return _full(new)


@router.get("/artifacts/{artifact_id}/candidate/{index}")
def candidate_image(artifact_id: int, index: int, session: Session = Depends(get_session)):
    """内联返回某个候选图（供前端 <img> 直接展示）。"""
    from pathlib import Path

    from fastapi.responses import FileResponse

    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    cands = (a.payload or {}).get("candidates") or []
    if not (0 <= index < len(cands)):
        raise HTTPException(404, "候选不存在")
    p = Path(cands[index]["path"])
    if not p.exists():
        raise HTTPException(404, "候选文件缺失")
    return FileResponse(str(p))


@router.get("/artifacts/{artifact_id}/file")
def artifact_file(artifact_id: int, session: Session = Depends(get_session)):
    """内联返回产物落盘文件（如 S6 的整页 PNG）。"""
    from pathlib import Path

    from fastapi.responses import FileResponse

    a = session.get(Artifact, artifact_id)
    if a is None or not a.path:
        raise HTTPException(404, "产物或文件不存在")
    p = Path(a.path)
    if not p.exists():
        raise HTTPException(404, "文件缺失")
    return FileResponse(str(p))


def _brief(a: Artifact) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "ref": a.ref,
        "version": a.version,
        "status": a.status,
        "is_current": a.is_current,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def _full(a: Artifact) -> dict:
    return {
        **_brief(a),
        "payload": a.payload,
        "path": a.path,
        "source_hash": a.source_hash,
        "review_comment": a.review_comment,
        "reviewed_at": a.reviewed_at.isoformat() if a.reviewed_at else None,
    }
