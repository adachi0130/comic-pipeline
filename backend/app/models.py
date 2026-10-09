"""数据库模型（SQLAlchemy 2.0 声明式）。

核心设计：**产物版本化 + 血缘**
- ``Artifact``：一条“某实体的某一版”，实体用 ``ref`` 稳定标识（如 ``page:3``、``panel:3.2``），
  ``is_current`` 标记当前版。覆盖 S1–S7 全部产物（结构 / 正文 / 页脚本 / 提示词 / 图 / 页图 / 成书）。
- ``ArtifactEdge``：版本级血缘（from=上游版本 -> to=下游版本，relation='input'）。
  上游更新时沿血缘把下游标记 ``stale``，实现“只重跑受影响部分”。

其余表：模板菜单、技法库、LLM 供应商与调用留痕、持久作业队列、LoRA 选择、角色资产库。
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# --------------------------------------------------------------------------
# 枚举（用 str 存储，SQLite 友好）
# --------------------------------------------------------------------------
class ArtifactStatus(str, enum.Enum):
    PENDING = "pending"        # 待生成
    RUNNING = "running"        # 生成中
    REVIEW = "review"          # 待审
    APPROVED = "approved"      # 通过
    REJECTED = "rejected"      # 驳回返工
    STALE = "stale"            # 上游已变，待重跑
    FAILED = "failed"          # 生成失败


class ArtifactKind(str, enum.Enum):
    STRUCTURE = "structure"    # S1 章/场规划
    PROSE = "prose"            # S2 正文（按场）
    PAGE_SCRIPT = "page_script"  # S3 每页分格脚本
    PANEL_PROMPT = "panel_prompt"  # S4 每格提示词
    IMAGE = "image"            # S5 每格候选图
    PAGE_IMAGE = "page_image"  # S6 合成页图
    BOOK = "book"              # S7 成册导出


class JobStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


# --------------------------------------------------------------------------
class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    outline: Mapped[str] = mapped_column(Text, default="")      # 故事大纲（纯文本）
    target_pages: Mapped[int] = mapped_column(Integer, default=16)
    style_config: Mapped[dict] = mapped_column(JSON, default=dict)
    page_spec: Mapped[dict] = mapped_column(JSON, default=dict)
    review_mode: Mapped[str] = mapped_column(String(16), default="manual")  # auto / manual
    select_strategy: Mapped[str] = mapped_column(String(32), default="first")
    candidates_per_panel: Mapped[int] = mapped_column(Integer, default=4)
    # 出图参数（项目级默认，单格可覆盖）
    gen_params: Mapped[dict] = mapped_column(JSON, default=dict)
    # 酒馆绑定：角色卡 / 世界书 / 预设
    tavern_binding: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    artifacts: Mapped[list["Artifact"]] = relationship(back_populates="project")


class Artifact(Base):
    """版本化产物：一行 = (实体 ref, 版本)。"""

    __tablename__ = "artifacts"
    __table_args__ = (
        UniqueConstraint("project_id", "kind", "ref", "version", name="uq_artifact_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    ref: Mapped[str] = mapped_column(String(128), index=True)   # 稳定实体键，如 page:3 / panel:3.2
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default=ArtifactStatus.PENDING.value)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    path: Mapped[str] = mapped_column(String(512), default="")   # 大对象（图）落盘路径
    source_hash: Mapped[str] = mapped_column(String(64), default="")  # 输入指纹，用于判断是否需重跑
    review_comment: Mapped[str] = mapped_column(Text, default="")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped["Project"] = relationship(back_populates="artifacts")


class ArtifactEdge(Base):
    """血缘边：上游版本 -> 下游版本。"""

    __tablename__ = "artifact_edges"
    __table_args__ = (
        UniqueConstraint("from_artifact_id", "to_artifact_id", name="uq_edge"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    from_artifact_id: Mapped[int] = mapped_column(ForeignKey("artifacts.id"), index=True)
    to_artifact_id: Mapped[int] = mapped_column(ForeignKey("artifacts.id"), index=True)
    relation: Mapped[str] = mapped_column(String(32), default="input")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Template(Base):
    """MED 版式模板菜单（离线解析 69 个模板生成）。"""

    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)   # 如 vertical:ab_2_0
    dir: Mapped[str] = mapped_column(String(16))                    # vertical / landscape
    panels_count: Mapped[int] = mapped_column(Integer)
    layout_desc: Mapped[str] = mapped_column(Text, default="")      # LLM 可读的版式描述
    svg_path: Mapped[str] = mapped_column(String(256), default="")  # svg 全文落盘路径
    geometry: Mapped[dict] = mapped_column(JSON, default=dict)      # 每格形状/占比/出血
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Technique(Base):
    """漫画技法库：技法 -> 提示词词块 / MED 动作 / 是否 PS。"""

    __tablename__ = "techniques"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)   # 如 focus_line
    name: Mapped[str] = mapped_column(String(64))                   # 集中线
    stage: Mapped[str] = mapped_column(String(32))                  # 生效阶段，如 S3/S4/S6
    prompt_block: Mapped[str] = mapped_column(Text, default="")     # 拼进正向提示词的词块
    render_mode: Mapped[str] = mapped_column(String(32), default="prompt_only")
    # render_mode: med_focusline / med_speedline / med_tone / text / prompt_only / ps
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class LLMProvider(Base):
    """任意 OpenAI 兼容供应商（DashScope / DeepSeek / Kimi / 智谱 / OpenRouter / Ollama / vLLM …）。"""

    __tablename__ = "llm_providers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    base_url: Mapped[str] = mapped_column(String(256))
    api_key: Mapped[str] = mapped_column(String(256), default="")
    model: Mapped[str] = mapped_column(String(128))
    extra: Mapped[dict] = mapped_column(JSON, default=dict)   # temperature / json_mode 等
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # 按阶段指定用哪个供应商：{"S1": 1, "S3": 2, "S4": 2}
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StageModel(Base):
    """阶段 → LLM 供应商绑定：S1/S3/S4 可各用不同供应商与模型。"""

    __tablename__ = "stage_models"

    stage: Mapped[str] = mapped_column(String(8), primary_key=True)   # S1 / S3 / S4
    provider_id: Mapped[int] = mapped_column(ForeignKey("llm_providers.id"))


class LLMCall(Base):
    """每次 LLM 调用的原始留痕，换供应商后可横向对比。"""

    __tablename__ = "llm_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    stage: Mapped[str] = mapped_column(String(16), default="")
    provider_id: Mapped[int | None] = mapped_column(ForeignKey("llm_providers.id"), nullable=True)
    model: Mapped[str] = mapped_column(String(128), default="")
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    response: Mapped[str] = mapped_column(Text, default="")
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Job(Base):
    """持久作业队列：LLM / 出图都异步跑，不阻塞 HTTP。"""

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(32))     # prose / script / prompt / image / compose / book
    stage: Mapped[str] = mapped_column(String(16), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.QUEUED.value, index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Character(Base):
    """角色资产库：角色 id -> LoRA / 参考图 / 固定词块 / 权重。"""

    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    lora_name: Mapped[str] = mapped_column(String(256), default="")   # 出图后端上的 LoRA 文件名
    lora_weight: Mapped[float] = mapped_column(Float, default=0.8)
    use_lora: Mapped[bool] = mapped_column(Boolean, default=True)     # 可一键关掉角色 LoRA
    ref_image_path: Mapped[str] = mapped_column(String(512), default="")
    prompt_block: Mapped[str] = mapped_column(Text, default="")       # 固定角色描述词块
    notes: Mapped[str] = mapped_column(Text, default="")


class LoraSelection(Base):
    """LoRA 选择：项目级默认 + 单格覆盖。"""

    __tablename__ = "lora_selection"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    scope: Mapped[str] = mapped_column(String(16), default="project")  # project / panel
    panel_ref: Mapped[str] = mapped_column(String(64), default="")     # scope=panel 时的 panel:3.2
    lora_name: Mapped[str] = mapped_column(String(256))
    weight: Mapped[float] = mapped_column(Float, default=0.8)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
