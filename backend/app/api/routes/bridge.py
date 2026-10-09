"""酒馆扩展桥接口（S1 正文）。

流程：后端入队一条 prose 任务（写模式/续写提示）→ 酒馆页面里的 comic-bridge 扩展
轮询领取 → 酒馆原生生成（完整走角色卡 + 世界书 + 预设 + Prompt Manager）→
扩展把新段落回传 → 追加为新的正文分段产物，置「待审」。

支持两种模式：
- ``start``：开始写（把引导词作为用户消息发给酒馆）
- ``continue``：续写（把续写提示 + 已有小说尾部上下文发给酒馆，接着往下写）

前提：生成期间酒馆标签页保持打开；CORS 已放行酒馆 origin（见 main.py）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...db import get_session
from ...models import ArtifactKind, Job, JobStatus, Project
from ...stages import prose

router = APIRouter(tags=["bridge"])

KIND = prose.KIND  # "prose"


@router.post("/projects/{project_id}/prose/request")
def request_prose(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """请求酒馆生成一段正文。

    body: {"mode": "start"|"continue", "instruction": "..."}
    - start：用大纲/指令开始写第一段
    - continue：在已有小说后面接着写（自动带上尾部上下文）
    """
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")

    mode = body.get("mode", "start")
    if mode not in ("start", "continue"):
        raise HTTPException(400, "mode 必须是 start 或 continue")

    segments = prose.segments(session, project_id)
    if mode == "continue" and not segments:
        raise HTTPException(400, "还没有任何正文，无法续写；请先用 start 模式写第一段")

    # 续写时禁止在“有未通过分段”的情况下继续，避免把未审核内容接上去
    if mode == "continue" and not all(s.status == "approved" for s in segments):
        raise HTTPException(400, "仍有未审核的分段，请先审核通过再续写")

    tail = ""
    if mode == "continue":
        full = prose.novel_text(session, project_id)
        tail = full[-1200:] if len(full) > 1200 else full

    job = jobq.enqueue_deferred(
        KIND,
        project_id=project_id,
        stage="S1",
        payload={
            "project_id": project_id,
            "mode": mode,
            "instruction": body.get("instruction", ""),
            "context_tail": tail,
        },
    )
    return {"job_id": job.id, "status": job.status, "mode": mode}


@router.get("/bridge/tasks/claim")
def claim(session: Session = Depends(get_session)) -> dict:
    """扩展领取一个待办正文任务；没有则返回空。"""
    job = session.scalars(
        select(Job)
        .where(Job.kind == KIND, Job.status == JobStatus.QUEUED.value)
        .order_by(Job.id)
        .limit(1)
    ).first()
    if job is None:
        return {"task": None}

    project = session.get(Project, job.project_id) if job.project_id else None
    job.status = JobStatus.RUNNING.value
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    return {
        "task": {
            "job_id": job.id,
            "project_id": job.project_id,
            "mode": (job.payload or {}).get("mode", "start"),
            "instruction": (job.payload or {}).get("instruction", ""),
            "context_tail": (job.payload or {}).get("context_tail", ""),
            "outline": (project.outline if project else "") or "",
            "tavern_binding": (project.tavern_binding if project else {}) or {},
        }
    }


@router.post("/bridge/result")
def result(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展回传生成结果。body: {job_id, text}"""
    job_id = body.get("job_id")
    text = (body.get("text") or "").strip()
    job = session.get(Job, int(job_id)) if job_id else None
    if job is None:
        raise HTTPException(404, "作业不存在")

    project = session.get(Project, job.project_id) if job.project_id else None
    auto = bool(project and project.review_mode == "auto")
    art = prose.append_segment(
        session,
        project_id=job.project_id,
        text=text,
        mode=(job.payload or {}).get("mode", "start"),
        instruction=(job.payload or {}).get("instruction", ""),
        status="approved" if auto else "review",
    )

    job.status = JobStatus.DONE.value
    job.result = {"artifact_id": art.id, "ref": art.ref, "chars": len(text)}
    job.finished_at = datetime.now(timezone.utc)
    session.commit()
    return {"ok": True, "artifact_id": art.id, "ref": art.ref, "chars": len(text)}


@router.get("/projects/{project_id}/novel")
def novel(project_id: int, session: Session = Depends(get_session)) -> dict:
    """小说状态：全文 + 分段 + 能否续写。供前端「正文」页展示与审核。"""
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    return prose.novel_state(session, project_id)


@router.get("/projects/{project_id}/novel/approved")
def novel_approved(project_id: int, session: Session = Depends(get_session)) -> dict:
    """只含已通过分段的小说全文（展示用）。"""
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    return {"text": prose.novel_text(session, project_id, only_approved=True)}
