"""编辑文档（editor_doc）的读写与整页快照。

职责边界：
- ``load_for_edit``：优先返回已保存的新文档，其次转换旧 ``med_doc`` 保留手工内容，
  最后才从项目产物生成默认文档（版式 + 已采用图片）。
- ``save``：写新版本 ``editor_doc`` + 渲染整页 PNG 写 ``page_image``，两者同时建立血缘，
  保证审核、总览、成册导出与旧链路一致。

服务端是正式存档来源，换浏览器也可读取正式保存的作品。
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy.orm import Session

from .. import artifacts as A
from ..models import Artifact, ArtifactKind, ArtifactStatus, Project, Template
from ..storage import StorageError, new_output_dir, resolve_project_path, validate_ref, write_new
from .document import DocumentError, SCHEMA_VERSION, build_from_project
from .legacy import LegacyConversionError, convert_legacy_doc
from .render import RenderError, render_png
from .templates import geometry_for

EDITOR_DOC_KIND = ArtifactKind.EDITOR_DOC.value


class DocumentNotFound(DocumentError):
    """该页还没有任何可编辑文档。"""


class VersionConflict(DocumentError):
    """保存基准过期：别人（或另一窗口）已写入更新版本。

    ``current_version`` 是服务端当前版本；调用方据此决定“载入最新”还是“强制覆盖”。
    """

    def __init__(self, message: str, *, current_version: int, current_artifact_id: int | None = None):
        super().__init__(message)
        self.current_version = current_version
        self.current_artifact_id = current_artifact_id


def current_doc(session: Session, project_id: int, page_ref: str):
    return A.current(session, project_id, EDITOR_DOC_KIND, page_ref)


def load_for_edit(session: Session, project_id: int, page_ref: str) -> tuple[dict, dict]:
    """返回 (document, meta)。

    ``meta`` 说明来源与可继续编辑的程度，前端据此提示用户。
    """
    validate_ref(page_ref, "page")
    project = session.get(Project, project_id)
    if project is None:
        raise DocumentNotFound("项目不存在")

    saved = current_doc(session, project_id, page_ref)
    if saved is not None:
        payload = saved.payload or {}
        document = payload.get("document")
        if isinstance(document, dict):
            return document, {
                "source": "editor_doc",
                "version": saved.version,
                "artifact_id": saved.id,
                "page_image_id": payload.get("page_image_id"),
                "png_url": f"/api/artifacts/{saved.id}/file" if saved.path else "",
            }

    page_script = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    template_id = ((page_script.payload or {}).get("template_id") if page_script else "") or ""
    # 旧存档优先于重新生成的版式，避免已有手工文字和构图消失。
    legacy = A.current(session, project_id, ArtifactKind.MED_DOC.value, page_ref)
    if legacy is not None:
        raw = (legacy.payload or {}).get("doc")
        try:
            document = convert_legacy_doc(raw, page_ref=page_ref, template_id=template_id)
        except LegacyConversionError as exc:
            raise DocumentNotFound(f"旧存档无法转换：{exc}") from exc
        return document, {
            "source": "legacy_med_doc",
            # version 必须是“editor_doc 的当前版本”：这里还没有 editor_doc，
            # 必须报 0，否则前端把旧存档版本当保存基准，第一次保存就会撞 409。
            "version": 0,
            "legacy_version": legacy.version,
            "artifact_id": legacy.id,
            "page_image_id": None,
            "png_url": f"/api/artifacts/{legacy.id}/file" if legacy.path else "",
            "template_id": template_id,
            "conversion": document.get("conversion"),
        }
    if page_script is not None:
        try:
            document = build_from_project(session, project_id, page_ref, page_script=page_script)
            return document, {
                "source": "generated",
                "version": 0,
                "artifact_id": None,
                "page_image_id": None,
                "png_url": "",
                "template_id": template_id,
            }
        except DocumentError as exc:
            # 版式可用但缺图时仍应让用户打开编辑器（缺图格子留空）
            raise DocumentNotFound(str(exc)) from exc

    raise DocumentNotFound("该页还没有分格脚本，无法编辑")


def image_lookup_for(session: Session, project_id: int):
    """渲染用：画框 → 已采用候选图的本地路径。

    内嵌 dataURL 由渲染器直接处理；这里优先解析文档固定的产物与候选编号，
    只有旧格式没有版本引用时才按 ``panelRef`` 回退到当前已采用图片。
    """

    def lookup(panel: dict) -> str | None:
        ref = panel.get("panelRef")
        if not ref:
            return None
        spec = panel.get("image")
        if not isinstance(spec, dict):
            return None  # 用户主动移除了图片，不得重新填回当前采用图。
        if spec.get("artifactId") is not None:
            artifact = session.get(Artifact, spec["artifactId"])
            if (artifact is None or artifact.project_id != project_id
                    or artifact.kind != ArtifactKind.IMAGE.value or artifact.ref != ref):
                raise RenderError(f"{ref} 的图片版本不属于当前项目和漫画格")
            index = spec.get("candidateIndex")
        else:
            artifact = A.current(session, project_id, ArtifactKind.IMAGE.value, ref)
            if artifact is None:
                return None
            index = (artifact.payload or {}).get("selected_index")
        payload = artifact.payload or {}
        candidates = payload.get("candidates") or []
        if type(index) is not int or not 0 <= index < len(candidates):
            raise RenderError(f"{ref} 的候选图编号不可用")
        try:
            return str(resolve_project_path(candidates[index]["path"], project_id))
        except (StorageError, OSError, KeyError, TypeError) as exc:
            raise RenderError(f"{ref} 的图片文件不可用") from exc

    return lookup


def _decode_data_url(value: str) -> bytes | None:
    import base64
    import binascii

    if not isinstance(value, str) or not value.startswith("data:"):
        return None
    _, _, payload = value.partition(",")
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None


def save(
    session: Session,
    project_id: int,
    page_ref: str,
    document: dict,
    *,
    preview_png: str | None = None,
    scale: float = 1.0,
    base_version: int | None = None,
) -> dict:
    """保存编辑文档：写新版本 + 渲染整页 PNG 作为 ``page_image``。

    - ``preview_png`` 若是 dataURL，用客户端渲染的像素（所见即所得）；
    - 否则服务端按文档渲染（与后台 S5 同一套代码）；
    - ``base_version`` 是客户端打开/上次保存时看到的文档版本。带上它做并发检查：
      两个窗口同时编辑同一页时，较旧的窗口会收到 ``VersionConflict``，
      而不是静默覆盖别人的修改。显式传 ``None`` 表示跳过检查（后台任务、
      或用户在前端确认过“仍要覆盖”之后重试）。
    """
    validate_ref(page_ref, "page")
    if session.get(Project, project_id) is None:
        raise DocumentError("项目不存在")
    if not isinstance(document, dict):
        raise DocumentError("document 必须是对象")
    if int(document.get("schemaVersion") or 0) != SCHEMA_VERSION:
        raise DocumentError(f"不支持的文档版本：{document.get('schemaVersion')}")

    width = float(document.get("width") or 0)
    height = float(document.get("height") or 0)
    if width <= 0 or height <= 0:
        raise DocumentError("文档缺少有效画布尺寸")

    current = current_doc(session, project_id, page_ref)
    if base_version is not None:
        current_version = current.version if current is not None else 0
        if int(base_version) != current_version:
            raise VersionConflict(
                f"该页已被其他窗口保存为 v{current_version}（本窗口基于 v{base_version}）",
                current_version=current_version,
                current_artifact_id=current.id if current is not None else None,
            )

    upstream = []
    page_script = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if page_script is not None:
        upstream.append(page_script)
    panel_prefix = f"panel:{page_ref.split(':', 1)[1]}."
    upstream.extend(
        artifact for artifact in A.all_current(session, project_id, ArtifactKind.IMAGE.value)
        if artifact.ref.startswith(panel_prefix)
    )

    # 保存构图引用的实际图片版本，而不是把后来采用的新版本记成它的来源。
    for panel in document.get("panels") or []:
        spec = panel.get("image") or {}
        if spec.get("artifactId") is not None:
            image = session.get(Artifact, spec["artifactId"])
            if (image is None or image.project_id != project_id or image.kind != "image"
                    or image.ref != panel.get("panelRef")):
                raise DocumentError("图片版本不属于当前项目和漫画格")
            if image not in upstream:
                upstream.append(image)
    if document.get("conversion"):
        legacy = A.current(session, project_id, ArtifactKind.MED_DOC.value, page_ref)
        if legacy is not None:
            upstream.append(legacy)

    # 1) 画布存档（新版本，旧版保留可回退）
    stored = {**document}
    artifact = A.create(
        session,
        project_id=project_id,
        kind=EDITOR_DOC_KIND,
        ref=page_ref,
        payload={"document": stored},
        path="",
        inputs=upstream,
        status=ArtifactStatus.REVIEW.value,
    )

    # 2) 整页快照 → page_image，供审核、总览与成册导出
    png_bytes = _decode_data_url(preview_png) if preview_png else None
    warnings: list[str] = []
    if png_bytes is None:
        try:
            png_bytes = render_png(document, scale=scale, image_lookup=image_lookup_for(session, project_id))
        except RenderError as exc:
            warnings.append(f"整页快照渲染失败：{exc}")
            png_bytes = None

    page_image = None
    preview_path = ""
    if png_bytes:
        try:
            out_dir = new_output_dir(project_id, "pages", ref=page_ref)
            preview_path = str(out_dir / f"{page_ref.replace(':', '_')}.png")
            write_new(Path(preview_path), png_bytes)
        except (StorageError, OSError) as exc:
            warnings.append(f"整页快照落盘失败：{exc}")
            preview_path = ""

    if preview_path:
        page_image = A.create(
            session,
            project_id=project_id,
            kind=ArtifactKind.PAGE_IMAGE.value,
            ref=page_ref,
            payload={"source": "editor_doc", "editor_doc_id": artifact.id},
            path=preview_path,
            status=ArtifactStatus.REVIEW.value,
            inputs=[artifact],
        )
        artifact.payload = {
            "document": stored,
            "page_image_id": page_image.id,
        }

    session.commit()
    return {
        "ok": True,
        "artifact_id": artifact.id,
        "version": artifact.version,
        "has_preview": bool(page_image),
        "page_image_id": page_image.id if page_image else None,
        "png_url": f"/api/artifacts/{page_image.id}/file" if page_image else "",
        "warnings": warnings,
    }


def history(session: Session, project_id: int, page_ref: str) -> list[dict]:
    validate_ref(page_ref, "page")
    rows = A.versions_of(session, project_id, EDITOR_DOC_KIND, page_ref)
    return [
        {
            "artifact_id": row.id,
            "version": row.version,
            "status": row.status,
            "is_current": row.is_current,
            "created_at": row.created_at.isoformat() if row.created_at else "",
            "png_url": f"/api/artifacts/{row.id}/file" if row.path else "",
        }
        for row in rows
    ]
