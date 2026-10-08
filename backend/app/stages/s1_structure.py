"""S1 结构规划：大纲 + 目标页数 → 章/场结构（页预算加总 == 目标页数）。

作业 payload: {"project_id": 1}
产出：``STRUCTURE`` 产物（ref="book"），payload 为题面 Structure 的 dict。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..artifacts import create, set_status
from ..llm import LLMClient, LLMLogContext
from ..models import ArtifactKind, ArtifactStatus, Job, Project
from ..schemas import Structure
from . import promptlib

KIND = "s1_structure"


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")
    if not project.outline.strip():
        raise ValueError("项目大纲为空，无法规划结构")

    provider, cfg = promptlib.resolve_provider(session, "S1")
    client = LLMClient(cfg)
    system, user_tpl = promptlib.load_prompt("s1_structure")
    user = promptlib.render(
        user_tpl,
        {"TARGET_PAGES": project.target_pages, "OUTLINE": project.outline},
    )

    log = LLMLogContext(session=session, stage="S1", project_id=project_id, provider_id=provider.id)
    structure: Structure = client.structured(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        Structure,
        log=log,
    )

    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.STRUCTURE.value,
        ref="book",
        payload=structure.model_dump(),
        status=ArtifactStatus.REVIEW.value,
    )
    # 自动模式直接通过
    if project.review_mode == "auto":
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()

    scenes = sum(len(c.scenes) for c in structure.chapters)
    return {"chapters": len(structure.chapters), "scenes": scenes, "target_pages": structure.target_pages}
