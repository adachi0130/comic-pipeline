"""元信息接口：健康、页面规格、模板菜单、技法库、审查模式。"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_session
from ...models import Technique, Template

router = APIRouter(tags=["meta"])


@router.get("/meta")
def meta(session: Session = Depends(get_session)) -> dict:
    s = get_settings()
    templates = list(session.scalars(select(Template).order_by(Template.dir, Template.panels_count)))
    techniques = list(session.scalars(select(Technique).where(Technique.enabled.is_(True))))
    return {
        "app": s.app_name,
        "page_spec": s.page_spec.model_dump(),
        "defaults": {
            "target_pages": s.default_target_pages,
            "candidates_per_panel": s.default_candidates_per_panel,
            "max_candidates_per_panel": s.max_candidates_per_panel,
            "review_mode": s.default_review_mode,
            "select_strategy": s.default_select_strategy,
        },
        "templates": [
            {
                "id": t.id,
                "dir": t.dir,
                "panels_count": t.panels_count,
                "layout_desc": t.layout_desc,
            }
            for t in templates
        ],
        "techniques": [
            {
                "id": t.id,
                "name": t.name,
                "stage": t.stage,
                "render_mode": t.render_mode,
                "prompt_block": t.prompt_block,
            }
            for t in techniques
        ],
    }


@router.get("/templates/{template_id}")
def template_detail(template_id: str, session: Session = Depends(get_session)) -> dict:
    t = session.get(Template, template_id)
    if t is None:
        return {"error": f"模板不存在：{template_id}"}
    svg = ""
    if t.svg_path:
        from pathlib import Path

        p = Path(t.svg_path)
        if p.exists():
            svg = p.read_text(encoding="utf-8")
    return {
        "id": t.id,
        "dir": t.dir,
        "panels_count": t.panels_count,
        "layout_desc": t.layout_desc,
        "geometry": t.geometry,
        "svg": svg,
    }
