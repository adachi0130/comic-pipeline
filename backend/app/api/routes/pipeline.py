"""流水线编排接口：触发各阶段、审查门总开关、中间产物总览（按项目隔离）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from ... import artifacts as A
from ... import jobs as jobq
from ...db import get_session
from ...models import (
    Artifact,
    ArtifactEdge,
    ArtifactKind,
    ArtifactStatus,
    Project,
    LLMProvider,
    StageModel,
    Technique,
    Template,
)

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


@router.get("/templates/{template_id}/svg")
def template_svg(template_id: str, session: Session = Depends(get_session)):
    """返回模板 SVG（供前端渲染缩略图，可视化选模板）。"""
    from pathlib import Path as _P

    from fastapi.responses import Response

    t = session.get(Template, template_id)
    if t is None or not t.svg_path or not _P(t.svg_path).exists():
        raise HTTPException(404, f"模板 SVG 不存在：{template_id}")
    svg = _P(t.svg_path).read_text(encoding="utf-8")
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/projects/{project_id}/readiness")
def readiness(project_id: int, session: Session = Depends(get_session)) -> dict:
    """各阶段的前置条件检查：缺什么就说清楚，前端据此提示/跳转。

    规则（硬门槛）：
    - S1 正文：需要项目有大纲
    - S2 分格：需要**至少一段已通过**的正文
    - S3 提示词：需要**至少一页已通过**的分格
    - S4 出图：需要**至少一条已通过**的提示词
    - S5 合成：需要**至少一页已通过的分格** + 该页有已选图
    - S6 导出：需要**至少一页已通过**的整页图
    """
    from ...models import Character

    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")

    def cnt(kind: str, status: str | None = None) -> int:
        rows = A.all_current(session, project_id, kind)
        return sum(1 for r in rows if status is None or r.status == status)

    prose_all = cnt(ArtifactKind.PROSE.value)
    prose_ok = cnt(ArtifactKind.PROSE.value, ArtifactStatus.APPROVED.value)
    page_ok = cnt(ArtifactKind.PAGE_SCRIPT.value, ArtifactStatus.APPROVED.value)
    prompt_ok = cnt(ArtifactKind.PANEL_PROMPT.value, ArtifactStatus.APPROVED.value)
    img_ok = cnt(ArtifactKind.IMAGE.value, ArtifactStatus.APPROVED.value)
    pageimg_ok = cnt(ArtifactKind.PAGE_IMAGE.value, ArtifactStatus.APPROVED.value)
    has_provider = session.scalars(
        select(LLMProvider).where(LLMProvider.enabled.is_(True)).limit(1)
    ).first() is not None

    def block(stage: str, ok: bool, missing: str, goto: str = "") -> dict:
        return {"stage": stage, "ready": ok, "missing": "" if ok else missing, "goto": goto}

    out = {
        "S1": block("S1", bool((project.outline or "").strip()),
                    "还没有故事大纲；请到「项目」页填写大纲", "projects"),
        "S2": block("S2", prose_ok > 0,
                    ("还没有已审核通过的正文（当前 %d 段待审）；请到「正文」页审核通过至少一段" % (prose_all - prose_ok))
                    if prose_all else "还没有正文；请先到「正文」页写并审核通过", "novel"),
        "S3": block("S3", page_ok > 0,
                    "还没有已审核通过的分格页；请到「分格」页通过至少一页", "pages"),
        "S4": block("S4", prompt_ok > 0,
                    "还没有已审核通过的提示词；请到「流水线」页对 S3 产物审核通过", "pipeline"),
        "S5": block("S5", page_ok > 0 and img_ok > 0,
                    "需要：已通过的分格页 + 该页每格选定成图", "pages"),
        "S6": block("S6", pageimg_ok > 0,
                    "还没有已审核通过的整页成图；请先完成 S5 分页合成并审核", "compose"),
        "counts": {
            "prose_total": prose_all, "prose_approved": prose_ok,
            "page_approved": page_ok, "prompt_approved": prompt_ok,
            "image_approved": img_ok, "page_image_approved": pageimg_ok,
        },
        "has_llm_provider": has_provider,
        "llm_hint": "" if has_provider else "没有已启用的 LLM 供应商；请到「LLM 供应商」页添加或启用",
    }
    return out


@router.get("/projects/{project_id}/pages")
def pages_board(project_id: int, session: Session = Depends(get_session)) -> dict:
    """S2「分格」工作台数据：小说全文 + 已有页 + 模板菜单。"""
    from ...stages import prose

    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    novel = prose.novel_state(session, project_id)
    pages = []
    for a in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value):
        try:
            no = int(a.ref.split(":", 1)[1])
        except (IndexError, ValueError):
            no = 10**9
        payload = a.payload or {}
        pages.append({
            "page_ref": a.ref,
            "page_index": no,
            "artifact_id": a.id,
            "version": a.version,
            "status": a.status,
            "template_id": payload.get("template_id"),
            "source": payload.get("source", "manual"),
            "panels": [
                {"panel_order": p.get("panel_order"), "role": p.get("role"), "shot": p.get("shot"),
                 "action": p.get("action", ""), "dialogue": p.get("dialogue", ""),
                 "scene_desc": p.get("scene_desc", ""), "characters": p.get("characters", []),
                 "technique": p.get("technique", [])}
                for p in payload.get("panels", [])
            ],
        })
    pages.sort(key=lambda x: x["page_index"])
    tpls = [
        {"id": r.id, "dir": r.dir, "panels_count": r.panels_count, "layout_desc": r.layout_desc}
        for r in session.scalars(select(Template).order_by(Template.dir, Template.panels_count, Template.id)).all()
    ]
    return {
        "novel_chars": novel["chars"],
        "target_pages": project.target_pages,
        "pages": pages,
        "templates": tpls,
        "panel_prompt_count": len(A.all_current(session, project_id, ArtifactKind.PANEL_PROMPT.value)),
    }


@router.post("/projects/{project_id}/pages")
def create_page(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """新增一个空页（可指定模板；不给则用 4 格模板占位）。"""
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    tpl_id = (body.get("template_id") or "").strip()
    tpl = session.get(Template, tpl_id) if tpl_id else None
    if tpl is None:
        tpl = session.scalars(select(Template).where(Template.panels_count == 4).limit(1)).first() \
            or session.scalars(select(Template).limit(1)).first()
    if tpl is None:
        raise HTTPException(400, "模板表为空，请先跑 build_template_menu.py")

    used = set()
    for a in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value):
        try:
            used.add(int(a.ref.split(":", 1)[1]))
        except (IndexError, ValueError):
            pass
    no = 1
    while no in used:
        no += 1
    ref = f"page:{no}"
    panels = [
        {"panel_order": i, "role": "medium", "shot": "medium", "characters": [],
         "action": "", "scene_desc": "", "dialogue": "", "bubble_type": "none", "technique": []}
        for i in range(1, tpl.panels_count + 1)
    ]
    A.create(session, project_id=project_id, kind=ArtifactKind.PAGE_SCRIPT.value, ref=ref,
             payload={"scene_id": 0, "page_index": no, "template_id": tpl.id,
                      "panels": panels, "geometry": tpl.geometry},
             status=ArtifactStatus.REVIEW.value)
    session.commit()
    return {"ok": True, "page_ref": ref, "template_id": tpl.id, "panels_count": tpl.panels_count}


@router.post("/projects/{project_id}/panels/{panel_ref}/prepare")
def prepare_panel(project_id: int, panel_ref: str, session: Session = Depends(get_session)) -> dict:
    """为某一格「自动填写」提示词：调 LLM 真正生成该格的正/负向提示词。

    - 已有该格提示词则直接复用（不覆盖）；
    - 否则按 S3 的逻辑（预设 + 角色触发词/外观裁剪 + 排版尺寸 + 角色 LoRA）生成一格。
    """
    from ...stages import prompt as prompt_stage

    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    if A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, panel_ref) is not None:
        return {"ok": True, "reused": True}

    page_ref = "page:" + panel_ref.split(":", 1)[1].split(".", 1)[0]
    if A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref) is None:
        raise HTTPException(400, f"找不到 {page_ref} 的分格脚本（先跑 S2）")

    # 同步调 LLM 生成这一格（S3 的 handle 支持 panel_ref 只生成一格）
    from ...models import Job as _Job

    try:
        prompt_stage.handle(session, _Job(project_id=project_id, kind="prompt", payload={
            "project_id": project_id, "page_ref": page_ref, "panel_ref": panel_ref,
        }))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - LLM 未配置/失败等，给前端一句人话
        raise HTTPException(502, f"自动填写失败：{e}") from e
    art = A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, panel_ref)
    return {"ok": True, "reused": False, "artifact_id": art.id if art else None}


@router.get("/projects/{project_id}/compose-board")
def compose_board(project_id: int, session: Session = Depends(get_session)) -> dict:
    """S5「分页合成」页数据：每页的模板几何 + 各格已选画面，用于前端预览与去 MED 合成。"""
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")

    pages = []
    for a in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value):
        payload = a.payload or {}
        try:
            no = int(a.ref.split(":", 1)[1])
        except (IndexError, ValueError):
            no = 10**9
        tpl = session.get(Template, payload.get("template_id")) if payload.get("template_id") else None
        geom = payload.get("geometry") or (tpl.geometry if tpl else {})
        panels = []
        ready = True
        for p in payload.get("panels", []):
            order = p.get("panel_order")
            pref = f"panel:{no}.{order}"
            img = A.current(session, project_id, ArtifactKind.IMAGE.value, pref)
            prompt_art = A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, pref)
            url = ""
            if img is not None:
                cands = (img.payload or {}).get("candidates") or []
                idx = (img.payload or {}).get("selected_index")
                if idx is None and cands:
                    idx = 0
                if idx is not None and 0 <= idx < len(cands):
                    url = f"/api/artifacts/{img.id}/candidate/{idx}"
            if not url:
                ready = False
            panels.append({
                "panel_order": order, "panel_ref": pref,
                "has_image": bool(url), "image_url": url,
                "prompt": (prompt_art.payload.get("prompt_pos") if prompt_art else "") or "",
            })
        page_img = A.current(session, project_id, ArtifactKind.PAGE_IMAGE.value, a.ref)
        # 「编辑中」画布：用户在 MED 里保存的整页状态（也是一种“该页的成品”）
        med_doc = A.current(session, project_id, ArtifactKind.MED_DOC.value, a.ref)
        # 该页可审核的成品：优先整页成图；否则用「编辑中」画布（有落盘预览时）
        if page_img is not None:
            result, result_kind = page_img, "page_image"
        elif med_doc is not None and med_doc.path:
            result, result_kind = med_doc, "med_doc"
        else:
            result, result_kind = None, ""
        pages.append({
            "page_ref": a.ref, "page_index": no,
            "template_id": payload.get("template_id"),
            "dir": tpl.dir if tpl else "",
            "panels_count": tpl.panels_count if tpl else len(panels),
            "layout_desc": (tpl.layout_desc if tpl else ""),
            "canvas": geom.get("canvas") or [672, 950],
            "geometry": geom.get("panels") or [],
            "panels": panels,
            "ready": ready,
            "composed": page_img is not None,
            "composed_url": f"/api/artifacts/{page_img.id}/file" if page_img else "",
            # 整页成图（S5）的审核信息
            "page_image_id": page_img.id if page_img else None,
            "page_image_status": page_img.status if page_img else "",
            # 「编辑中」画布（MED 存档）的信息
            "med_doc_id": med_doc.id if med_doc else None,
            "med_doc_status": med_doc.status if med_doc else "",
            "med_doc_has_file": bool(med_doc and med_doc.path),
            # 该页统一的可审核成品（前端据此显示 通过/驳回；一键审核也按它判定）
            "result_id": result.id if result else None,
            "result_status": result.status if result else "",
            "result_kind": result_kind,
        })
    pages.sort(key=lambda x: x["page_index"])
    return {"pages": pages}


@router.post("/projects/{project_id}/med-doc/{page_ref}")
def save_med_doc(project_id: int, page_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """保存 MED 画布存档（编辑中的状态），可日后再打开继续编辑。

    body: {"doc": <canvas JSON 字符串或对象>, "png": "data:image/png;base64,..."（可选预览）}
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    import base64
    import json
    from ...storage import StorageError, new_output_dir, validate_ref, write_new

    try:
        validate_ref(page_ref, "page")
    except StorageError as exc:
        raise HTTPException(400, str(exc)) from exc

    doc = body.get("doc")
    if doc is None:
        raise HTTPException(400, "缺少 doc")
    doc_text = doc if isinstance(doc, str) else json.dumps(doc, ensure_ascii=False)
    png_path = ""
    png_data = body.get("png") or ""
    if isinstance(png_data, str) and png_data.startswith("data:"):
        try:
            b64 = png_data.split(",", 1)[1]
            data = base64.b64decode(b64, validate=True)
            out_dir = new_output_dir(project_id, "med_pages", ref=page_ref)
            preview_path = out_dir / f"{page_ref.replace(':', '_')}.png"
            write_new(preview_path, data)
            png_path = str(preview_path)
        except StorageError as exc:
            raise HTTPException(403, str(exc)) from exc
        except Exception:  # noqa: BLE001 - 预览存不了不影响主流程
            png_path = ""
    upstream = []
    script = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if script is not None:
        upstream.append(script)
    panel_prefix = f"panel:{page_ref.split(':', 1)[1]}."
    upstream.extend(a for a in A.all_current(session, project_id, ArtifactKind.IMAGE.value)
                    if a.ref.startswith(panel_prefix))
    art = A.create(
        session, project_id=project_id, kind=ArtifactKind.MED_DOC.value, ref=page_ref,
        payload={"doc": doc_text}, path=png_path, status=ArtifactStatus.REVIEW.value, inputs=upstream,
    )
    page_image = None
    if png_path:
        # 画布存档和用于成册的整页快照同时生成新版本，供审核/导出继续使用。
        page_image = A.create(
            session, project_id=project_id, kind=ArtifactKind.PAGE_IMAGE.value, ref=page_ref,
            payload={"source": "med_editor", "med_doc_id": art.id}, path=png_path,
            status=ArtifactStatus.REVIEW.value, inputs=[art],
        )
    session.commit()
    return {"ok": True, "artifact_id": art.id, "version": art.version,
            "has_preview": bool(png_path), "page_image_id": page_image.id if page_image else None}


@router.get("/projects/{project_id}/med-doc/{page_ref}")
def get_med_doc(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """取 MED 画布存档（继续编辑用）。"""
    art = A.current(session, project_id, ArtifactKind.MED_DOC.value, page_ref)
    if art is None:
        raise HTTPException(404, "还没有该页的画布存档")
    return {"doc": (art.payload or {}).get("doc", ""), "version": art.version,
            "png_url": f"/api/artifacts/{art.id}/file" if art.path else ""}


@router.get("/projects/{project_id}/prompt-board")
def prompt_board(project_id: int, session: Session = Depends(get_session)) -> dict:
    """S3「提示词」独立页面数据：按页列出每一格的分镜提示词（含未生成的占位）。"""
    from ...stages import prompt as prompt_stage

    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")

    # 现有提示词产物：ref = panel:{页}.{格}
    prompt_by_ref: dict[str, dict] = {}
    for a in A.all_current(session, project_id, ArtifactKind.PANEL_PROMPT.value):
        p = a.payload or {}
        prompt_by_ref[a.ref] = {
            "artifact_id": a.id, "version": a.version, "status": a.status,
            "prompt_pos": p.get("prompt_pos", ""), "prompt_neg": p.get("prompt_neg", ""),
            "loras": p.get("loras", []), "width": p.get("width"), "height": p.get("height"),
            "frame": p.get("frame", ""), "params": p.get("params", {}),
        }

    pages = []
    for a in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value):
        payload = a.payload or {}
        try:
            no = int(a.ref.split(":", 1)[1])
        except (IndexError, ValueError):
            no = 10**9
        tpl = session.get(Template, payload.get("template_id")) if payload.get("template_id") else None
        panels = []
        for p in payload.get("panels", []):
            order = p.get("panel_order")
            ref = f"panel:{no}.{order}"
            prompt = prompt_by_ref.get(ref)
            panels.append({
                "panel_order": order, "panel_ref": ref,
                "shot": p.get("shot", ""), "action": p.get("action", ""),
                "scene_desc": p.get("scene_desc", ""),
                "dialogue": p.get("dialogue", ""),
                "characters": p.get("characters", []),
                "role": p.get("role", ""),
                "technique": p.get("technique", []),
                "prompt": prompt,
            })
        pages.append({
            "page_ref": a.ref, "page_index": no, "status": a.status,
            "template_id": payload.get("template_id"),
            "template": ({"dir": tpl.dir, "panels_count": tpl.panels_count, "layout_desc": tpl.layout_desc}
                         if tpl else None),
            "panels": panels,
        })
    pages.sort(key=lambda x: x["page_index"])
    done = sum(1 for pg in pages for p in pg["panels"] if p["prompt"])
    total = sum(len(pg["panels"]) for pg in pages)
    return {
        "pages": pages,
        "panel_total": total,
        "panel_done": done,
        "has_llm_provider": bool(session.scalars(
            select(LLMProvider).where(LLMProvider.enabled.is_(True)).limit(1)
        ).first()),
    }


@router.patch("/projects/{project_id}/panel-prompt/{panel_ref}")
def update_panel_prompt(project_id: int, panel_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """就地改某一格的分镜提示词（写一个新版本，下游标失效）。"""
    art = A.current(session, project_id, ArtifactKind.PANEL_PROMPT.value, panel_ref)
    if art is None:
        raise HTTPException(404, f"没有 {panel_ref} 的提示词产物（先跑 S3）")
    payload = {**(art.payload or {})}
    for k in ("prompt_pos", "prompt_neg", "loras", "seed", "width", "height", "params"):
        if k in body:
            payload[k] = body[k]
    new = A.create(session, project_id=project_id, kind=ArtifactKind.PANEL_PROMPT.value,
                   ref=panel_ref, payload=payload, inputs=[art],
                   status=ArtifactStatus.REVIEW.value)
    session.commit()
    return {"ok": True, "artifact_id": new.id, "version": new.version}


@router.post("/projects/{project_id}/panel-prompts/approve-all")
def approve_all_panel_prompts(project_id: int, body: dict | None = None, session: Session = Depends(get_session)) -> dict:
    """一键审核：把该项目所有“待审查”的分镜提示词置为通过。

    body 可带 ``page_ref`` 限定只审某一页。
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    page_ref = (body or {}).get("page_ref")
    reviews = session.scalars(
        select(Artifact).where(
            Artifact.project_id == project_id,
            Artifact.kind == ArtifactKind.PANEL_PROMPT.value,
            Artifact.is_current.is_(True),
            Artifact.status == ArtifactStatus.REVIEW.value,
        )
    ).all()
    n = 0
    for a in reviews:
        if page_ref:
            try:
                pno = int(a.ref.split(":", 1)[1].split(".", 1)[0])
            except (IndexError, ValueError):
                continue
            if f"page:{pno}" != page_ref:
                continue
        A.set_status(session, a, ArtifactStatus.APPROVED.value)
        n += 1
    session.commit()
    return {"ok": True, "approved": n}


@router.post("/projects/{project_id}/page-images/approve-all")
def approve_all_page_images(project_id: int, body: dict | None = None, session: Session = Depends(get_session)) -> dict:
    """一键审核：把该项目所有“待审查”的**该页成品**置为通过。

    成品包含两类：整页成图（S5 后台合成）与「编辑中」画布（MED 存档），
    只要其中一种处于“待审”，就一并通过。body 可带 ``page_ref`` 限定只审某一页。
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    page_ref = (body or {}).get("page_ref")
    reviews = session.scalars(
        select(Artifact).where(
            Artifact.project_id == project_id,
            Artifact.kind.in_((ArtifactKind.PAGE_IMAGE.value, ArtifactKind.MED_DOC.value)),
            Artifact.is_current.is_(True),
            Artifact.status == ArtifactStatus.REVIEW.value,
        )
    ).all()
    n = 0
    for a in reviews:
        if page_ref and a.ref != page_ref:
            continue
        A.set_status(session, a, ArtifactStatus.APPROVED.value)
        n += 1
    session.commit()
    return {"ok": True, "approved": n}


@router.post("/projects/{project_id}/prompt-board/run-page/{page_ref}")
def run_prompt_page(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """只给某一页跑 S3（生成该页每一格的提示词）。"""
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    rd = readiness(project_id, session)
    info = rd.get("S3") or {}
    if not info.get("ready", True):
        raise HTTPException(400, f"前置条件未满足：{info.get('missing', '请先完成前一阶段')}")
    job = jobq.enqueue("prompt", project_id=project_id, stage="S3",
                       payload={"project_id": project_id, "page_ref": page_ref})
    return {"job_id": job.id, "page_ref": page_ref}


@router.post("/projects/{project_id}/pages/{page_ref}/auto")
def auto_page(project_id: int, page_ref: str, body: dict, session: Session = Depends(get_session)) -> dict:
    """让 AI 为**这一页**挑模板并写分格（同步执行）。"""
    import json as _json

    from ...llm import LLMClient, LLMLogContext
    from ...schemas import Storyboard
    from ...stages import promptlib, prose

    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    novel = prose.novel_text(session, project_id, only_approved=True)
    if not novel.strip():
        raise HTTPException(400, "前置条件未满足：还没有「已审核通过」的正文。请到「正文」页写并点「通过」，然后才能分格。")

    try:
        no = int(page_ref.split(":", 1)[1])
    except (IndexError, ValueError):
        raise HTTPException(400, f"页 ref 不合法：{page_ref}") from None
    total = int(body.get("total_pages") or project.target_pages or 1)

    provider, cfg = promptlib.resolve_provider(session, "S2")
    client = LLMClient(cfg)
    system, user_tpl = promptlib.get_prompt(session, "s2_script")
    tpl_menu = _json.dumps(
        [{"id": r.id, "dir": r.dir, "panels": r.panels_count, "desc": r.layout_desc}
         for r in session.scalars(select(Template).order_by(Template.dir, Template.panels_count)).all()],
        ensure_ascii=False)
    techs = _json.dumps(
        {x.name: x.prompt_block for x in session.scalars(select(Technique).where(Technique.enabled.is_(True))).all()},
        ensure_ascii=False)
    user = promptlib.render(user_tpl, {
        "NOVEL": novel, "START_PAGE": no, "END_PAGE": no,
        "TOTAL_PAGES": total, "TEMPLATE_MENU": tpl_menu, "TECHNIQUES": techs,
    })
    log = LLMLogContext(session=session, stage="S2", project_id=project_id, provider_id=provider.id)
    try:
        board: Storyboard = client.structured(
            [{"role": "system", "content": system}, {"role": "user", "content": user}], Storyboard, log=log)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AI 生成失败：{e}") from e

    got = board.pages[0] if board.pages else None
    if got is None:
        raise HTTPException(502, "AI 没有返回任何页")
    tpl = session.get(Template, got.template_id)
    if tpl is None:
        raise HTTPException(502, f"AI 选了不存在的模板：{got.template_id}")

    panels = [p.model_dump() for p in got.panels][: tpl.panels_count]
    while len(panels) < tpl.panels_count:
        panels.append({"panel_order": len(panels) + 1, "role": "medium", "shot": "medium",
                       "characters": [], "action": "", "scene_desc": "", "dialogue": "",
                       "bubble_type": "none", "technique": []})
    for i, p in enumerate(panels, start=1):
        p["panel_order"] = i

    art = A.create(session, project_id=project_id, kind=ArtifactKind.PAGE_SCRIPT.value, ref=page_ref,
                   payload={"scene_id": 0, "page_index": no, "template_id": tpl.id,
                            "panels": panels, "geometry": tpl.geometry, "source": "ai"},
                   status=ArtifactStatus.REVIEW.value)
    session.commit()
    return {"ok": True, "page_ref": page_ref, "template_id": tpl.id,
            "template_desc": tpl.layout_desc, "panels_count": tpl.panels_count, "version": art.version}


@router.delete("/projects/{project_id}/pages/{page_ref}")
def delete_page(project_id: int, page_ref: str, session: Session = Depends(get_session)) -> dict:
    """删除该页分格脚本（连同其所有版本与相关血缘）。"""
    art = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if art is None:
        raise HTTPException(404, f"没有该页：{page_ref}")
    ids = [x.id for x in A.versions_of(session, project_id, art.kind, art.ref)]
    session.execute(delete(ArtifactEdge).where(
        or_(ArtifactEdge.from_artifact_id.in_(ids), ArtifactEdge.to_artifact_id.in_(ids))))
    session.execute(delete(Artifact).where(Artifact.id.in_(ids)))
    session.commit()
    return {"ok": True, "deleted": len(ids), "page_ref": page_ref}


@router.get("/projects/{project_id}/export-board")
def export_board(project_id: int, session: Session = Depends(get_session)) -> dict:
    """导出页面清单与历史版本，预览顺序和实际成册顺序一致。"""
    from ...storage import StorageError, resolve_project_path
    from ...stages.book import _page_no

    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    images = {a.ref: a for a in A.all_current(session, project_id, ArtifactKind.PAGE_IMAGE.value)}
    refs = set(images) | {a.ref for a in A.all_current(session, project_id, ArtifactKind.PAGE_SCRIPT.value)}
    pages = []
    for ref in sorted(refs, key=_page_no):
        image = images.get(ref)
        available = False
        file_state = "not_created"
        if image and image.path:
            try:
                resolve_project_path(image.path, project_id)
                available, file_state = True, "available"
            except FileNotFoundError:
                file_state = "missing"
            except StorageError:
                file_state = "blocked"
        included = bool(available and image.status == ArtifactStatus.APPROVED.value) if image else False
        pages.append({"ref": ref, "page_index": _page_no(ref), "artifact_id": image.id if image else None,
                      "version": image.version if image else None, "status": image.status if image else "pending",
                      "image_url": f"/api/artifacts/{image.id}/file" if available else "",
                      "file_state": file_state, "included": included})
    books = A.versions_of(session, project_id, ArtifactKind.BOOK.value, "book")
    history = []
    for artifact in books:
        payload = artifact.payload or {}
        files = payload.get("files") or {}
        formats = [fmt for fmt in ("pdf", "cbz") if (isinstance(files, dict) and files.get(fmt))
                   or artifact.path.lower().endswith(f".{fmt}")]
        history.append({"id": artifact.id, "version": artifact.version, "status": artifact.status,
                        "is_current": artifact.is_current, "pages": payload.get("pages", 0),
                        "formats": formats, "created_at": artifact.created_at.isoformat() if artifact.created_at else None})
    history.sort(key=lambda item: item["version"], reverse=True)
    blocked = any(page["status"] == "approved" and page["file_state"] != "available" for page in pages)
    included = [page["artifact_id"] for page in pages if page["included"]]
    return {"project_id": project_id, "title": project.title, "target_pages": project.target_pages,
            "pages": pages, "history": history, "ready": bool(included) and not blocked,
            "page_artifact_ids": included,
            "hint": "已通过页的图片文件缺失或不可访问，请重新保存/合成后导出" if blocked else
                    ("" if included else "先在「分页合成」审核至少一页整页成图，再进行导出")}


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
    if stage == "S6" and (body or {}).get("format", "both") not in ("pdf", "cbz", "both"):
        raise HTTPException(400, "导出格式仅支持 pdf、cbz 或 both")

    # 前置条件硬校验：前置阶段没完成就不许跑，并明确告诉缺什么
    rd = readiness(project_id, session)
    info = rd.get(stage) or {}
    if not info.get("ready", True):
        raise HTTPException(400, f"前置条件未满足：{info.get('missing', '请先完成前一阶段')}")
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


@router.get("/stage-models")
def stage_models(session: Session = Depends(get_session)) -> dict:
    bindings = {row.stage: row.provider_id for row in session.scalars(select(StageModel)).all()}
    fallback = session.scalars(select(LLMProvider).where(LLMProvider.enabled.is_(True)).order_by(LLMProvider.id)).first()
    return {"scope": "global", "bindings": bindings, "fallback_provider_id": fallback.id if fallback else None}


@router.patch("/stage-models")
def update_stage_models(body: dict, session: Session = Depends(get_session)) -> dict:
    """阶段绑定作用于所有项目；空值取消显式绑定，使用默认启用供应商。"""
    validated = {}
    for stage, provider_id in body.items():
        if stage not in ("S1", "S2", "S3"):
            raise HTTPException(400, "只支持 S1 正文、S2 分格、S3 提示词的模型绑定")
        if isinstance(provider_id, bool) or (provider_id is not None and not isinstance(provider_id, (int, str))):
            raise HTTPException(400, "供应商 ID 无效")
        if provider_id is None or provider_id == 0 or provider_id == "":
            validated[stage] = None
            continue
        try:
            value = int(provider_id)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, "供应商 ID 无效") from e
        provider = session.get(LLMProvider, value)
        if provider is None or not provider.enabled:
            raise HTTPException(400, "请选择存在且启用的供应商")
        validated[stage] = value
    for stage, provider_id in validated.items():
        sm = session.get(StageModel, stage)
        if provider_id is None:
            if sm is not None:
                session.delete(sm)
            continue
        if sm is None:
            session.add(StageModel(stage=stage, provider_id=provider_id))
        else:
            sm.provider_id = provider_id
    session.commit()
    return {"ok": True, **stage_models(session)}


@router.patch("/projects/{project_id}/stage-models")
def set_stage_models(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """兼容原项目路径；返回 scope=global 明确现有表的真实作用域。"""
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    return update_stage_models(body, session)


@router.get("/projects/{project_id}/stale")
def stale_list(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    """列出所有因上游变更而待重跑（stale）的产物。"""
    out = []
    for stage, (kind, label) in STAGE_ARTIFACTS.items():
        for a in A.all_current(session, project_id, kind):
            if a.status == ArtifactStatus.STALE.value:
                out.append({"stage": stage, "kind": a.kind, "label": label, "ref": a.ref, "version": a.version})
    return out
