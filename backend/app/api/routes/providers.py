"""LLM 供应商接口（任意 OpenAI 兼容）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_session
from ...llm import LLMClient, LLMError, ProviderConfig
from ...models import LLMCall, LLMProvider
from ...schemas import ProviderCreate

router = APIRouter(tags=["providers"])


@router.get("/providers")
def list_providers(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.scalars(select(LLMProvider).order_by(LLMProvider.id)).all()
    return [_brief(p) for p in rows]


@router.post("/providers")
def create_provider(body: ProviderCreate, session: Session = Depends(get_session)) -> dict:
    p = LLMProvider(**body.model_dump())
    session.add(p)
    session.commit()
    session.refresh(p)
    return _brief(p)


@router.patch("/providers/{provider_id}")
def update_provider(
    provider_id: int, body: dict, session: Session = Depends(get_session)
) -> dict:
    p = session.get(LLMProvider, provider_id)
    if p is None:
        raise HTTPException(404, "供应商不存在")
    for field in ("name", "base_url", "api_key", "model", "extra", "enabled"):
        if field in body and body[field] is not None:
            setattr(p, field, body[field])
    session.commit()
    session.refresh(p)
    return _brief(p)


@router.post("/providers/{provider_id}/test")
def test_provider(provider_id: int, session: Session = Depends(get_session)) -> dict:
    p = session.get(LLMProvider, provider_id)
    if p is None:
        raise HTTPException(404, "供应商不存在")
    client = LLMClient(ProviderConfig(base_url=p.base_url, model=p.model, api_key=p.api_key, extra=p.extra or {}))
    try:
        res = client.chat(
            [{"role": "user", "content": "只回复两个字：可用"}],
            temperature=0.0,
            max_tokens=16,
        )
        return {"ok": True, "reply": res.text.strip(), "duration_ms": res.duration_ms}
    except LLMError as e:
        return {"ok": False, "error": str(e)}


@router.get("/providers/calls")
def list_calls(project_id: int | None = None, session: Session = Depends(get_session)) -> list[dict]:
    stmt = select(LLMCall).order_by(LLMCall.id.desc()).limit(200)
    if project_id is not None:
        stmt = stmt.where(LLMCall.project_id == project_id)
    rows = session.scalars(stmt).all()
    return [
        {
            "id": c.id,
            "stage": c.stage,
            "model": c.model,
            "error": c.error,
            "duration_ms": c.duration_ms,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in rows
    ]


def _brief(p: LLMProvider) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "base_url": p.base_url,
        "model": p.model,
        "extra": p.extra,
        "enabled": p.enabled,
        # 不回传 api_key 明文，只回传是否已设置
        "has_key": bool(p.api_key),
    }
