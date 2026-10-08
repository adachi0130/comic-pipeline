"""持久作业队列。

LLM 与出图动辄几十秒到几分钟，绝不能塞在 HTTP 请求里同步跑。这里用 APScheduler
的线程池后台执行，状态落 ``jobs`` 表，前端通过 SSE 看进度，支持取消与重试。

新增一种作业：写一个处理函数并 ``register(kind, fn)``；处理函数签名
``fn(session: Session, job: Job) -> dict``（返回值写入 ``job.result``）。
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Callable

from apscheduler.executors.pool import ThreadPoolExecutor as ApsThreadPool
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Job, JobStatus, utcnow

log = logging.getLogger("comic.jobs")

Handler = Callable[[Session, Job], dict]

_handlers: dict[str, Handler] = {}
_scheduler: BackgroundScheduler | None = None


def register(kind: str, fn: Handler) -> None:
    _handlers[kind] = fn


def get_handler(kind: str) -> Handler | None:
    return _handlers.get(kind)


def start(max_workers: int = 4) -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(
        executors={"default": ApsThreadPool(max_workers=max_workers)},
        job_defaults={"coalesce": True, "max_instances": 1},
    )
    _scheduler.start()
    log.info("作业队列已启动（workers=%s）", max_workers)


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


def enqueue(kind: str, *, project_id: int | None = None, stage: str = "", payload: dict | None = None) -> Job:
    """建一条作业记录并立刻丢给调度器执行。"""
    session = SessionLocal()
    try:
        job = Job(
            project_id=project_id,
            kind=kind,
            stage=stage,
            payload=payload or {},
            status=JobStatus.QUEUED.value,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    finally:
        session.close()

    if _scheduler is None:
        # 未启动调度器（如脚本内直接调用）：同步执行，方便调试与测试
        _run(job_id)
    else:
        _scheduler.add_job(_run, args=[job_id], id=f"job-{job_id}")
    return _get(job_id)


def _get(job_id: int) -> Job:
    session = SessionLocal()
    try:
        return session.get(Job, job_id)  # type: ignore[return-value]
    finally:
        session.close()


def _run(job_id: int) -> None:
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        if job is None:
            return
        if job.cancel_requested:
            job.status = JobStatus.CANCELLED.value
            job.finished_at = utcnow()
            session.commit()
            return

        handler = _handlers.get(job.kind)
        if handler is None:
            job.status = JobStatus.FAILED.value
            job.error = f"未注册的作业类型：{job.kind}"
            job.finished_at = utcnow()
            session.commit()
            return

        job.status = JobStatus.RUNNING.value
        job.started_at = utcnow()
        session.commit()

        try:
            result = handler(session, job) or {}
            session.refresh(job)
            if job.cancel_requested:
                job.status = JobStatus.CANCELLED.value
            else:
                job.status = JobStatus.DONE.value
            job.result = result
        except Exception as e:  # noqa: BLE001 - 作业失败需落库而非抛出
            session.rollback()
            job = session.get(Job, job_id)
            if job is not None:
                job.status = JobStatus.FAILED.value
                job.error = f"{e}\n{traceback.format_exc()[-2000:]}"
        finally:
            if job is not None:
                job.finished_at = utcnow()
                session.commit()
    finally:
        session.close()


def request_cancel(job_id: int) -> bool:
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        if job is None or job.status in (JobStatus.DONE.value, JobStatus.FAILED.value):
            return False
        job.cancel_requested = True
        session.commit()
        return True
    finally:
        session.close()
