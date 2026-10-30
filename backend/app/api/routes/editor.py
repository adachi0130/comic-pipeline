"""编辑文档接口（新编辑器与后台拼页共用）。

与旧 ``/med-doc`` 并存而不是替换：旧接口继续服务历史项目与回滚，
新接口是编辑器的正式存档来源。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...comic import documents as D
from ...comic.document import DocumentError
from ...comic.render import RenderError, render_png
from ...db import get_session

router = APIRouter(tags=["editor"])


@router.get("/projects/{project_id}/editor-doc/{page_ref}")
def get_editor_doc(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """取一页的可编辑文档；没有存档时按项目产物现场生成（版式 + 已采用图片）。"""
    try:
        document, meta = D.load_for_edit(session, project_id, page_ref)
    except D.DocumentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except DocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "document": document, **meta}


@router.post("/projects/{project_id}/editor-doc/{page_ref}")
def save_editor_doc(project_id: int, page_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """保存编辑文档，同时生成可审核的整页快照（``page_image``）。

    body: ``{"document": {...}, "png": "data:image/png;base64,..."（可选，客户端像素）}``
    """
    document = body.get("document")
    if document is None:
        raise HTTPException(400, "缺少 document")
    try:
        return D.save(session, project_id, page_ref, document, preview_png=body.get("png"))
    except DocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RenderError as exc:
        raise HTTPException(422, f"整页渲染失败：{exc}") from exc


@router.get("/projects/{project_id}/editor-doc/{page_ref}/preview")
def preview_editor_doc(project_id: int, page_ref: str, scale: float = 1.0,
                       session: Session = Depends(get_session)):
    """按当前已保存文档渲染预览 PNG（不落盘），供前端确认“导出即所见”。"""
    from fastapi.responses import Response

    try:
        document, _meta = D.load_for_edit(session, project_id, page_ref)
    except D.DocumentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    scale = max(0.1, min(3.0, float(scale or 1.0)))
    try:
        png = render_png(document, scale=scale, image_lookup=D.image_lookup_for(session, project_id))
    except RenderError as exc:
        raise HTTPException(422, f"渲染失败：{exc}") from exc
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/projects/{project_id}/editor-doc/{page_ref}/history")
def editor_doc_history(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    try:
        rows = D.history(session, project_id, page_ref)
    except DocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "versions": rows}


@router.get("/projects/{project_id}/editor-doc/{page_ref}/legacy")
def editor_doc_legacy(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """查看旧 MED 存档的转换结果与未支持内容清单。"""
    from ... import artifacts as A
    from ...comic.legacy import LegacyConversionError, convert_legacy_doc
    from ...models import ArtifactKind

    legacy = A.current(session, project_id, ArtifactKind.MED_DOC.value, page_ref)
    if legacy is None:
        raise HTTPException(404, "该页没有旧 MED 存档")
    try:
        document = convert_legacy_doc((legacy.payload or {}).get("doc"), page_ref=page_ref)
    except LegacyConversionError as exc:
        raise HTTPException(422, f"旧存档无法转换：{exc}") from exc
    return {"ok": True, "document": document, "conversion": document.get("conversion"),
            "version": legacy.version, "artifact_id": legacy.id}
