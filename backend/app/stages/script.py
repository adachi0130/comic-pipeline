"""S2 分页分格（原 S3）。

输入不再是「场 + 页预算」，而是**已通过的小说全文**（S1 产出）。因为取消了结构规划，
本阶段让模型自己把小说切成页面：给定小说文本 + 目标页数 + 模板菜单 + 技法库，
分批产出页脚本，每页含所选模板与足量分格。

分批是为了控制单次输出长度：默认每批 4 页，多次调用累加。
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..artifacts import all_current, create, set_status
from ..llm import LLMClient, LLMLogContext
from ..models import ArtifactKind, ArtifactStatus, Job, Project, Technique, Template
from ..schemas import Storyboard
from . import promptlib, prose

KIND = "script"


def _template_menu(session: Session) -> str:
    rows = session.scalars(select(Template).order_by(Template.dir, Template.panels_count)).all()
    return json.dumps(
        [{"id": t.id, "dir": t.dir, "panels": t.panels_count, "desc": t.layout_desc} for t in rows],
        ensure_ascii=False,
    )


def _techniques(session: Session) -> str:
    rows = session.scalars(select(Technique).where(Technique.enabled.is_(True))).all()
    return json.dumps({t.name: t.prompt_block for t in rows}, ensure_ascii=False)


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    novel = prose.novel_text(session, project_id, only_approved=True)
    if not novel.strip():
        raise ValueError("前置条件未满足：还没有「已审核通过」的正文。请到「正文」页写并点「通过」。")

    # 已产出的页（避免重复）
    existing = {a.ref for a in all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value)}
    target = project.target_pages
    batch = max(1, int(payload.get("batch_pages") or 4))

    provider, cfg = promptlib.resolve_provider(session, "S2")
    client = LLMClient(cfg)
    system, user_tpl = promptlib.get_prompt(session, "s2_script")
    menu = _template_menu(session)
    techs = _techniques(session)

    log = LLMLogContext(session=session, stage="S2", project_id=project_id, provider_id=provider.id)
    produced: list[dict] = []
    start = 1
    while start <= target:
        end = min(start + batch - 1, target)
        user = promptlib.render(
            user_tpl,
            {
                "NOVEL": novel,
                "START_PAGE": start,
                "END_PAGE": end,
                "TOTAL_PAGES": target,
                "TEMPLATE_MENU": menu,
                "TECHNIQUES": techs,
            },
        )
        board: Storyboard = client.structured(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            Storyboard,
            log=log,
        )
        for page in board.pages:
            tpl = session.get(Template, page.template_id)
            if tpl is None:
                raise ValueError(f"模型选了不存在的模板：{page.template_id}")
            if len(page.panels) != tpl.panels_count:
                raise ValueError(
                    f"模板 {tpl.id} 需 {tpl.panels_count} 格，模型给了 {len(page.panels)} 格"
                )
            ref = f"page:{page.page_index}"
            if ref in existing:
                continue
            art = create(
                session,
                project_id=project_id,
                kind=ArtifactKind.PAGE_SCRIPT.value,
                ref=ref,
                payload={**page.model_dump(), "geometry": tpl.geometry},
                status=ArtifactStatus.REVIEW.value,
            )
            if project.review_mode == "auto":
                set_status(session, art, ArtifactStatus.APPROVED.value)
            produced.append({"page": page.page_index, "template": tpl.id, "panels": tpl.panels_count})
        session.commit()
        start = end + 1

    return {"pages": produced}
