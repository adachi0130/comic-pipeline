"""S6 整册导出（原 S7）：把全部整页图合成 PDF / CBZ。

payload: {"project_id", "format": "pdf"|"cbz"|"both"}
产出：``BOOK`` 产物（ref="book"），path 指向导出文件。
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from sqlalchemy.orm import Session

from ..artifacts import all_current, create, set_status
from ..config import get_settings
from ..models import ArtifactKind, ArtifactStatus, Job, Project

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
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"项目不存在：{project_id}")

    pages = [a for a in all_current(session, project_id, ArtifactKind.PAGE_IMAGE.value) if a.path]
    approved = [a for a in pages if a.status == ArtifactStatus.APPROVED.value]
    use = approved or pages
    use.sort(key=lambda a: _page_no(a.ref))
    if not use:
        raise ValueError("没有可导出的整页图（先跑 S5 分页合成）")

    out_dir = get_settings().data_dir / "projects" / str(project_id) / "book"
    out_dir.mkdir(parents=True, exist_ok=True)
    pngs = [Path(a.path) for a in use if Path(a.path).exists()]
    if not pngs:
        raise ValueError("页图文件缺失")

    produced: dict = {}
    if fmt in ("pdf", "both"):
        pdf_path = out_dir / f"{_safe(project.title)}.pdf"
        _make_pdf(pngs, pdf_path)
        produced["pdf"] = str(pdf_path)
    if fmt in ("cbz", "both"):
        cbz_path = out_dir / f"{_safe(project.title)}.cbz"
        _make_cbz(pngs, cbz_path)
        produced["cbz"] = str(cbz_path)

    primary = produced.get("pdf") or produced.get("cbz") or ""
    art = create(
        session,
        project_id=project_id,
        kind=ArtifactKind.BOOK.value,
        ref="book",
        payload={"pages": len(pngs), "files": produced},
        path=primary,
        inputs=use,
        status=ArtifactStatus.REVIEW.value,
    )
    if project.review_mode == "auto":
        set_status(session, art, ArtifactStatus.APPROVED.value)
    session.commit()
    return {"pages": len(pngs), "files": produced}


def _make_pdf(pngs: list[Path], out: Path) -> None:
    import img2pdf

    with open(out, "wb") as f:
        f.write(img2pdf.convert([str(p) for p in pngs]))


def _make_cbz(pngs: list[Path], out: Path) -> None:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for i, p in enumerate(pngs, start=1):
            z.write(p, arcname=f"{i:04d}_{p.name}")


def _safe(name: str) -> str:
    return "".join(c for c in name if c not in '\\/:*?"<>|').strip() or "comic"
