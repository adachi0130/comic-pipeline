"""出图后端配置与工作流登记表（可在前端改，写盘持久化）。

对应 Manga Editor Desu 的「外部 AI 设置」那一块，但改由后端托管：

- ``config/comfy.yaml``  连接信息（仙宫云网址 / 可选 API Key / 本地备用）
                         + 当前活动工作流 + 出图默认参数 + LoRA 占位。
- ``config/workflows/``  工作流文件（ComfyUI **API 格式** JSON），文件名即工作流名称。

设计原则：换工作流/换后端只改配置与文件，不动代码；前端只读写这一层。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from ..config import CONFIG_DIR

COMFY_CONFIG_PATH = CONFIG_DIR / "comfy.yaml"
WORKFLOW_DIR = CONFIG_DIR / "workflows"

# MED 的两种占位符写法（见 comfyui-util.js）
DEFAULT_PROMPT_PLACEHOLDER = "%prompt%"
DEFAULT_NEGATIVE_PLACEHOLDER = "%negative%"

# 名字做文件名时的安全化（保留中文，去掉路径分隔与非法字符）
_SLUG_BAD = re.compile(r'[\\/:*?"<>|\s]+')


def safe_workflow_name(name: str) -> str:
    """工作流名称 -> 安全的文件名主干（保留中文，去掉危险字符）。"""
    cleaned = _SLUG_BAD.sub("_", (name or "").strip())
    cleaned = cleaned.strip("._")
    if not cleaned:
        raise ValueError("工作流名称不能为空")
    if len(cleaned) > 80:
        cleaned = cleaned[:80]
    return cleaned


class ComfyConfig(BaseModel):
    """出图后端连接 + 活动工作流 + 默认出图参数。"""

    # 用哪台后端：cloud=仙宫云（隧道/直连），local=本机 ComfyUI
    backend: Literal["cloud", "local"] = "cloud"

    # 仙宫云：填控制台给的 ComfyUI 访问地址（形如 https://xxxx.xiangongyun.com）
    cloud_url: str = ""
    # 需要鉴权时填（会以 Authorization: Bearer 发送）；无则留空
    cloud_api_key: str = ""

    # 本机 ComfyUI 备用调试地址
    local_url: str = "http://127.0.0.1:8188"

    # 当前活动工作流名称（= config/workflows/<name>.json 的主干）
    workflow_name: str = ""

    # 占位符（沿用 MED 的写法，工作流里出现即被替换）
    prompt_placeholder: str = DEFAULT_PROMPT_PLACEHOLDER
    negative_placeholder: str = DEFAULT_NEGATIVE_PLACEHOLDER

    # 出图默认参数（可在前端改；单格/项目仍可覆盖）
    default_params: dict[str, Any] = Field(default_factory=dict)
    # 默认 LoRA 占位（项目级真正生效的 LoRA 存数据库 lora_selection 表）
    default_loras: list[dict[str, Any]] = Field(default_factory=list)

    # 每格默认批量张数
    candidates_per_panel: int = 4

    def active_url(self) -> str:
        return (self.cloud_url if self.backend == "cloud" else self.local_url).strip()

    def active_api_key(self) -> str:
        return self.cloud_api_key.strip() if self.backend == "cloud" else ""


def load_comfy_config(path: Path | None = None) -> ComfyConfig:
    p = path or COMFY_CONFIG_PATH
    if not p.exists():
        return ComfyConfig()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return ComfyConfig.model_validate(raw)


def save_comfy_config(cfg: ComfyConfig, path: Path | None = None) -> Path:
    p = path or COMFY_CONFIG_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        yaml.safe_dump(cfg.model_dump(mode="json"), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return p


# --------------------------------------------------------------------------
# 工作流登记表（config/workflows/*.json）
# --------------------------------------------------------------------------
def workflow_path(name: str) -> Path:
    return WORKFLOW_DIR / f"{safe_workflow_name(name)}.json"


def list_workflows() -> list[str]:
    if not WORKFLOW_DIR.exists():
        return []
    return sorted(p.stem for p in WORKFLOW_DIR.glob("*.json"))


def load_workflow_json(name: str) -> dict[str, Any]:
    p = workflow_path(name)
    if not p.exists():
        raise FileNotFoundError(f"工作流不存在：{name}")
    return json.loads(p.read_text(encoding="utf-8"))


def save_workflow_json(name: str, workflow: dict[str, Any]) -> Path:
    WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
    p = workflow_path(name)
    p.write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def delete_workflow_json(name: str) -> bool:
    p = workflow_path(name)
    if p.exists():
        p.unlink()
    # 一并清掉它的参数映射旁文件
    pp = params_path(name)
    if pp.exists():
        pp.unlink()
    return True


# --------------------------------------------------------------------------
# 每个工作流各自的参数映射（旁文件 <name>.params.yaml）
# --------------------------------------------------------------------------
def params_path(name: str) -> Path:
    return WORKFLOW_DIR / f"{safe_workflow_name(name)}.params.yaml"


def load_params(name: str) -> "WorkflowParams":
    """读某工作流的参数映射；没有就按工作流自动初猜一份（不落盘）。"""
    from ..config import WorkflowParams
    from .workflow import guess_mapping

    p = params_path(name)
    if p.exists():
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        return WorkflowParams.model_validate(raw)
    try:
        return guess_mapping(load_workflow_json(name))
    except Exception:  # noqa: BLE001 - 猜不出来就返回空映射，由前端手动确认
        return WorkflowParams()


def save_params(name: str, params: "WorkflowParams") -> Path:
    p = params_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        yaml.safe_dump(params.model_dump(mode="json"), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return p


def guess_and_save_params(name: str) -> "WorkflowParams":
    """重新按工作流自动初猜映射并落盘。"""
    from .workflow import guess_mapping

    params = guess_mapping(load_workflow_json(name))
    save_params(name, params)
    return params

