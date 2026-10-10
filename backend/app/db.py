"""数据库会话与初始化。"""

from __future__ import annotations

import logging
from collections.abc import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .models import Base

log = logging.getLogger("comic.db")

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
    _ensure_columns()


# 轻量迁移：给已存在的表补上新加的列（SQLite 的 create_all 不会改已有表）。
# 只做“加列”，不做改类型/删列——够本项目滚动开发用；正式环境仍以 Alembic 为准。
_ADDED_COLUMNS = {
    "characters": {"trigger_words": "TEXT DEFAULT ''"},
    "prompt_presets": {"loras": "JSON DEFAULT '[]'"},
}


def _ensure_columns() -> None:
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table, cols in _ADDED_COLUMNS.items():
            if table not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table)}
            for col, ddl in cols.items():
                if col in have:
                    continue
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{col}" {ddl}'))
                log.info("轻量迁移：%s 表补列 %s", table, col)


def get_session() -> Iterator[Session]:
    """FastAPI 依赖注入用。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
