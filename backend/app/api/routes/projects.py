"""项目接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_session
from ...models import Project
from ...schemas import ProjectCreate

router = APIRouter(tags=["projects"])


@router.get("/projects")
def list_projects(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.scalars(select(Project).order_by(Project.id.desc())).all()
    return [_brief(p) for p in rows]


@router.post("/projects")
def create_project(body: ProjectCreate, session: Session = Depends(get_session)) -> dict:
    s = get_settings()
    p = Project(
        title=body.title,
        outline=body.outline,
        target_pages=body.target_pages,
        review_mode=body.review_mode,
        select_strategy=s.default_select_strategy,
        candidates_per_panel=s.default_candidates_per_panel,
        page_spec=s.page_spec.model_dump(),
        style_config={},
        gen_params={},
        tavern_binding={},
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return _full(p)


@router.get("/projects/{project_id}")
def get_project(project_id: int, session: Session = Depends(get_session)) -> dict:
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    return _full(p)


@router.patch("/projects/{project_id}")
def update_project(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    for field in (
        "title", "outline", "target_pages", "review_mode", "select_strategy",
        "candidates_per_panel", "style_config", "gen_params", "tavern_binding", "page_spec",
    ):
        if field in body and body[field] is not None:
            setattr(p, field, body[field])
    session.commit()
    session.refresh(p)
    return _full(p)


def _brief(p: Project) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "target_pages": p.target_pages,
        "review_mode": p.review_mode,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


def _full(p: Project) -> dict:
    return {
        **_brief(p),
        "outline": p.outline,
        "style_config": p.style_config,
        "page_spec": p.page_spec,
        "select_strategy": p.select_strategy,
        "candidates_per_panel": p.candidates_per_panel,
        "gen_params": p.gen_params,
        "tavern_binding": p.tavern_binding,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
