"""酒馆扩展桥接口（S2 正文）。

消息流向：
1. 后端入队一条 ``s2_prose`` 作业（写引导词/场信息）；
2. 酒馆页面里的 comic-bridge 扩展轮询 ``GET /api/bridge/tasks/claim`` 领取；
3. 扩展用酒馆原生管线生成正文（走角色卡 + 世界书 + 预设 + Prompt Manager）；
4. 扩展把新段落 ``POST /api/bridge/result`` 回传，落成 PROSE 产物并置「待审」。

前提：生成期间酒馆标签页保持打开；CORS 已放行酒馆 origin（见 main.py）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...artifacts import create, set_status
from ...db import get_session
from ...models import ArtifactKind, ArtifactStatus, Job, JobStatus, Project
from ...stages.s2_prose import KIND as S2_KIND

router = APIRouter(tags=["bridge"])


@router.post("/projects/{project_id}/prose/request")
def request_prose(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """请求扩展去酒馆生成某场正文。body: {scene_id, instruction?}"""
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    scene_id = body.get("scene_id")
    job = jobq.enqueue_deferred(
        S2_KIND,
        project_id=project_id,
        stage="S2",
        payload={
            "project_id": project_id,
            "scene_id": scene_id,
            "instruction": body.get("instruction", ""),
        },
    )
    return {"job_id": job.id, "status": job.status}


@router.get("/bridge/tasks/claim")
def claim(session: Session = Depends(get_session)) -> dict:
    """扩展领取一个待办 S2 任务；没有则返回空。"""
    job = session.scalars(
        select(Job)
        .where(Job.kind == S2_KIND, Job.status == JobStatus.QUEUED.value)
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
            "scene_id": (job.payload or {}).get("scene_id"),
            "instruction": (job.payload or {}).get("instruction", ""),
            # 供扩展参考的酒馆绑定（角色卡/世界书/预设）
            "tavern_binding": (project.tavern_binding if project else {}) or {},
        }
    }


@router.post("/bridge/result")
def result(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展回传生成结果。body: {job_id, text, scene_id?}"""
    job_id = body.get("job_id")
    text = body.get("text", "")
    job = session.get(Job, int(job_id)) if job_id else None
    if job is None:
        raise HTTPException(404, "作业不存在")

    project_id = job.project_id
    scene_id = body.get("scene_id") or (job.payload or {}).get("scene_id")
    ref = f"scene:{scene_id}" if scene_id is not None else f"job:{job_id}"

    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.PROSE.value,
        ref=ref,
        payload={"text": text, "scene_id": scene_id, "source": "tavern-bridge"},
        status=ArtifactStatus.REVIEW.value,
    )
    project = session.get(Project, project_id) if project_id else None
    if project and project.review_mode == "auto":
        set_status(session, art, ArtifactStatus.APPROVED.value)

    job.status = JobStatus.DONE.value
    job.result = {"artifact_id": art.id, "ref": ref, "chars": len(text)}
    job.finished_at = datetime.now(timezone.utc)
    session.commit()
    return {"ok": True, "artifact_id": art.id, "ref": ref}
