"""角色资产库 + 提示词预设 + LoRA 选择（项目默认 / 单格覆盖）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from ...db import get_session
from ...models import Character, LoraSelection, Project, PromptPreset

router = APIRouter(tags=["assets"])


# ---------------- 角色资产 ----------------
@router.get("/projects/{project_id}/characters")
def list_characters(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    rows = session.scalars(
        select(Character).where(Character.project_id == project_id).order_by(Character.id)
    ).all()
    return [_char(c) for c in rows]


@router.post("/projects/{project_id}/characters")
def upsert_character(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    cid = body.get("id")
    c = session.get(Character, cid) if cid else None
    if cid and (c is None or c.project_id != project_id):
        raise HTTPException(404, "当前项目中没有这个角色")
    if c is None:
        c = Character(project_id=project_id, name=body.get("name", "角色"))
        session.add(c)
    for f in ("name", "trigger_words", "lora_name", "lora_weight", "use_lora",
              "ref_image_path", "prompt_block", "notes"):
        if f in body and body[f] is not None:
            setattr(c, f, body[f])
    session.commit()
    session.refresh(c)
    return _char(c)


@router.delete("/characters/{character_id}")
def delete_character(character_id: int, session: Session = Depends(get_session)) -> dict:
    session.execute(delete(Character).where(Character.id == character_id))
    session.commit()
    return {"ok": True}


# ---------------- 提示词预设（主人常用的正/负向提示词）----------------
@router.get("/prompt-presets")
def list_presets(project_id: int | None = None, session: Session = Depends(get_session)) -> dict:
    """列出全局预设 + 指定项目的预设。"""
    cond = [PromptPreset.scope == "global"]
    if project_id:
        cond.append((PromptPreset.scope == "project") & (PromptPreset.project_id == project_id))
    rows = session.scalars(
        select(PromptPreset).where(or_(*cond)).order_by(PromptPreset.kind, PromptPreset.scope, PromptPreset.id)
    ).all()
    return {
        "positive": [_preset(p) for p in rows if p.kind == "positive"],
        "negative": [_preset(p) for p in rows if p.kind == "negative"],
    }


@router.post("/prompt-presets")
def upsert_preset(body: dict, session: Session = Depends(get_session)) -> dict:
    pid = body.get("id")
    p = session.get(PromptPreset, pid) if pid else None
    if p is None:
        p = PromptPreset(name=body.get("name", "预设"), scope=body.get("scope", "global"),
                         kind=body.get("kind", "positive"))
        session.add(p)
    for f in ("name", "text", "kind", "scope", "project_id", "is_default", "loras"):
        if f in body:
            setattr(p, f, body[f])
    if p.kind not in ("positive", "negative"):
        raise HTTPException(400, "kind 必须是 positive 或 negative")
    if p.scope not in ("global", "project"):
        raise HTTPException(400, "预设作用域必须是 global 或 project")
    if p.scope == "project":
        if not p.project_id or session.get(Project, p.project_id) is None:
            raise HTTPException(400, "项目预设必须关联一个有效项目")
    else:
        p.project_id = None
    # 同种、同作用域的默认项互斥；项目默认不能清掉其他项目或全局默认。
    if p.is_default:
        session.flush()
        scope_filter = PromptPreset.project_id == p.project_id if p.scope == "project" else PromptPreset.project_id.is_(None)
        others = session.scalars(
            select(PromptPreset).where(PromptPreset.kind == p.kind, PromptPreset.scope == p.scope,
                                      scope_filter, PromptPreset.id != p.id)
        ).all()
        for o in others:
            o.is_default = False
    session.commit()
    session.refresh(p)
    return _preset(p)


@router.delete("/prompt-presets/{preset_id}")
def delete_preset(preset_id: int, session: Session = Depends(get_session)) -> dict:
    session.execute(delete(PromptPreset).where(PromptPreset.id == preset_id))
    session.commit()
    return {"ok": True}


# ---------------- LoRA 选择 ----------------
@router.get("/projects/{project_id}/loras")
def list_loras(project_id: int, panel_ref: str | None = None, session: Session = Depends(get_session)) -> dict:
    rows = session.scalars(
        select(LoraSelection).where(LoraSelection.project_id == project_id).order_by(LoraSelection.id)
    ).all()
    return {
        "project": [_lora(r) for r in rows if r.scope == "project"],
        "panels": [_lora(r) for r in rows if r.scope == "panel" and (panel_ref is None or r.panel_ref == panel_ref)],
    }


@router.put("/projects/{project_id}/loras")
def set_loras(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """整体覆盖某作用域的 LoRA 列表。

    body: {"scope":"project"|"panel", "panel_ref":"panel:1.1", "loras":[{"name":..., "weight":..., "enabled":...}]}
    """
    scope = body.get("scope", "project")
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    panel_ref = body.get("panel_ref", "")
    if scope not in ("project", "panel"):
        raise HTTPException(400, "scope 必须是 project 或 panel")

    stmt = delete(LoraSelection).where(
        LoraSelection.project_id == project_id, LoraSelection.scope == scope
    )
    if scope == "panel":
        stmt = stmt.where(LoraSelection.panel_ref == panel_ref)
    session.execute(stmt)

    for i, item in enumerate(body.get("loras") or []):
        if not item.get("name"):
            continue
        session.add(
            LoraSelection(
                project_id=project_id,
                scope=scope,
                panel_ref=panel_ref,
                lora_name=item["name"],
                weight=float(item.get("weight", 0.8)),
                enabled=bool(item.get("enabled", True)),
                order_index=i,
            )
        )
    session.commit()
    return {"ok": True}


def _char(c: Character) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "trigger_words": c.trigger_words,
        "lora_name": c.lora_name,
        "lora_weight": c.lora_weight,
        "use_lora": c.use_lora,
        "prompt_block": c.prompt_block,
        "ref_image_path": c.ref_image_path,
        "notes": c.notes,
    }


def _preset(p: PromptPreset) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "text": p.text,
        "kind": p.kind,
        "scope": p.scope,
        "project_id": p.project_id,
        "is_default": p.is_default,
        "loras": p.loras or [],
    }


def _lora(r: LoraSelection) -> dict:
    return {
        "id": r.id,
        "scope": r.scope,
        "panel_ref": r.panel_ref,
        "name": r.lora_name,
        "weight": r.weight,
        "enabled": r.enabled,
        "order_index": r.order_index,
    }
