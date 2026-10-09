"""全局配置。

分三层：
1. ``Settings``      —— 基础设施配置（路径 / 数据库 / ComfyUI / SSH 隧道 / 页面规格），
                        可用环境变量或 ``.env`` 覆盖。
2. ``WorkflowParams``—— Anima 文生图工作流的“参数映射表”（config/workflow_params.yaml），
                        换工作流只改这张表，不动代码。
3. 供应商 / 技法等业务数据放数据库，不在这里。

设计原则：本模块只负责“读配置并给出强类型对象”，不产生副作用。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# 项目根 = backend/app/config.py -> backend/app -> backend -> 项目根
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"
CONFIG_DIR = PROJECT_ROOT / "config"


class PageSpec(BaseModel):
    """漫画页面规格。

    实测（M0）：MED 竖版模板画布 = 704.24 × 996 px（比例 0.707，等于 B5 210×297mm），
    横版模板另算（如 landscape:1-1 = 745 × 526.77）。**每页真实画布尺寸以所选模板的
    `templates.geometry.canvas` 为准**，这里只给默认值。出图宽高比应据此计算，
    而不是固定方形。

    导出分辨率：MED 基础画布约 85 DPI，导出 300 DPI 时 multiplier ≈ 300/(704.24/210mm) ≈ 3.5。
    """

    name: str = "MED_B5_portrait"
    canvas_width: int = 704
    canvas_height: int = 996
    dpi: int = 300
    color_mode: Literal["rgb", "gray"] = "rgb"


class TunnelSettings(BaseModel):
    """仙宫云 SSH 隧道配置（把容器 8188 映射到本地）。

    不暴露公网：只在本机开 ``127.0.0.1:local_port -> 容器内 remote_port``。
    """

    enabled: bool = False
    ssh_host: str = ""
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_key_path: str = ""
    remote_port: int = 8188
    local_port: int = 18188


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="COMIC_",
        env_nested_delimiter="__",
        env_file=str(PROJECT_ROOT / ".env"),
        extra="ignore",
    )

    app_name: str = "AI 漫画自动化生产线"
    debug: bool = True

    # 数据落盘
    data_dir: Path = PROJECT_ROOT / "data"

    # 数据库（默认 SQLite，文件放 data/）
    db_url: str = ""

    # ComfyUI（出图后端：优先仙宫云隧道，本机 aki-v2 作备用调试）
    comfy_base_url: str = "http://127.0.0.1:18188"
    comfy_local_fallback_url: str = "http://127.0.0.1:8188"
    comfy_timeout_s: float = 30.0
    comfy_poll_interval_s: float = 1.5
    comfy_max_concurrency: int = 2

    # 工作流与映射表
    workflow_path: Path = CONFIG_DIR / "workflows" / "anima_t2i.json"
    workflow_params_path: Path = CONFIG_DIR / "workflow_params.yaml"

    # 出图默认参数
    default_candidates_per_panel: int = 4
    max_candidates_per_panel: int = 8

    # 页面规格
    page_spec: PageSpec = Field(default_factory=PageSpec)

    # 酒馆数据目录（用于「导入酒馆的模型配置」，留空则自动探测）
    tavern_data_dir: str = ""

    # 审查门默认模式：auto=全部自动通过 / manual=到门停住
    default_review_mode: Literal["auto", "manual"] = "manual"

    # 选图策略：first=取首张（可插拔，后续加 score）
    default_select_strategy: str = "first"

    # 默认目标页数（10–20 页体量）
    default_target_pages: int = 16

    # SSH 隧道
    tunnel: TunnelSettings = Field(default_factory=TunnelSettings)

    @property
    def resolved_db_url(self) -> str:
        if self.db_url:
            return self.db_url
        db_file = self.data_dir / "comic.db"
        return f"sqlite:///{db_file.as_posix()}"

    def ensure_dirs(self) -> None:
        for p in (
            self.data_dir,
            self.data_dir / "projects",
            self.data_dir / "artifacts",
            self.data_dir / "candidates",
        ):
            p.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s


# --------------------------------------------------------------------------
# 工作流参数映射表
# --------------------------------------------------------------------------
class ParamBinding(BaseModel):
    """一条参数绑定：我们的字段名 -> 工作流里的节点 id + 输入名。"""

    node_id: str
    input_name: str
    # 可选：写入前对值做的转换（如 seed 的 int）
    value_type: Literal["str", "int", "float", "bool", "enum"] = "str"


class LoraSlot(BaseModel):
    """工作流里的一个 LoRA 挂载槽（可串联多个）。"""

    node_id: str
    name_input: str = "lora_name"
    strength_model_input: str = "strength_model"
    strength_clip_input: str = "strength_clip"


class WorkflowParams(BaseModel):
    """Anima 文生图工作流的参数映射表。

    只描述“哪个字段写进哪个节点”，不含具体值——具体值来自项目/格配置。
    """

    workflow_file: str = "workflows/anima_t2i.json"
    # 参数名 -> 绑定；参数名用统一词汇：prompt_pos / prompt_neg / seed /
    # steps / cfg / sampler / scheduler / width / height / ckpt_name / denoise
    bindings: dict[str, ParamBinding] = Field(default_factory=dict)
    # LoRA 槽列表（按串联顺序）
    lora_slots: list[LoraSlot] = Field(default_factory=list)
    # 输出节点 id（SaveImage/ PreviewImage）；取图时按它从 history 里过滤
    output_node_ids: list[str] = Field(default_factory=list)


def load_workflow_params(path: Path | None = None) -> WorkflowParams:
    """读取参数映射表；文件不存在时返回空映射（由脚本自动初猜填充）。"""
    p = path or get_settings().workflow_params_path
    if not p.exists():
        return WorkflowParams()
    raw: dict[str, Any] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return WorkflowParams.model_validate(raw)


def save_workflow_params(params: WorkflowParams, path: Path | None = None) -> Path:
    """写回参数映射表。"""
    p = path or get_settings().workflow_params_path
    p.parent.mkdir(parents=True, exist_ok=True)
    data = params.model_dump(mode="json")
    p.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return p
