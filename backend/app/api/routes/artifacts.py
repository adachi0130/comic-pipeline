"""产物接口：列表、当前版、历史版本、审查（通过/驳回）、选图、失效下游预览。"""

from __future__ import annotations

from copy import deepcopy

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from ... import artifacts as A
from ...db import get_session
from ...models import Artifact, ArtifactEdge, ArtifactKind, ArtifactStatus, Project
from ...schemas import ReviewAction
from ...storage import StorageError, resolve_project_path, validate_payload_edit, validate_ref

router = APIRouter(tags=["artifacts"])


def _project_file(raw, project_id: int, *, must_exist: bool = True):
    try:
        return resolve_project_path(raw, project_id, must_exist=must_exist)
    except StorageError as exc:
        raise HTTPException(403, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "产物文件缺失") from exc


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


@router.delete("/artifacts/{artifact_id}")
def delete_artifact(artifact_id: int, session: Session = Depends(get_session)) -> dict:
    """删除某产物（含其所有版本与相关血缘边）。

    用于“这一段写废了，删掉重写”。删除后该产物的下游血缘边一并清理。
    """
    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    ids = [x.id for x in A.versions_of(session, a.project_id, a.kind, a.ref)]
    ids.append(a.id)
    session.execute(
        delete(ArtifactEdge).where(
            or_(ArtifactEdge.from_artifact_id.in_(ids), ArtifactEdge.to_artifact_id.in_(ids))
        )
    )
    session.execute(delete(Artifact).where(Artifact.id.in_(ids)))
    session.commit()
    return {"ok": True, "deleted": len(ids), "ref": a.ref}


@router.delete("/projects/{project_id}/prose")
def delete_all_prose(
    project_id: int, ref_prefix: str | None = None, session: Session = Depends(get_session)
) -> dict:
    """删除本项目全部正文分段（或按 ref 前缀部分删除）。

    删除后小说全文清空，可重新开始写。
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    rows = A.all_current(session, project_id, ArtifactKind.PROSE.value, ref_prefix=ref_prefix)
    all_ids: list[int] = []
    for a in rows:
        all_ids.extend(x.id for x in A.versions_of(session, project_id, a.kind, a.ref))
        all_ids.append(a.id)
    if not all_ids:
        return {"ok": True, "deleted": 0}
    session.execute(
        delete(ArtifactEdge).where(
            or_(ArtifactEdge.from_artifact_id.in_(all_ids), ArtifactEdge.to_artifact_id.in_(all_ids))
        )
    )
    session.execute(delete(Artifact).where(Artifact.id.in_(all_ids)))
    session.commit()
    return {"ok": True, "deleted": len(set(all_ids)), "segments": len(rows)}


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
    try:
        validate_payload_edit(a.payload or {}, body)
    except StorageError as exc:
        raise HTTPException(400, str(exc)) from exc
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
    from fastapi.responses import FileResponse

    a = session.get(Artifact, artifact_id)
    if a is None:
        raise HTTPException(404, "产物不存在")
    cands = (a.payload or {}).get("candidates") or []
    if not (0 <= index < len(cands)):
        raise HTTPException(404, "候选不存在")
    p = _project_file(cands[index].get("path"), a.project_id)
    return FileResponse(str(p))


@router.get("/artifacts/{artifact_id}/file")
def artifact_file(artifact_id: int, session: Session = Depends(get_session)):
    """内联返回产物落盘文件（如 S6 的整页 PNG）。"""
    from fastapi.responses import FileResponse

    a = session.get(Artifact, artifact_id)
    if a is None or not a.path:
        raise HTTPException(404, "产物或文件不存在")
    p = _project_file(a.path, a.project_id)
    return FileResponse(str(p))


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    import base64

    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        raise HTTPException(400, "需要 data:image/... 形式的图片")
    head, _, b64 = data_url.partition(",")
    ext = "png"
    if "image/jpeg" in head or "image/jpg" in head:
        ext = "jpg"
    elif "image/webp" in head:
        ext = "webp"
    try:
        return base64.b64decode(b64), ext
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"图片解码失败：{e}") from e


@router.post("/projects/{project_id}/panels/{panel_ref}/candidates")
def upload_candidate(project_id: int, panel_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """给某一格额外上传一张候选图（追加到候选列表）。body: {data_url}"""
    from ...storage import new_output_dir, write_new

    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    try:
        validate_ref(panel_ref, "panel")
    except StorageError as exc:
        raise HTTPException(400, str(exc)) from exc
    data, ext = _decode_data_url(body.get("data_url", ""))
    art = A.current(session, project_id, ArtifactKind.IMAGE.value, panel_ref)

    try:
        out_dir = new_output_dir(project_id, "candidates", ref=panel_ref)
    except StorageError as exc:
        raise HTTPException(403, str(exc)) from exc
    payload = dict(art.payload) if art is not None else {"candidates": [], "selected_index": None}
    cands = list(payload.get("candidates") or [])
    idx = len(cands)
    fname = f"upload_{idx + 1:02d}.{ext}"
    fpath = out_dir / fname
    write_new(fpath, data)
    cands.append({"index": idx, "path": str(fpath), "seed": None, "params": {}, "uploaded": True})
    payload = {**payload, "candidates": cands}

    if art is None:
        new = A.create(session, project_id=project_id, kind=ArtifactKind.IMAGE.value, ref=panel_ref,
                       payload=payload, path=str(out_dir), status=ArtifactStatus.REVIEW.value)
        aid = new.id
    else:
        new = A.create(session, project_id=project_id, kind=ArtifactKind.IMAGE.value, ref=panel_ref,
                       payload=payload, path=art.path or str(out_dir), inputs=[art], status=art.status)
        aid = new.id
    session.commit()
    return {"ok": True, "artifact_id": aid, "index": idx, "url": f"/api/artifacts/{aid}/candidate/{idx}"}


@router.delete("/artifacts/{artifact_id}/candidate/{index}")
def delete_candidate(artifact_id: int, index: int, session: Session = Depends(get_session)) -> dict:
    """从新版候选列表移除一张，保留历史版本引用的物理文件。"""

    a = session.get(Artifact, artifact_id)
    if a is None or a.kind != ArtifactKind.IMAGE.value:
        raise HTTPException(404, "候选产物不存在")
    payload = deepcopy(a.payload or {})
    cands = list(payload.get("candidates") or [])
    if not (0 <= index < len(cands)):
        raise HTTPException(400, "序号越界")
    _project_file(cands[index].get("path"), a.project_id, must_exist=False)
    cands.pop(index)
    for i, c in enumerate(cands):
        c["index"] = i
    sel = payload.get("selected_index")
    if sel is not None:
        sel = None if sel == index else (sel - 1 if sel > index else sel)
    new_payload = {**payload, "candidates": cands, "selected_index": sel}
    new = A.create(session, project_id=a.project_id, kind=ArtifactKind.IMAGE.value, ref=a.ref,
                   payload=new_payload, path=a.path, inputs=[a], status=a.status)
    session.commit()
    return {"ok": True, "artifact_id": new.id, "remaining": len(cands)}


def _brief(a: Artifact) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "ref": a.ref,
        "version": a.version,
        "status": a.status,
        "is_current": a.is_current,
        "has_file": bool(a.path),
        "has_candidates": bool((a.payload or {}).get("candidates")),
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
