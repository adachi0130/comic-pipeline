"""产物版本化、血缘与失效传播的自测（内存 SQLite）。

运行：``.venv/Scripts/python.exe tests/test_artifacts.py``
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app import artifacts as A  # noqa: E402
from app.models import ArtifactKind, ArtifactStatus, Base, Project  # noqa: E402


def _make_session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, future=True)


def test_versioning_and_invalidation() -> None:
    s = _make_session()
    proj = Project(title="测试漫画", outline="", target_pages=4)
    s.add(proj)
    s.flush()
    pid = proj.id

    # S2 正文现场景 1
    prose = A.create(s, project_id=pid, kind=ArtifactKind.PROSE.value, ref="scene:1",
                     payload={"text": "初稿正文"}, status=ArtifactStatus.REVIEW.value)
    # S3 页脚本依赖正文
    page = A.create(s, project_id=pid, kind=ArtifactKind.PAGE_SCRIPT.value, ref="page:1",
                    payload={"template_id": "vertical:a", "panels": 1},
                    inputs=[prose], status=ArtifactStatus.REVIEW.value)
    # S4 提示词依赖页脚本
    prompt = A.create(s, project_id=pid, kind=ArtifactKind.PANEL_PROMPT.value, ref="panel:1.1",
                      payload={"prompt_pos": "1girl"}, inputs=[page], status=ArtifactStatus.APPROVED.value)
    # S5 图依赖提示词
    img = A.create(s, project_id=pid, kind=ArtifactKind.IMAGE.value, ref="panel:1.1",
                   payload={"candidates": [{"index": 0}]}, inputs=[prompt],
                   status=ArtifactStatus.APPROVED.value)

    assert A.current(s, pid, ArtifactKind.PROSE.value, "scene:1").version == 1

    # 正文改一版 -> 下游（页/提示词/图）应全部转 stale
    prose_v2 = A.create(s, project_id=pid, kind=ArtifactKind.PROSE.value, ref="scene:1",
                        payload={"text": "修改后的正文"}, status=ArtifactStatus.REVIEW.value)
    assert prose_v2.version == 2
    s.flush()

    for art, name in ((page, "页脚本"), (prompt, "提示词"), (img, "图")):
        s.refresh(art)
        assert art.status == ArtifactStatus.STALE.value, f"{name} 应转 stale，实际 {art.status}"

    # 旧版保留、当前版指向新版
    versions = A.versions_of(s, pid, ArtifactKind.PROSE.value, "scene:1")
    assert [v.version for v in versions] == [2, 1]
    assert sum(1 for v in versions if v.is_current) == 1
    print("  [ok] 版本递增 + 沿血缘把下游标 stale + 旧版保留")

    # 下游查询
    down = {d.ref for d in A.downstream(s, prose_v2)}
    assert {"page:1", "panel:1.1"} <= down, down
    print("  [ok] downstream 血缘查询正确")

    # 内容未变则不重复失效
    v3 = A.create(s, project_id=pid, kind=ArtifactKind.PROSE.value, ref="scene:1",
                  payload={"text": "修改后的正文"}, status=ArtifactStatus.REVIEW.value)
    s.flush()
    assert v3.source_hash == prose_v2.source_hash, "相同内容应得到相同指纹"
    print("  [ok] 相同内容指纹一致（可用于跳过无谓重跑）")


if __name__ == "__main__":
    print("产物版本化自测：")
    test_versioning_and_invalidation()
    print("全部通过 ✅")
