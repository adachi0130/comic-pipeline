"""S5 分页合成（原 S6）：把一格格的成图按模板拼成一页漫画。

payload: {"project_id", "page_ref": "page:1"}
前置：该页分格脚本（S2 产物）存在；该页每格 IMAGE 产物已选定成图。
产出：``PAGE_IMAGE`` 产物（ref="page:1"），path 指向导出的整页 PNG。
驱动方式：``PageComposer`` 抽象（当前实现是 Manga Editor Desu，经同源 iframe + 桥）。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from ..artifacts import create, current, set_status
from ..models import ArtifactKind, ArtifactStatus, Job, Project, Template
from ..storage import new_output_dir, resolve_project_path, validate_ref, write_new

KIND = "compose"


def _base_url() -> str:
    return "http://127.0.0.1:8770"


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    page_ref = str(payload.get("page_ref") or "")
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")
    validate_ref(page_ref, "page")

    page_art = current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if page_art is None:
        raise ValueError(f"缺少分页脚本：{page_ref}")

    template_id = (page_art.payload or {}).get("template_id")
    tpl = session.get(Template, template_id)
    if tpl is None:
        raise ValueError(f"模板不存在：{template_id}")

    svg = ""
    if tpl.svg_path and Path(tpl.svg_path).exists():
        svg = Path(tpl.svg_path).read_text(encoding="utf-8")
    if not svg:
        raise ValueError(f"模板 SVG 缺失：{template_id}")

    page_no = page_ref.split(":", 1)[-1]
    prompts: list[str] = []
    arts: list = []
    inputs = [page_art]

    from ..med.base import PanelArt
    from ..med.composer import MedComposer

    panels = (page_art.payload or {}).get("panels") or []
    if not panels:
        raise ValueError(f"{page_ref} 没有分格，无法合成")
    orders = [int(panel["panel_order"]) for panel in panels]
    if sorted(orders) != list(range(1, len(panels) + 1)):
        raise ValueError(f"{page_ref} 的分格序号不连续或重复，无法安全贴图")
    for panel in panels:
        order = int(panel["panel_order"])
        pref = f"panel:{page_no}.{order}"
        prompt_art = current(session, project_id, ArtifactKind.PANEL_PROMPT.value, pref)
        prompts.append((prompt_art.payload.get("prompt_pos") if prompt_art else "") or "")
        img_art = current(session, project_id, ArtifactKind.IMAGE.value, pref)
        idx = (img_art.payload or {}).get("selected_index") if img_art else None
        cands = (img_art.payload or {}).get("candidates") or [] if img_art else []
        if not img_art or img_art.status != ArtifactStatus.APPROVED.value or type(idx) is not int or not 0 <= idx < len(cands):
            raise ValueError(f"{pref} 尚未采用可用图片，无法合成")
        image_path = resolve_project_path(cands[idx]["path"], project_id)
        arts.append(PanelArt(order=order, image_path=str(image_path), prompt=prompts[-1]))
        inputs.append(img_art)
        if prompt_art is not None:
            inputs.append(prompt_art)

    composer = MedComposer(_base_url())
    try:
        composer.open()
        result, png_bytes = composer.compose(
            template_svg=svg,
            is_landscape=tpl.dir == "landscape",
            prompts=prompts,
            arts=arts,
            tones=[],
            right_to_left=True,
            multiplier=1,
        )
    finally:
        composer.close()

    if not result.ok:
        raise RuntimeError(f"分页合成失败：{result.error}")
    if result.panels != len(arts) or result.placed != len(arts):
        raise RuntimeError(f"分页合成未完成：分格 {len(arts)}，模板 {result.panels}，成功贴图 {result.placed}；请检查版式和图片后重试")

    from .. import jobs as jobq
    if job.id is not None and jobq.is_cancelled(job.id):
        return {"page_ref": page_ref, "cancelled": True}

    out_dir = new_output_dir(project_id, "pages", ref=page_ref)
    out_path = out_dir / f"{page_ref.replace(':', '_')}.png"
    write_new(out_path, png_bytes)

    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.PAGE_IMAGE.value,
        ref=page_ref,
        payload={
            "template_id": template_id,
            "panels": result.panels,
            "placed": result.placed,
            "warnings": result.warnings,
            **({"auto_run": payload["auto_run"]} if "auto_run" in payload else {}),
        },
        path=str(out_path),
        inputs=inputs,
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto" or payload.get("auto_approve") is True:
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()
    return {"page_ref": page_ref, "png": str(out_path), "placed": result.placed, "warnings": result.warnings}
