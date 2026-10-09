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
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...db import get_session
from ...models import ArtifactKind, Job, JobStatus, Project
from ...stages import prose

router = APIRouter(tags=["bridge"])

KIND = prose.KIND          # "prose"：正文生成任务
TAVERN_KIND = "tavern"     # "tavern"：酒馆操作任务（如切换对话）
# 扩展可领取的任务类型
CLAIMABLE = (KIND, TAVERN_KIND)


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
        # 续写上下文取已通过的正文（能续写说明已全部通过）
        full = prose.novel_text(session, project_id, only_approved=True)
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
    """扩展领取一个待办任务（正文生成 / 酒馆操作）；没有则返回空。"""
    job = session.scalars(
        select(Job)
        .where(Job.kind.in_(CLAIMABLE), Job.status == JobStatus.QUEUED.value)
        .order_by(Job.id)
        .limit(1)
    ).first()
    if job is None:
        return {"task": None}

    project = session.get(Project, job.project_id) if job.project_id else None
    job.status = JobStatus.RUNNING.value
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    payload = job.payload or {}
    task = {
        "job_id": job.id,
        "kind": job.kind,
        "project_id": job.project_id,
    }
    if job.kind == KIND:
        task.update({
            "mode": payload.get("mode", "start"),
            "instruction": payload.get("instruction", ""),
            "context_tail": payload.get("context_tail", ""),
            "outline": (project.outline if project else "") or "",
            "tavern_binding": (project.tavern_binding if project else {}) or {},
        })
    else:  # tavern 操作
        task.update({
            "action": payload.get("action", ""),
            "avatar": payload.get("avatar", ""),
            "file_name": payload.get("file_name", ""),
            "chat_name": payload.get("chat_name", ""),
        })
    return {"task": task}


@router.post("/tavern/switch")
def tavern_switch(body: dict, session: Session = Depends(get_session)) -> dict:
    """请求酒馆切换到指定对话（跨角色也可）。body: {avatar, file_name}"""
    avatar = (body.get("avatar") or "").strip()
    file_name = (body.get("file_name") or "").strip()
    if not file_name:
        raise HTTPException(400, "缺少 file_name")

    # 防重复：若已有同目标的排队/执行中任务，直接复用，避免桥重启后重复执行
    dup = session.scalars(
        select(Job).where(
            Job.kind == TAVERN_KIND,
            Job.status.in_((JobStatus.QUEUED.value, JobStatus.RUNNING.value)),
        )
    ).all()
    for j in dup:
        p = j.payload or {}
        if p.get("action") == "switch" and p.get("avatar") == avatar and p.get("file_name") == file_name:
            return {"job_id": j.id, "status": j.status, "deduped": True}

    job = jobq.enqueue_deferred(
        TAVERN_KIND,
        project_id=None,
        stage="TAVERN",
        payload={"action": "switch", "avatar": avatar, "file_name": file_name,
                 "chat_name": body.get("chat_name", "")},
    )
    return {"job_id": job.id, "status": job.status}


@router.get("/tavern/chats")
def tavern_chats(session: Session = Depends(get_session)) -> dict:
    """酒馆的对话列表（Recent Chats），按角色分组。"""
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    chats = ((row.payload or {}).get("chats") if row else None) or []
    # 按角色分组
    groups: dict[str, list[dict]] = {}
    for c in chats:
        groups.setdefault(c.get("char_name") or "(未知角色)", []).append(c)
    return {
        "available": row is not None,
        "total": len(chats),
        "groups": [{"character": k, "chats": v} for k, v in groups.items()],
    }


@router.post("/bridge/result")
def result(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展回传生成结果。body: {job_id, text, receipt?}"""
    job_id = body.get("job_id")
    text = (body.get("text") or "").strip()
    job = session.get(Job, int(job_id)) if job_id else None
    if job is None:
        raise HTTPException(404, "作业不存在")

    # 非正文任务（例如切换对话）或空文本：只更新作业状态，**不创建正文产物**。
    # 否则会出现 project_id 为空却要写 prose 的错误（曾经导致 500 循环）。
    if job.kind != KIND or not text or not job.project_id:
        job.status = JobStatus.DONE.value
        job.result = {"op": body.get("op", ""), "skipped": True}
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        return {"ok": True, "skipped": True}

    project = session.get(Project, job.project_id) if job.project_id else None
    auto = bool(project and project.review_mode == "auto")
    art = prose.append_segment(
        session,
        project_id=job.project_id,
        text=text,
        mode=(job.payload or {}).get("mode", "start"),
        instruction=(job.payload or {}).get("instruction", ""),
        status="approved" if auto else "review",
        receipt=body.get("receipt") or {},
    )

    job.status = JobStatus.DONE.value
    job.result = {"artifact_id": art.id, "ref": art.ref, "chars": len(text)}
    job.finished_at = datetime.now(timezone.utc)

    # 生成结束：把 live 标记为 done（前端收起“生成中”并出现分段供审核）
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    if row is not None:
        p = dict(row.payload or {})
        p["live"] = {"job_id": job.id, "text": text, "chars": len(text), "done": True, "error": "",
                     "updated_at": datetime.now(timezone.utc).isoformat()}
        row.payload = p
    session.commit()
    return {"ok": True, "artifact_id": art.id, "ref": art.ref, "chars": len(text)}


@router.post("/bridge/mirror")
def push_mirror(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展推送酒馆当前对话快照 + 生成依据。前端可见「你正用哪张卡/哪本世界书」。

    body: {"context": {...}, "messages": [...], "receipt": {...}}
    """
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    if row is None:
        row = TavernMirror(id=1, payload={})
        session.add(row)
    # 合并而不是整体替换：**保留 live 字段**（流式/失败状态）。
    # 之前这里是整体覆盖，导致 pushMirror（每 2.5s）把刚上报的失败信息冲掉，
    # 前端因此看不到任何错误——就是“没反应”的由来。
    payload = dict(row.payload or {})
    source = (body.get("source") or "tab").strip()
    now = datetime.now(timezone.utc)

    # “桥优先”：只要常驻桥在推（30s 内见过 source=bridge），就忽略普通标签页的推送。
    # 否则你手动打开的酒馆标签页会和桥两边互相覆盖，前端表现就是一直跳。
    last_bridge = payload.get("bridge_seen_at")
    if source == "bridge":
        payload["bridge_seen_at"] = now.isoformat()
    else:
        if last_bridge:
            try:
                seen = datetime.fromisoformat(last_bridge)
                if (now - seen).total_seconds() < 30:
                    return {"ok": True, "skipped": "bridge-active"}
            except ValueError:
                pass

    payload.update({
        "source": source,
        "context": body.get("context") or {},
        "messages": body.get("messages") or [],
        "receipt": body.get("receipt") or {},
        "chats": body.get("chats") or [],
    })
    row.payload = payload
    session.commit()
    return {
        "ok": True,
        "source": source,
        "messages": len(payload["messages"]),
        "chats": len(payload["chats"]),
        "live_preserved": bool(payload.get("live")),
    }


@router.post("/bridge/stream")
def bridge_stream(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展推送生成中的流式文本（未完成，仅用于前端实时显示）。

    body: {job_id, text, done?, error?}
    - text 是**累积**文本（酒馆的 STREAM_TOKEN_RECEIVED 给的就是累积值）
    - done=True 表示生成结束（成功或失败），前端据此收起“生成中”
    """
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    if row is None:
        row = TavernMirror(id=1, payload={})
        session.add(row)
    payload = dict(row.payload or {})
    payload["live"] = {
        "job_id": body.get("job_id"),
        "text": body.get("text") or "",
        "chars": len(body.get("text") or ""),
        "done": bool(body.get("done")),
        "error": body.get("error") or "",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    row.payload = payload
    session.commit()
    return {"ok": True}


@router.post("/tavern/live/clear")
def tavern_live_clear(session: Session = Depends(get_session)) -> dict:
    """清掉流式/失败状态（前端“关闭”失败提示，或新一次发送前调用）。"""
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    if row is not None:
        p = dict(row.payload or {})
        p["live"] = {}
        row.payload = p
        session.commit()
    return {"ok": True}


@router.get("/tavern/live")
def tavern_live(session: Session = Depends(get_session)) -> dict:
    """酒馆当前对话镜像（前端「酒馆对话」面板读取）。"""
    from ...models import TavernMirror

    row = session.get(TavernMirror, 1)
    if row is None:
        return {"available": False, "messages": [], "context": {}, "receipt": {}, "chats": [],
                "live": {}, "updated_at": None}
    p = row.payload or {}
    return {
        "available": True,
        "context": p.get("context") or {},
        "messages": p.get("messages") or [],
        "receipt": p.get("receipt") or {},
        "chats": p.get("chats") or [],
        "live": p.get("live") or {},
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/tavern/events")
async def tavern_events() -> StreamingResponse:
    """SSE：酒馆镜像有变化就推送一次（前端「酒馆对话」实时刷新）。"""
    import asyncio
    import json

    from fastapi.responses import StreamingResponse

    from ...db import SessionLocal
    from ...models import TavernMirror

    async def gen():
        last = ""
        while True:
            session = SessionLocal()
            try:
                row = session.get(TavernMirror, 1)
                p = (row.payload or {}) if row else {}
                snap = {
                    "available": row is not None,
                    "context": p.get("context") or {},
                    "messages": p.get("messages") or [],
                    "receipt": p.get("receipt") or {},
                    "chats": p.get("chats") or [],
                    "live": p.get("live") or {},
                    "updated_at": row.updated_at.isoformat() if (row and row.updated_at) else None,
                }
                # 用“内容签名”判断变化：不能算 updated_at，否则扩展每 2.5s 心跳都会让
                # 快照看起来变了，前端跟着整块重绘，表现就是一闪一闪。
                signature = json.dumps(
                    {k: snap[k] for k in ("available", "context", "messages", "receipt", "chats", "live")},
                    ensure_ascii=False, sort_keys=True,
                )
            finally:
                session.close()
            if signature != last:
                last = signature
                yield f"data: {json.dumps(snap, ensure_ascii=False)}\n\n"
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(1.5)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/projects/{project_id}/tavern/send")
def tavern_send(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """从我们前端直接给酒馆发一条消息并触发生成（无需切回酒馆窗口）。

    body: {"text": "..."}  —— 原文发送；生成的回复会作为本项目的正文分段保存。
    """
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "消息不能为空")

    # 新任务开始：清掉上一次的失败/流式状态，避免红框一直挂着
    from ...models import TavernMirror
    _row = session.get(TavernMirror, 1)
    if _row is not None:
        _p = dict(_row.payload or {})
        _p["live"] = {}
        _row.payload = _p

    job = jobq.enqueue_deferred(
        KIND,
        project_id=project_id,
        stage="S1",
        payload={"project_id": project_id, "mode": "raw", "instruction": text, "context_tail": ""},
    )
    return {"job_id": job.id, "status": job.status}


@router.post("/bridge/error")
def bridge_error(body: dict, session: Session = Depends(get_session)) -> dict:
    """扩展报告生成失败（如上游 API 4xx/5xx）。前端据此显示错误，而不是“没反应”。"""
    from ...models import TavernMirror

    job_id = body.get("job_id")
    msg = (body.get("error") or "生成失败").strip()
    job = session.get(Job, int(job_id)) if job_id else None
    if job is not None:
        job.status = JobStatus.FAILED.value
        job.error = msg
        job.finished_at = datetime.now(timezone.utc)

    row = session.get(TavernMirror, 1)
    if row is None:
        row = TavernMirror(id=1, payload={})
        session.add(row)
    p = dict(row.payload or {})
    p["live"] = {"job_id": job_id, "text": "", "chars": 0, "done": True, "error": msg,
                 "updated_at": datetime.now(timezone.utc).isoformat()}
    row.payload = p
    session.commit()
    return {"ok": True}


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
