"""作业接口：列表、详情、取消、SSE 进度流。"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...db import SessionLocal, get_session
from ...models import Job

router = APIRouter(tags=["jobs"])


@router.get("/jobs")
def list_jobs(
    project_id: int | None = None,
    status: str | None = None,
    limit: int = 100,
    session: Session = Depends(get_session),
) -> list[dict]:
    stmt = select(Job).order_by(Job.id.desc()).limit(limit)
    if project_id is not None:
        stmt = stmt.where(Job.project_id == project_id)
    if status:
        stmt = stmt.where(Job.status == status)
    return [_brief(j) for j in session.scalars(stmt).all()]


@router.get("/jobs/events")
async def events(project_id: int | None = None) -> StreamingResponse:
    """SSE：每 1 秒推送一次活跃作业状态。

    注意：此路由必须声明在 ``/jobs/{job_id}`` **之前**，否则会被后者吞掉
    （job_id="events" 无法解析为 int → 422）。
    """

    async def gen():
        last_snapshot = ""
        while True:
            session = SessionLocal()
            try:
                stmt = select(Job).order_by(Job.id.desc()).limit(50)
                if project_id is not None:
                    stmt = stmt.where(Job.project_id == project_id)
                rows = session.scalars(stmt).all()
                snapshot = json.dumps([_brief(j) for j in rows], ensure_ascii=False)
            finally:
                session.close()
            if snapshot != last_snapshot:
                last_snapshot = snapshot
                yield f"data: {snapshot}\n\n"
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/jobs/{job_id}")
def get_job(job_id: int, session: Session = Depends(get_session)) -> dict:
    j = session.get(Job, job_id)
    if j is None:
        raise HTTPException(404, "作业不存在")
    return _full(j)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int) -> dict:
    ok = jobq.request_cancel(job_id)
    return {"ok": ok}


def _brief(j: Job) -> dict:
    payload = j.payload if isinstance(j.payload, dict) else {}
    return {
        "id": j.id,
        "kind": j.kind,
        "project_id": j.project_id,
        "stage": j.stage,
        "ref": payload.get("panel_ref") or payload.get("page_ref") or "",
        "status": j.status,
        "progress": j.progress,
        "total": j.total,
        "message": j.message,
        "error": j.error.splitlines()[0] if j.error else "",
        "cancel_requested": j.cancel_requested,
    }


def _full(j: Job) -> dict:
    return {
        **_brief(j),
        "project_id": j.project_id,
        "payload": j.payload,
        "result": j.result,
        "error": j.error,
        "cancel_requested": j.cancel_requested,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }
