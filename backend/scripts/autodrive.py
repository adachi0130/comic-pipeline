"""无头自动驾驶：不经前端、直接串起 S1→S4→(S5)→S6→S7。

用法（项目根，需后端未占用 MED 桥所需的静态目录；本脚本自起静态服务器）：
    .venv/Scripts/python.exe backend/scripts/autodrive.py --project 1

行为：
- S1/S3/S4 走 LLM（需已配置供应商）；
- S5 走 ComfyUI（需可达；不可达则跳过并提示）；
- S6 走 MED 桥（无头 Chromium 驱动 PageComposer）；
- S7 导出 PDF/CBZ。
把项目 review_mode 设为 auto 即全程无人值守。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app import jobs as jobq  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.models import ArtifactKind, Job, JobStatus, Project  # noqa: E402
from app.stages import register_all  # noqa: E402


def run_job(kind: str, project_id: int, stage: str, payload: dict, *, timeout_s: float = 600.0) -> Job:
    """同步跑一个作业（未启动调度器时 enqueue 会同步执行）。"""
    register_all()
    job = jobq.enqueue(kind, project_id=project_id, stage=stage, payload=payload)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        session = SessionLocal()
        try:
            j = session.get(Job, job.id)
            if j and j.status in (JobStatus.DONE.value, JobStatus.FAILED.value, JobStatus.CANCELLED.value):
                return j
        finally:
            session.close()
        time.sleep(0.5)
    raise TimeoutError(f"作业超时：{kind}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", type=int, required=True)
    ap.add_argument("--scene", type=int, default=1)
    ap.add_argument("--pages", type=int, default=1, help="本场生成页数")
    ap.add_argument("--skip-image", action="store_true", help="跳过 S5（无 ComfyUI 时）")
    ap.add_argument("--format", default="both")
    args = ap.parse_args()

    init_db()
    session = SessionLocal()
    try:
        p = session.get(Project, args.project)
        if p is None:
            print(f"项目不存在：{args.project}")
            return 2
        p.review_mode = "auto"  # 全自动
        session.commit()
        print(f"项目《{p.title}》目标 {p.target_pages} 页，已切全自动")
    finally:
        session.close()

    steps = [
        ("script", "S2", {"batch_pages": args.pages}),
        ("prompt", "S3", {}),
    ]
    for kind, stage, payload in steps:
        print(f"[{stage}] 运行…")
        job = run_job(kind, args.project, stage, {"project_id": args.project, **payload})
        print(f"[{stage}] {job.status} — {job.result or job.error[:200]}")

    # S5：逐格出图（每格取 S4 提示词）
    if not args.skip_image:
        session = SessionLocal()
        try:
            refs = [a.ref for a in __import__("app.artifacts", fromlist=["all_current"]).all_current(
                session, args.project, ArtifactKind.PANEL_PROMPT.value)]
        finally:
            session.close()
        for ref in refs:
            print(f"[S4] 出图 {ref}…")
            job = run_job("image", args.project, "S4", {"project_id": args.project, "panel_ref": ref, "count": 1})
            print(f"[S4] {ref} -> {job.status}")
    else:
        print("[S4] 已跳过")

    # S6：逐页合成
    session = SessionLocal()
    try:
        page_refs = [a.ref for a in __import__("app.artifacts", fromlist=["all_current"]).all_current(
            session, args.project, ArtifactKind.PAGE_SCRIPT.value)]
    finally:
        session.close()
    for ref in page_refs:
        print(f"[S5] 合成 {ref}…")
        job = run_job("compose", args.project, "S5", {"project_id": args.project, "page_ref": ref})
        print(f"[S5] {ref} -> {job.status} {job.result or job.error[:200]}")

    # S7：导出
    print("[S6] 导出整册…")
    job = run_job("book", args.project, "S6", {"project_id": args.project, "format": args.format})
    print(f"[S6] {job.status} — {job.result or job.error[:200]}")
    return 0 if job.status == JobStatus.DONE.value else 1


if __name__ == "__main__":
    raise SystemExit(main())
