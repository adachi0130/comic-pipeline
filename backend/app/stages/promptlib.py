"""提示词资产加载与阶段→供应商解析。

提示词以 Markdown 文件形式版本化在 ``backend/prompts/``；本模块负责读取并抽出
“系统提示词”和“用户提示词模板”，供阶段调用。阶段用哪个 LLM 供应商，由
``stage_models`` 表决定（S1/S3/S4 可各不同）；未配置则回退到第一个启用的供应商。
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import PROJECT_ROOT
from ..llm import ProviderConfig
from ..models import LLMProvider, StageModel

PROMPTS_DIR = PROJECT_ROOT / "backend" / "prompts"


@lru_cache
def load_prompt(name: str) -> tuple[str, str]:
    """返回 (系统提示词, 用户提示词模板)。

    从 Markdown 的 ``` 代码块里抽取：第一个代码块 = 系统提示词，
    第二个标注“用户提示词模板”的代码块 = 用户模板。
    """
    path = PROMPTS_DIR / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"提示词文件不存在：{path}")
    text = path.read_text(encoding="utf-8")

    blocks = re.findall(r"```[a-zA-Z]*\n(.*?)```", text, flags=re.DOTALL)
    system = blocks[0].strip() if blocks else ""
    user = ""
    m = re.search(r"## 用户提示词模板\s*```[a-zA-Z]*\n(.*?)```", text, flags=re.DOTALL)
    if m:
        user = m.group(1).strip()
    elif len(blocks) > 1:
        user = blocks[1].strip()
    return system, user


def render(template: str, mapping: dict[str, object]) -> str:
    """把 ``{{KEY}}`` 占位替换为映射值（不做转义，值多为 JSON 文本）。"""
    out = template
    for k, v in mapping.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def resolve_provider(session: Session, stage: str) -> tuple[LLMProvider, ProviderConfig]:
    """取该阶段应使用的供应商；未配置则用第一个启用的。"""
    sm = session.get(StageModel, stage)
    provider: LLMProvider | None = None
    if sm is not None:
        provider = session.get(LLMProvider, sm.provider_id)
    if provider is None:
        provider = session.scalars(
            select(LLMProvider).where(LLMProvider.enabled.is_(True)).order_by(LLMProvider.id)
        ).first()
    if provider is None:
        raise RuntimeError("尚未配置任何 LLM 供应商，请先 POST /api/providers")
    cfg = ProviderConfig(
        base_url=provider.base_url,
        model=provider.model,
        api_key=provider.api_key,
        extra=provider.extra or {},
    )
    return provider, cfg
