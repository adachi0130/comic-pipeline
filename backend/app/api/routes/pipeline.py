"""流水线编排接口：触发各阶段、审查门总开关、中间产物总览（按项目隔离）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import artifacts as A
from ... import jobs as jobq
from ...db import get_session
from ...models import ArtifactKind, ArtifactStatus, Project, StageModel, Template

router = APIRouter(tags=["pipeline"])

# 阶段顺序：S1 正文（酒馆桥）→ S2 分格 → S3 提示词 → S4 出图 → S5 合成 → S6 导出
# S1 由扩展领取，不在此表内（见 bridge.py）。
STAGE_ORDER = [
    ("S2", "script"),
    ("S3", "prompt"),
    ("S4", "image"),
    ("S5", "compose"),
    ("S6", "book"),
]

# 各阶段对应的产物类型与人类可读名（供前端展示中间产物）
STAGE_ARTIFACTS = {
    "S1": (ArtifactKind.PROSE.value, "正文分段"),
    "S2": (ArtifactKind.PAGE_SCRIPT.value, "分页分格"),
    "S3": (ArtifactKind.PANEL_PROMPT.value, "分镜提示词"),
    "S4": (ArtifactKind.IMAGE.value, "候选图"),
    "S5": (ArtifactKind.PAGE_IMAGE.value, "整页成图"),
    "S6": (ArtifactKind.BOOK.value, "成书导出"),
}


@router.get("/projects/{project_id}/pages/{page_ref}")
def page_detail(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """S2 页详情：分格脚本 + 该模板几何 + 可用模板菜单 + 对应提示词。

    前端用它渲染“详情”，并支持手改台词/动作、手动换模板、对单页重跑提示词。
    """
    art = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if art is None:
        raise HTTPException(404, f"没有该页的分格脚本：{page_ref}")
    payload = art.payload or {}
    tpl = session.get(Template, payload.get("template_id"))
    prompts = []
    page_no = page_ref.split(":", 1)[-1]
    for p in payload.get("panels", []):
        pref = f"panel:{page_no}.{p.get('panel_order')}"
        pa = A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, pref)
        prompts.append({"panel_ref": pref, "prompt": (pa.payload if pa else None), "status": (pa.status if pa else None)})
    return {
        "page_ref": page_ref,
        "artifact_id": art.id,
        "status": art.status,
        "version": art.version,
        "template_id": payload.get("template_id"),
        "template": ({"id": tpl.id, "dir": tpl.dir, "panels_count": tpl.panels_count,
                      "layout_desc": tpl.layout_desc, "geometry": tpl.geometry} if tpl else None),
        "panels": payload.get("panels", []),
        "prompts": prompts,
    }


@router.get("/templates")
def list_templates(session: Session = Depends(get_session)) -> list[dict]:
    """模板菜单（供手动选模板下拉）。"""
    rows = session.scalars(select(Template).order_by(Template.dir, Template.panels_count, Template.id)).all()
    return [{"id": r.id, "dir": r.dir, "panels_count": r.panels_count, "layout_desc": r.layout_desc} for r in rows]


@router.post("/projects/{project_id}/pages/{page_ref}/template")
def change_template(project_id: int, page_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """手动换模板。若新模板格数与现有分格数不同，则**按新格数重建分格**
    （保留前 min(N,M) 格内容，多出的格给出占位），保证与模板严格一致。"""
    tpl_id = (body.get("template_id") or "").strip()
    tpl = session.get(Template, tpl_id)
    if tpl is None:
        raise HTTPException(400, f"模板不存在：{tpl_id}")
    art = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if art is None:
        raise HTTPException(404, f"没有该页的分格脚本：{page_ref}")

    old_panels = list((art.payload or {}).get("panels", []))
    n = tpl.panels_count
    panels = []
    for i in range(1, n + 1):
        if i <= len(old_panels):
            p = dict(old_panels[i - 1]); p["panel_order"] = i
        else:
            p = {"panel_order": i, "role": "medium", "shot": "medium", "characters": [],
                 "action": "", "scene_desc": "", "dialogue": "", "bubble_type": "none", "technique": []}
        panels.append(p)

    new_payload = {**(art.payload or {}), "template_id": tpl.id, "panels": panels, "geometry": tpl.geometry}
    new = A.create(session, project_id=project_id, kind=ArtifactKind.PAGE_SCRIPT.value, ref=page_ref,
                   payload=new_payload, status=ArtifactStatus.REVIEW.value)
    session.commit()
    return {"ok": True, "artifact_id": new.id, "version": new.version,
            "template_id": tpl.id, "panels_count": tpl.panels_count,
            "note": f"已换为 {tpl.panels_count} 格模板；分格数已对齐"}


@router.post("/projects/{project_id}/pages/{page_ref}/script")
def update_page_script(project_id: int, page_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """手改分格内容（台词/动作/景别/技法等），写新版本。"""
    art = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if art is None:
        raise HTTPException(404, f"没有该页的分格脚本：{page_ref}")
    merged = {**(art.payload or {}), **body}
    new = A.create(session, project_id=project_id, kind=ArtifactKind.PAGE_SCRIPT.value, ref=page_ref,
                   payload=merged, status=ArtifactStatus.REVIEW.value)
    session.commit()
    return {"ok": True, "artifact_id": new.id, "version": new.version}


@router.post("/projects/{project_id}/run/{stage}")
def run_stage(project_id: int, stage: str, body: dict | None = None, session: Session = Depends(get_session)) -> dict:
    """触发某个阶段。"""
    stage = stage.upper()
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    kinds = {s: k for s, k in STAGE_ORDER}
    if stage not in kinds:
        raise HTTPException(400, f"未知阶段：{stage}（S1 正文请用 /prose/request）")
    job = jobq.enqueue(kinds[stage], project_id=project_id, stage=stage, payload={"project_id": project_id, **(body or {})})
    return {"job_id": job.id, "stage": stage, "status": job.status}


@router.patch("/projects/{project_id}/review-mode")
def set_review_mode(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """全局审查总开关：auto=全部自动通过，manual=到门停住。"""
    mode = body.get("mode")
    if mode not in ("auto", "manual"):
        raise HTTPException(400, "mode 必须是 auto 或 manual")
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    p.review_mode = mode
    session.commit()
    return {"review_mode": p.review_mode}


@router.get("/projects/{project_id}/gates")
def gates(project_id: int, session: Session = Depends(get_session)) -> dict:
    """阶段级审查门状态（每个阶段各产物类型的通过/待审/需重跑统计）。"""
    out: dict = {"stages": {}}
    for stage, (kind, _label) in STAGE_ARTIFACTS.items():
        rows = A.all_current(session, project_id, kind)
        st = [r.status for r in rows]
        out["stages"][stage] = {
            "count": len(rows),
            "approved": st.count(ArtifactStatus.APPROVED.value),
            "review": st.count(ArtifactStatus.REVIEW.value),
            "stale": st.count(ArtifactStatus.STALE.value),
            "pending": st.count(ArtifactStatus.PENDING.value),
            "failed": st.count(ArtifactStatus.FAILED.value),
        }
    return out


@router.get("/projects/{project_id}/stage-artifacts")
def stage_artifacts(project_id: int, session: Session = Depends(get_session)) -> dict:
    """按阶段返回各中间产物摘要（供“流水线”页展示）。"""
    out: dict = {}
    for stage, (kind, label) in STAGE_ARTIFACTS.items():
        rows = A.all_current(session, project_id, kind)
        out[stage] = {
            "kind": kind,
            "label": label,
            "items": [
                {
                    "id": a.id,
                    "ref": a.ref,
                    "version": a.version,
                    "status": a.status,
                    "summary": _summarize(a),
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
                for a in sorted(rows, key=lambda x: x.ref)
            ],
        }
    return out


def _summarize(a) -> str:
    p = a.payload or {}
    if a.kind == ArtifactKind.PROSE.value:
        t = (p.get("text") or "").replace("\n", " ")
        return (t[:80] + "…") if len(t) > 80 else t
    if a.kind == ArtifactKind.PAGE_SCRIPT.value:
        return f"{p.get('template_id', '?')} · {len(p.get('panels', []))} 格"
    if a.kind == ArtifactKind.PANEL_PROMPT.value:
        s = (p.get("prompt_pos") or "")
        return (s[:70] + "…") if len(s) > 70 else s
    if a.kind == ArtifactKind.IMAGE.value:
        return f"{len(p.get('candidates', []))} 张候选（已选 {p.get('selected_index')}）"
    if a.kind == ArtifactKind.PAGE_IMAGE.value:
        return f"已放 {p.get('placed', '?')} 格"
    if a.kind == ArtifactKind.BOOK.value:
        return f"{p.get('pages', '?')} 页 · {list((p.get('files') or {}).keys())}"
    return ""


@router.patch("/projects/{project_id}/stage-models")
def set_stage_models(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """设置阶段→供应商绑定：{"S2": 1, "S3": 2}。"""
    for stage, provider_id in body.items():
        sm = session.get(StageModel, stage)
        if sm is None:
            session.add(StageModel(stage=stage, provider_id=int(provider_id)))
        else:
            sm.provider_id = int(provider_id)
    session.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/stale")
def stale_list(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    """列出所有因上游变更而待重跑（stale）的产物。"""
    out = []
    for stage, (kind, label) in STAGE_ARTIFACTS.items():
        for a in A.all_current(session, project_id, kind):
            if a.status == ArtifactStatus.STALE.value:
                out.append({"stage": stage, "kind": a.kind, "label": label, "ref": a.ref, "version": a.version})
    return out
