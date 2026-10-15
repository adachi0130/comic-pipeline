"""流水线的实际产物快照：正文 → 分格 → 格图 → 整页 → 成册。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Artifact, Job, Project, Template
from .storage import StorageError, resolve_project_path


def available(raw, project_id: int) -> bool:
    try:
        resolve_project_path(raw, project_id)
        return True
    except (StorageError, OSError, TypeError):
        return False


def brief(artifact) -> dict | None:
    if artifact is None:
        return None
    return {"id": artifact.id, "ref": artifact.ref, "version": artifact.version, "status": artifact.status}


def page_number(ref: str) -> int:
    try:
        return int(ref.split(":", 1)[1])
    except (ValueError, IndexError):
        return 10**9


def snapshot(session: Session, project: Project) -> dict:
    from .api.routes.jobs import _brief as job_brief

    artifacts = session.scalars(select(Artifact).where(Artifact.project_id == project.id, Artifact.is_current.is_(True))).all()
    by_kind: dict[str, dict] = {}
    for art in artifacts:
        by_kind.setdefault(art.kind, {})[art.ref] = art
    templates = {tpl.id: tpl for tpl in session.scalars(select(Template)).all()}
    scripts = by_kind.get("page_script", {})
    page_images = by_kind.get("page_image", {})
    documents = by_kind.get("med_doc", {})
    prompts = by_kind.get("panel_prompt", {})
    images = by_kind.get("image", {})
    prose = [{**brief(art), "text": (art.payload or {}).get("text") or ""}
             for art in sorted(by_kind.get("prose", {}).values(), key=lambda art: page_number(art.ref))]
    pages = []
    for ref in sorted(set(scripts) | set(page_images) | set(documents), key=page_number):
        script = scripts.get(ref)
        payload = (script.payload or {}) if script else {}
        template = templates.get(payload.get("template_id"))
        geometry = payload.get("geometry") or (template.geometry if template else {}) or {}
        panels = []
        for panel in sorted(payload.get("panels") or [], key=lambda item: item.get("panel_order") or 0):
            order = panel.get("panel_order")
            panel_ref = f"panel:{page_number(ref)}.{order}"
            prompt, image = prompts.get(panel_ref), images.get(panel_ref)
            image_payload = (image.payload or {}) if image else {}
            candidates = image_payload.get("candidates") or []
            valid = [index for index, candidate in enumerate(candidates)
                     if isinstance(candidate, dict) and available(candidate.get("path"), project.id)]
            selected = image_payload.get("selected_index")
            adopted = type(selected) is int and selected in valid
            preview_index = selected if adopted else (valid[0] if valid else None)
            panels.append({"ref": panel_ref, "order": order, "shot": panel.get("shot") or "",
                           "action": panel.get("action") or "", "dialogue": panel.get("dialogue") or "",
                           "prompt": brief(prompt), "image": brief(image), "candidate_count": len(candidates),
                           "selected": adopted, "approved_image": adopted and image.status == "approved",
                           "preview_kind": "selected" if adopted else "candidate" if valid else "empty",
                           "image_url": f"/api/artifacts/{image.id}/candidate/{preview_index}" if preview_index is not None else ""})
        whole, doc = page_images.get(ref), documents.get(ref)
        whole_available = bool(whole and available(whole.path, project.id))
        newer_inputs = bool(whole and any(art and art.created_at > whole.created_at for art in
                            [script, *[prompts.get(panel["ref"]) for panel in panels], *[images.get(panel["ref"]) for panel in panels]]))
        pages.append({"ref": ref, "index": page_number(ref), "script": brief(script),
                      "layout_desc": template.layout_desc if template else "", "template_id": payload.get("template_id"),
                      "canvas": geometry.get("canvas") or [672, 950], "geometry": geometry.get("panels") or [],
                      "panels": panels, "page_image": brief(whole), "med_doc": brief(doc),
                      "page_image_url": f"/api/artifacts/{whole.id}/file" if whole_available else "",
                      "composable": bool(script and script.status == "approved" and panels and all(panel["approved_image"] for panel in panels)),
                      "needs_update": newer_inputs or any(art and art.status == "stale" for art in (script, whole)) or
                                      any((panel["prompt"] or {}).get("status") == "stale" or (panel["image"] or {}).get("status") == "stale" for panel in panels)})
    book = by_kind.get("book", {}).get("book")
    downloads = []
    if book:
        files = (book.payload or {}).get("files") or {}
        for fmt in ("pdf", "cbz"):
            raw = files.get(fmt) if isinstance(files, dict) else None
            raw = raw or (book.path if book.path.lower().endswith("." + fmt) else None)
            if available(raw, project.id):
                downloads.append({"format": fmt, "url": f"/api/artifacts/{book.id}/download/{fmt}"})
    active = session.scalars(select(Job).where(Job.project_id == project.id, Job.status.in_(("queued", "running")))).all()
    recent = session.scalars(select(Job).where(Job.project_id == project.id).order_by(Job.id.desc()).limit(30)).all()
    jobs = sorted({job.id: job for job in [*recent, *active]}.values(), key=lambda job: job.id, reverse=True)
    all_panels = [panel for page in pages for panel in page["panels"]]
    return {"project_id": project.id, "title": project.title, "target_pages": project.target_pages,
            "prose": prose, "pages": pages, "book": {**brief(book), "downloads": downloads} if book else None,
            "summary": {"prose_chars": sum(len(row["text"]) for row in prose), "pages": len(scripts), "panels": len(all_panels),
                        "with_image": sum(bool(panel["image_url"]) for panel in all_panels),
                        "selected": sum(panel["approved_image"] for panel in all_panels),
                        "composed": sum(bool(page["page_image_url"]) and not page["needs_update"] for page in pages)},
            "jobs": [job_brief(job) for job in jobs]}
