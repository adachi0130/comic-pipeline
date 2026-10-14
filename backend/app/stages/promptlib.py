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
def load_prompt_default(name: str) -> tuple[str, str]:
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
        if provider is not None and not provider.enabled:
            provider = None
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


# --------------------------------------------------------------------------
# 用户可编辑提示词（数据库覆盖 .md 默认值）
# --------------------------------------------------------------------------
PROMPT_STAGES = {
    "s1_prose": "S1 正文（调用 LLM 写）",
    "s2_script": "S2 分页分格",
    "s3_prompt": "S3 分镜提示词",
}


def get_prompt(session: Session, name: str) -> tuple[str, str]:
    """取该阶段实际使用的 (系统提示词, 用户模板)：优先用户覆盖，否则用 .md 默认。"""
    from ..models import PromptOverride

    row = session.get(PromptOverride, name)
    if row is not None and (row.system_text or row.user_text):
        default_sys, default_user = load_prompt_default(name)
        return (row.system_text or default_sys), (row.user_text or default_user)
    return load_prompt_default(name)


def save_prompt(session: Session, name: str, system_text: str, user_text: str) -> None:
    from ..models import PromptOverride

    row = session.get(PromptOverride, name)
    if row is None:
        row = PromptOverride(name=name)
        session.add(row)
    row.system_text = system_text
    row.user_text = user_text
    session.commit()


def reset_prompt(session: Session, name: str) -> None:
    from ..models import PromptOverride

    row = session.get(PromptOverride, name)
    if row is not None:
        session.delete(row)
        session.commit()


def prompt_info(session: Session) -> list[dict]:
    """供前端：列出各阶段提示词（当前值 / 默认值 / 是否已自定义）。"""
    from ..models import PromptOverride

    out = []
    for name, label in PROMPT_STAGES.items():
        overridden = session.get(PromptOverride, name) is not None
        system_text, user_text = get_prompt(session, name)
        d_sys, d_user = load_prompt_default(name)
        out.append({
            "name": name, "label": label, "overridden": overridden,
            "system_text": system_text, "user_text": user_text,
            "default_system": d_sys, "default_user": d_user,
        })
    return out
