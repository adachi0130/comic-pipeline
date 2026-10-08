"""S3 漫画脚本：逐页选模板 + 分格。

作业 payload: {"project_id": 1, "scene_id": 1}
前置：S1 STRUCTURE 产物已通过；该场正文（S2 PROSE 产物）已存在。

说明：M1 阶段先按“整场一次性产出各页”的简化策略；每页都要选一个模板，
且 panels 条数 == 该模板格数。下游（S4/S5/S6）以 page:{k} / panel:{k}.{n} 为稳定 ref。
"""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from ..artifacts import create, current, set_status
from ..llm import LLMClient, LLMLogContext
from ..models import ArtifactKind, ArtifactStatus, Job, Project, Template, Technique
from ..schemas import PageScript
from sqlalchemy import select

from . import promptlib

KIND = "s3_script"


def _template_menu(session: Session) -> str:
    rows = session.scalars(select(Template).order_by(Template.dir, Template.panels_count)).all()
    menu = [{"id": t.id, "dir": t.dir, "panels": t.panels_count, "desc": t.layout_desc} for t in rows]
    return json.dumps(menu, ensure_ascii=False)


def _techniques(session: Session) -> str:
    rows = session.scalars(select(Technique).where(Technique.enabled.is_(True))).all()
    data = {t.name: t.prompt_block for t in rows}
    return json.dumps(data, ensure_ascii=False)


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    scene_id = payload.get("scene_id")
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    structure_art = current(session, project_id, ArtifactKind.STRUCTURE.value, "book")
    if structure_art is None:
        raise ValueError("尚未完成 S1 结构规划")
    prose_art = None
    if scene_id is not None:
        prose_art = current(session, project_id, ArtifactKind.PROSE.value, f"scene:{scene_id}")
    prose_text = (prose_art.payload.get("text") if prose_art else "") or project.outline

    provider, cfg = promptlib.resolve_provider(session, "S3")
    client = LLMClient(cfg)
    system, user_tpl = promptlib.load_prompt("s3_script")

    menu = _template_menu(session)
    techs = _techniques(session)
    # 该场页预算：优先用入参，其次从 S1 结构里按 scene_id 找
    scene_budget = int(payload.get("page_budget") or 0)
    if not scene_budget:
        for ch in structure_art.payload.get("chapters", []):
            for sc in ch.get("scenes", []):
                if sc.get("id") == scene_id or str(sc.get("idx", "")) == str(scene_id):
                    scene_budget = int(sc.get("page_budget") or 0)
                    break
        scene_budget = scene_budget or 1

    log = LLMLogContext(session=session, stage="S3", project_id=project_id, provider_id=provider.id)
    produced = []
    page_cursor = int(payload.get("start_page_index") or 1)

    for k in range(1, int(scene_budget) + 1):
        user = promptlib.render(
            user_tpl,
            {
                "PAGE_INDEX": page_cursor,
                "TOTAL_PAGES": project.target_pages,
                "SCENE_PAGE_BUDGET": scene_budget,
                "SCENE_PAGE_INDEX": k,
                "PREV_PAGE_TAIL": "",
                "PROSE_SLICE": prose_text,
                "TEMPLATE_MENU": menu,
                "TECHNIQUES": techs,
            },
        )
        page_script: PageScript = client.structured(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            PageScript,
            log=log,
        )
        # 校验：panels 条数必须等于所选模板格数
        tpl = session.get(Template, page_script.template_id)
        if tpl is None:
            raise ValueError(f"模型选了不存在的模板：{page_script.template_id}")
        if len(page_script.panels) != tpl.panels_count:
            raise ValueError(
                f"模板 {tpl.id} 需 {tpl.panels_count} 格，模型给了 {len(page_script.panels)} 格"
            )

        ref = f"page:{page_cursor}"
        inputs = [a for a in (structure_art, prose_art) if a is not None]
        art = create(
            session,
            project_id=project_id,
            kind=ArtifactKind.PAGE_SCRIPT.value,
            ref=ref,
            payload={**page_script.model_dump(), "geometry": tpl.geometry},
            inputs=inputs,
            status=ArtifactStatus.REVIEW.value,
        )
        if project.review_mode == "auto":
            set_status(session, art, ArtifactStatus.APPROVED.value)
        produced.append({"page": page_cursor, "template": tpl.id, "panels": tpl.panels_count})
        page_cursor += 1

    session.commit()
    return {"pages": produced}
