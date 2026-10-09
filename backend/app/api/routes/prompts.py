"""阶段提示词接口（前端可编辑保存 / 一键还原默认）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...db import get_session
from ...stages import promptlib

router = APIRouter(tags=["prompts"])


@router.get("/prompts")
def list_prompts(session: Session = Depends(get_session)) -> list[dict]:
    """列出各 LLM 阶段的提示词（当前值 / 默认值 / 是否已自定义）。"""
    return promptlib.prompt_info(session)


@router.put("/prompts/{name}")
def update_prompt(name: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """保存提示词覆盖（写数据库，重启不丢）。"""
    if name not in promptlib.PROMPT_STAGES:
        raise HTTPException(400, f"不支持编辑的提示词：{name}")
    system_text = body.get("system_text")
    user_text = body.get("user_text")
    if system_text is None or user_text is None:
        raise HTTPException(400, "需要同时提供 system_text 与 user_text")
    promptlib.save_prompt(session, name, system_text, user_text)
    return {"ok": True, "name": name, "overridden": True}


@router.delete("/prompts/{name}")
def reset_prompt(name: str, session: Session = Depends(get_session)) -> dict:
    """还原为仓库里的默认提示词。"""
    if name not in promptlib.PROMPT_STAGES:
        raise HTTPException(400, f"不支持编辑的提示词：{name}")
    promptlib.reset_prompt(session, name)
    return {"ok": True, "name": name, "overridden": False}
