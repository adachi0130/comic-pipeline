"""数据库会话与初始化。"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .models import Base

_settings = get_settings()

# SQLite 需要 check_same_thread=False 才能配合线程池（作业队列）。
_connect_args = {"check_same_thread": False} if _settings.resolved_db_url.startswith("sqlite") else {}

engine = create_engine(
    _settings.resolved_db_url,
    connect_args=_connect_args,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def init_db() -> None:
    """建表（M0 用；正式迁移走 Alembic）。"""
    Base.metadata.create_all(bind=engine)


def get_session() -> Iterator[Session]:
    """FastAPI 依赖注入用。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
