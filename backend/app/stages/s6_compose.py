"""S6 分页合成：把一格格的成图按模板拼成一页漫画。

作业 payload: {"project_id": 1, "page_ref": "page:3"}
前置：该页 PAGE_SCRIPT 产物存在；该页每格 IMAGE 产物已选定成图。

产出：``PAGE_IMAGE`` 产物（ref="page:3"），path 指向导出的整页 PNG。
驱动方式：走 ``PageComposer`` 抽象（当前实现是 Manga Editor Desu，经同源 iframe + 桥）。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from ..artifacts import create, current, set_status
from ..config import get_settings
from ..models import ArtifactKind, ArtifactStatus, Job, Project, Template
from . import select as select_mod

KIND = "s6_compose"


def _base_url() -> str:
    # 后端自身地址：MED 由本服务托管在 /editor/
    return "http://127.0.0.1:8770"


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    page_ref = str(payload.get("page_ref") or "")
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

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

    from ..med.base import PanelArt, ToneOp
    from ..med.composer import MedComposer, _decode_dataurl

    for panel in (page_art.payload or {}).get("panels", []):
        order = int(panel["panel_order"])
        pref = f"panel:{page_no}.{order}"
        prompt_art = current(session, project_id, ArtifactKind.PANEL_PROMPT.value, pref)
        prompts.append((prompt_art.payload.get("prompt_pos") if prompt_art else "") or "")
        img_art = current(session, project_id, ArtifactKind.IMAGE.value, pref)
        if img_art:
            idx = (img_art.payload or {}).get("selected_index")
            cands = (img_art.payload or {}).get("candidates") or []
            if idx is None:
                idx = select_mod.select_index(cands, project.select_strategy)
            if idx is not None and 0 <= idx < len(cands):
                arts.append(PanelArt(order=order, image_path=cands[idx]["path"], prompt=prompts[-1]))

    # 技法叠加（集中线/运动线等由 MED 生成器尽力而为）
    tones: list[ToneOp] = []
    for panel in (page_art.payload or {}).get("panels", []):
        for name in panel.get("technique", []) or []:
            if name == "集中线":
                tones.append(ToneOp(kind="focus", panel_order=int(panel["panel_order"])))
            elif name == "运动线":
                tones.append(ToneOp(kind="speed", panel_order=int(panel["panel_order"])))

    composer = MedComposer(_base_url())
    composer.open()
    try:
        result, png_bytes = composer.compose(  # type: ignore[misc]
            template_svg=svg,
            is_landscape=tpl.dir == "landscape",
            prompts=prompts,
            arts=arts,
            tones=tones,
            right_to_left=True,
            multiplier=1,
        )
    finally:
        composer.close()

    if not result.ok:
        raise RuntimeError(f"分页合成失败：{result.error}")

    out_dir = get_settings().data_dir / "projects" / str(project_id) / "pages"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{page_ref.replace(':', '_')}.png"
    out_path.write_bytes(png_bytes)

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
        },
        path=str(out_path),
        inputs=[page_art],
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto":
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()
    return {"page_ref": page_ref, "png": str(out_path), "placed": result.placed, "warnings": result.warnings}
