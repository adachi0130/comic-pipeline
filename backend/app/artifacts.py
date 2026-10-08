"""产物版本化、血缘与失效传播。

对外只暴露少数几个函数，阶段代码不直接碰 ``Artifact`` 表：

- ``current(session, project_id, kind, ref)``     取某实体当前版
- ``all_current(session, project_id, kind)``      取某类产物全部当前版
- ``create(session, ..., inputs=[...])``          写一个新版本（自动串联血缘 + 失效下游）
- ``invalidate_downstream(session, artifact)``    沿血缘把下游标记 stale
- ``compute_source_hash(payload, inputs)``        输入指纹，用于判断“是否需要重跑”

设计要点：新版本创建时，旧版 ``is_current`` 置 False 但**保留**（可回退）；血缘边记录的是
**具体版本号**，因此“改了上游第 2 版”能精确定位到“下游基于第 2 版算出的产物作废”。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Artifact, ArtifactEdge, ArtifactStatus


def compute_source_hash(payload: dict | None, inputs: Sequence[Artifact] = ()) -> str:
    """输入指纹：自身负载 + 所有上游版本的 source_hash。

    上游任一变，本指纹变 -> 可据此判断是否真的需要重跑（避免无谓重算）。
    """
    parts = [
        json.dumps(payload or {}, ensure_ascii=False, sort_keys=True),
    ]
    for a in sorted(inputs, key=lambda x: x.id):
        parts.append(f"{a.kind}:{a.ref}:v{a.version}:{a.source_hash}")
    return hashlib.sha256("||".join(parts).encode("utf-8")).hexdigest()[:32]


def current(session: Session, project_id: int, kind: str, ref: str) -> Artifact | None:
    stmt = (
        select(Artifact)
        .where(
            Artifact.project_id == project_id,
            Artifact.kind == kind,
            Artifact.ref == ref,
            Artifact.is_current.is_(True),
        )
        .order_by(Artifact.version.desc())
    )
    return session.scalars(stmt).first()


def all_current(
    session: Session,
    project_id: int,
    kind: str,
    *,
    ref_prefix: str | None = None,
) -> list[Artifact]:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.kind == kind,
        Artifact.is_current.is_(True),
    )
    if ref_prefix:
        stmt = stmt.where(Artifact.ref.like(f"{ref_prefix}%"))
    rows = list(session.scalars(stmt))
    return rows


def versions_of(session: Session, project_id: int, kind: str, ref: str) -> list[Artifact]:
    stmt = (
        select(Artifact)
        .where(Artifact.project_id == project_id, Artifact.kind == kind, Artifact.ref == ref)
        .order_by(Artifact.version.desc())
    )
    return list(session.scalars(stmt))


def create(
    session: Session,
    *,
    project_id: int,
    kind: str,
    ref: str,
    payload: dict | None = None,
    path: str = "",
    inputs: Sequence[Artifact] = (),
    status: str = ArtifactStatus.PENDING.value,
    invalidate: bool = True,
) -> Artifact:
    """写一个新版本。

    - 旧版置 ``is_current=False``（保留，可回退）
    - 与 ``inputs`` 的**当前版**建立血缘边
    - ``invalidate=True`` 时，沿旧版血缘把下游标记 stale
    """
    old = current(session, project_id, kind, ref)
    if old is not None:
        old.is_current = False

    src_hash = compute_source_hash(payload, inputs)
    new_version = (old.version + 1) if old else 1

    art = Artifact(
        project_id=project_id,
        kind=kind,
        ref=ref,
        version=new_version,
        is_current=True,
        status=status,
        payload=payload or {},
        path=path,
        source_hash=src_hash,
    )
    session.add(art)
    session.flush()  # 拿到 art.id

    for up in inputs:
        _add_edge(session, project_id, up, art)

    if invalidate and old is not None and old.source_hash != src_hash:
        invalidate_downstream(session, old)

    return art


def _add_edge(session: Session, project_id: int, src: Artifact, dst: Artifact) -> None:
    exists = session.scalars(
        select(ArtifactEdge).where(
            ArtifactEdge.from_artifact_id == src.id,
            ArtifactEdge.to_artifact_id == dst.id,
        )
    ).first()
    if exists:
        return
    session.add(
        ArtifactEdge(
            project_id=project_id,
            from_artifact_id=src.id,
            to_artifact_id=dst.id,
            relation="input",
        )
    )


def downstream(
    session: Session,
    artifact: Artifact,
    *,
    include_self: bool = False,
) -> list[Artifact]:
    """BFS 求某**实体**的全部下游产物（去重，含跨层）。

    注意：血缘边挂在“具体版本”上（上游 v1 -> 下游）。因此查询某实体时，起点取
    该实体**所有版本**的 id，否则刚创建的新版（还没被下游引用）会查不到下游。
    这正是“改了正文 v2，哪些产出作废”的语义。
    """
    root_ids = [a.id for a in versions_of(session, artifact.project_id, artifact.kind, artifact.ref)]

    seen: set[int] = set(root_ids)
    frontier: list[int] = list(root_ids)
    out: list[Artifact] = []
    if include_self:
        out.extend(session.scalars(select(Artifact).where(Artifact.id.in_(root_ids))).all())

    while frontier:
        rows = session.scalars(
            select(ArtifactEdge).where(ArtifactEdge.from_artifact_id.in_(frontier))
        ).all()
        next_ids = [e.to_artifact_id for e in rows]
        next_ids = [i for i in next_ids if i not in seen]
        if not next_ids:
            break
        seen.update(next_ids)
        arts = session.scalars(select(Artifact).where(Artifact.id.in_(next_ids))).all()
        out.extend(arts)
        frontier = next_ids
    return out


def invalidate_downstream(session: Session, artifact: Artifact) -> int:
    """把下游产物标记为 ``stale``（只影响当前版）。返回受影响数量。"""
    affected = 0
    for art in downstream(session, artifact):
        if not art.is_current:
            continue
        if art.status in (ArtifactStatus.APPROVED.value, ArtifactStatus.REVIEW.value,
                          ArtifactStatus.PENDING.value, ArtifactStatus.RUNNING.value,
                          ArtifactStatus.FAILED.value, ArtifactStatus.REJECTED.value):
            art.status = ArtifactStatus.STALE.value
            affected += 1
    return affected


def set_status(
    session: Session,
    artifact: Artifact,
    status: str,
    *,
    comment: str = "",
) -> Artifact:
    from .models import utcnow  # 局部导入，避免循环

    artifact.status = status
    if comment:
        artifact.review_comment = comment
    if status in (ArtifactStatus.APPROVED.value, ArtifactStatus.REJECTED.value):
        artifact.reviewed_at = utcnow()
    return artifact


def stale_or_new(
    session: Session,
    project_id: int,
    kind: str,
    ref: str,
    payload: dict | None = None,
    inputs: Iterable[Artifact] = (),
) -> bool:
    """判断是否需要重跑：不存在 / stale / 输入指纹变化。"""
    art = current(session, project_id, kind, ref)
    if art is None:
        return True
    if art.status == ArtifactStatus.STALE.value:
        return True
    return art.source_hash != compute_source_hash(payload, list(inputs))
