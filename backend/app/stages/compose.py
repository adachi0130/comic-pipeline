"""S5 分页合成：把一格格的成图按模板拼成一页漫画。

payload: ``{"project_id", "page_ref": "page:1"}``
前置：该页分格脚本（S2 产物）存在；该页每格 IMAGE 产物已选定成图。
产出：``PAGE_IMAGE`` 产物（ref="page:1"），path 指向渲染出的整页 PNG。

驱动方式：**自研渲染核心**（``backend/app/comic``），不再启动 Manga Editor Desu。
几何来自模板 SVG 的真实多边形，图片来自已采用的候选图；默认只贴图不加装饰。
若该页存在已保存的编辑文档（``editor_doc``），则按文档渲染，把手工图层一并带上。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from .. import artifacts as A
from ..models import ArtifactKind, ArtifactStatus, Job, Project, Template
from ..storage import new_output_dir, resolve_project_path, validate_ref, write_new

KIND = "compose"


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    page_ref = str(payload.get("page_ref") or "")
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")
    validate_ref(page_ref, "page")

    page_art = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if page_art is None:
        raise ValueError(f"缺少分页脚本：{page_ref}")

    template_id = (page_art.payload or {}).get("template_id")
    tpl = session.get(Template, template_id)
    if tpl is None:
        raise ValueError(f"模板不存在：{template_id}")
    if not tpl.svg_path or not Path(tpl.svg_path).exists():
        raise ValueError(f"模板 SVG 缺失：{template_id}")

    panels = (page_art.payload or {}).get("panels") or []
    if not panels:
        raise ValueError(f"{page_ref} 没有分格，无法合成")
    orders = [int(panel["panel_order"]) for panel in panels]
    if sorted(orders) != list(range(1, len(panels) + 1)):
        raise ValueError(f"{page_ref} 的分格序号不连续或重复，无法安全贴图")

    from ..comic import documents as D
    from ..comic.document import DocumentError, build_from_project
    from ..comic.render import RenderError, render_png

    inputs = [page_art]
    page_no = page_ref.split(":", 1)[-1]
    for panel in panels:
        order = int(panel["panel_order"])
        pref = f"panel:{page_no}.{order}"
        prompt_art = A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, pref)
        img_art = A.current(session, project_id, ArtifactKind.IMAGE.value, pref)
        idx = (img_art.payload or {}).get("selected_index") if img_art else None
        cands = (img_art.payload or {}).get("candidates") or [] if img_art else []
        if not img_art or img_art.status != ArtifactStatus.APPROVED.value or type(idx) is not int or not 0 <= idx < len(cands):
            raise ValueError(f"{pref} 尚未采用可用图片，无法合成")
        try:
            resolve_project_path(cands[idx]["path"], project_id)
        except (OSError, KeyError, TypeError) as exc:
            raise ValueError(f"{pref} 的图片文件不可用：{exc}") from exc
        inputs.append(img_art)
        if prompt_art is not None:
            inputs.append(prompt_art)

    # 有已保存的编辑文档时按文档渲染（含手工图层）；否则用项目产物现场构建
    saved_doc = A.current(session, project_id, ArtifactKind.EDITOR_DOC.value, page_ref)
    document = None
    source = "generated"
    if saved_doc is not None:
        candidate = (saved_doc.payload or {}).get("document")
        if isinstance(candidate, dict):
            document = candidate
            source = "editor_doc"
            inputs.append(saved_doc)
    if document is None:
        try:
            document = build_from_project(session, project_id, page_ref, page_script=page_art)
        except DocumentError as exc:
            raise ValueError(f"{page_ref} 无法构建拼页文档：{exc}") from exc

    placed = sum(1 for panel in document.get("panels") or [] if panel.get("image") or panel.get("panelRef"))
    try:
        png_bytes = render_png(document, scale=1.0, image_lookup=D.image_lookup_for(session, project_id))
    except RenderError as exc:
        raise RuntimeError(f"分页渲染失败：{exc}") from exc

    from .. import jobs as jobq
    if job.id is not None and jobq.is_cancelled(job.id):
        return {"page_ref": page_ref, "cancelled": True}

    out_dir = new_output_dir(project_id, "pages", ref=page_ref)
    out_path = out_dir / f"{page_ref.replace(':', '_')}.png"
    write_new(out_path, png_bytes)

    art = A.create(
        session,
        project_id=project_id,
        kind=ArtifactKind.PAGE_IMAGE.value,
        ref=page_ref,
        payload={
            "template_id": template_id,
            "panels": len(document.get("panels") or []),
            "placed": placed,
            "renderer": "comic/render",
            "source": source,
            **({"editor_doc_id": saved_doc.id} if saved_doc is not None else {}),
            **({"auto_run": payload["auto_run"]} if "auto_run" in payload else {}),
        },
        path=str(out_path),
        inputs=inputs,
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto" or payload.get("auto_approve") is True:
        A.set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()
    return {
        "page_ref": page_ref,
        "png": str(out_path),
        "placed": placed,
        "panels": len(document.get("panels") or []),
        "warnings": [],
    }
