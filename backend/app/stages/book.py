"""S6 整册导出（原 S7）：把全部整页图合成 PDF / CBZ。

payload: {"project_id", "format": "pdf"|"cbz"|"both"}
产出：``BOOK`` 产物（ref="book"），path 指向导出文件。
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from sqlalchemy.orm import Session

from ..artifacts import all_current, create, set_status
from ..models import ArtifactKind, ArtifactStatus, Job, Project
from ..storage import new_output_dir, resolve_project_path, safe_filename

KIND = "book"


def _page_no(ref: str) -> int:
    try:
        return int(ref.split(":", 1)[1])
    except (IndexError, ValueError):
        return 10**9


def handle(session: Session, job: Job) -> dict:
    payload = job.payload or {}
    project_id = int(payload.get("project_id") or job.project_id or 0)
    fmt = payload.get("format", "both")
    if fmt not in ("pdf", "cbz", "both"):
        raise ValueError("导出格式仅支持 pdf、cbz 或 both")
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    def cancelled() -> bool:
        if job.id and job in session:
            session.refresh(job, ["cancel_requested"])
        return bool(job.cancel_requested)

    def progress(done: int, message: str) -> None:
        if job.id and job in session:
            job.total = 2 if fmt == "both" else 1
            job.progress = done
            job.message = message
            session.commit()

    if cancelled():
        return {"cancelled": True}

    pages = [a for a in all_current(session, project_id, ArtifactKind.PAGE_IMAGE.value) if a.path]
    approved = [a for a in pages if a.status == ArtifactStatus.APPROVED.value]
    use = approved or pages
    selected_ids = payload.get("page_artifact_ids")
    if selected_ids is not None:
        if not isinstance(selected_ids, list) or not selected_ids or any(type(value) is not int for value in selected_ids):
            raise ValueError("导出页清单无效，请刷新导出页面")
        selected = {a.id: a for a in approved}
        if len(set(selected_ids)) != len(selected_ids) or any(value not in selected for value in selected_ids):
            raise ValueError("导出页的版本或审核状态已变化，请刷新页面后重新导出")
        use = [selected[value] for value in selected_ids]
    use.sort(key=lambda a: _page_no(a.ref))
    if not use:
        raise ValueError("没有可导出的整页图（先跑 S5 分页合成）")

    pngs = []
    for a in use:
        try:
            pngs.append(resolve_project_path(a.path, project_id))
        except FileNotFoundError:
            raise ValueError(f"{a.ref} 的整页图片文件缺失，请重新保存或合成后导出") from None
    if not pngs:
        raise ValueError("页图文件缺失")
    out_dir = new_output_dir(project_id, "book")

    produced: dict = {}
    if fmt in ("pdf", "both"):
        progress(0, f"正在生成 PDF（{len(pngs)} 页）")
        pdf_path = out_dir / f"{_safe(project.title)}.pdf"
        _make_pdf(pngs, pdf_path)
        produced["pdf"] = str(pdf_path)
        if cancelled():
            return {"cancelled": True}
    if fmt in ("cbz", "both"):
        progress(len(produced), f"正在生成 CBZ（{len(pngs)} 页）")
        cbz_path = out_dir / f"{_safe(project.title)}.cbz"
        _make_cbz(pngs, cbz_path)
        produced["cbz"] = str(cbz_path)
        if cancelled():
            return {"cancelled": True}

    primary = produced.get("pdf") or produced.get("cbz") or ""
    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.BOOK.value,
        ref="book",
        payload={"pages": len(pngs), "files": produced, "page_refs": [a.ref for a in use]},
        path=primary,
        inputs=use,
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto":
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()
    progress(len(produced), f"已导出 {len(pngs)} 页 · {' + '.join(kind.upper() for kind in produced)}")
    return {"pages": len(pngs), "files": produced}


def _make_pdf(pngs: list[Path], out: Path) -> None:
    import img2pdf

    with open(out, "xb") as f:
        f.write(img2pdf.convert([str(p) for p in pngs]))


def _make_cbz(pngs: list[Path], out: Path) -> None:
    with zipfile.ZipFile(out, "x", zipfile.ZIP_DEFLATED) as z:
        for i, p in enumerate(pngs, start=1):
            z.write(p, arcname=f"{i:04d}_{p.name}")


def _safe(name: str) -> str:
    return safe_filename(name)
