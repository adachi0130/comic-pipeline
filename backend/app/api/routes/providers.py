"""LLM 供应商接口（任意 OpenAI 兼容）。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_session
from ...llm import LLMClient, LLMError, ProviderConfig
from ...models import LLMCall, LLMProvider
from ...schemas import ProviderCreate

router = APIRouter(tags=["providers"])


def _find_tavern_data_dir() -> Path | None:
    """定位酒馆的 data/default-user 目录（用于导入模型配置）。"""
    import glob as _glob

    from ...config import get_settings

    s = get_settings()
    cands: list[str] = []
    if s.tavern_data_dir:
        cands.append(s.tavern_data_dir)
    for base in ("E:/jiuguan", "E:/ai生图", "E:/", str(Path.home())):
        cands.extend(_glob.glob(f"{base}/*SillyTavern*/SillyTavern-*/data/default-user"))
        cands.extend(_glob.glob(f"{base}/*SillyTavern-*/data/default-user"))
        cands.extend(_glob.glob(f"{base}/SillyTavern-*/data/default-user"))
    for c in cands:
        p = Path(c)
        if (p / "settings.json").exists():
            return p
    return None


@router.post("/providers/import-tavern")
def import_from_tavern(body: dict | None = None) -> dict:
    """把酒馆里正在用的模型配置（端点 / 模型 / key）导入为本系统的 LLM 供应商。

    S2（分页分格）和 S3（分镜提示词）走的是本系统自己的 LLM，需要在这里配置供应商；
    直接从酒馆导入最省事，也能保证和写正文用的是同一套模型。
    """
    import json

    data_dir = _find_tavern_data_dir()
    if data_dir is None:
        raise HTTPException(400, "没找到酒馆的 data/default-user 目录；请手动填供应商信息")

    try:
        settings = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
        secrets = json.loads((data_dir / "secrets.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(400, f"读取酒馆配置失败：{e}") from e

    oai = settings.get("oai_settings") or {}
    base_url = (oai.get("custom_url") or "").rstrip("/")
    model = oai.get("custom_model") or ""
    if not base_url or not model:
        raise HTTPException(400, "酒馆里没有配置自定义端点/模型（custom_url / custom_model）")

    key = ""
    for it in secrets.get("api_key_custom") or []:
        if isinstance(it, dict):
            for v in it.values():
                if isinstance(v, str) and v.startswith("sk-"):
                    key = v
        elif isinstance(it, str) and it.startswith("sk-"):
            key = it

    return {
        "found": True,
        "source_dir": str(data_dir),
        "name": f"酒馆导入 · {oai.get('chat_completion_source', 'custom')}",
        "base_url": base_url,
        "model": model,
        "has_key": bool(key),
        "api_key": key,
    }


@router.get("/providers")
def list_providers(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.scalars(select(LLMProvider).order_by(LLMProvider.id)).all()
    return [_brief(p) for p in rows]


@router.post("/providers")
def create_provider(body: ProviderCreate, session: Session = Depends(get_session)) -> dict:
    """新建供应商。同名已存在则**更新**（避免反复导入/添加产生重复项）。"""
    existing = session.scalars(
        select(LLMProvider).where(LLMProvider.name == body.name)
    ).first()
    if existing is not None:
        existing.base_url = body.base_url
        existing.model = body.model
        if body.api_key:
            existing.api_key = body.api_key
        existing.extra = body.extra or existing.extra
        session.commit()
        session.refresh(existing)
        return _brief(existing)
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
