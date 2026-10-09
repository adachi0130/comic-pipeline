"""阶段产物的强类型契约（pydantic）。

这些模型同时承担三个角色：
1. LLM 结构化输出的 JSON Schema 来源（喂给供应商的 response_format）；
2. 解析后的**强制校验**（不合法就带着错误重试）；
3. 落库 payload 的规范形状（下游阶段只认这些字段）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

PaceRole = Literal["setup", "rising", "climax", "resolution"]

# 与 Manga Editor Desu 的 MANGA_PANEL_ROLE_NAMES 对齐
PanelRole = Literal["establishing", "scenery", "insert", "full", "medium", "closeup", "impact"]
ShotType = Literal[
    "extreme_wide", "wide", "medium", "medium_close", "closeup", "extreme_closeup", "over_shoulder"
]
BubbleType = Literal["speech", "thought", "narration", "shout", "whisper", "none"]


# --------------------------------------------------------------------------
# S2 分页分格（原 S3）
# --------------------------------------------------------------------------
class PanelScript(BaseModel):
    panel_order: int = Field(ge=1, description="1..N 的稳定序号，贯穿 S4/S5/S6 做主键")
    role: PanelRole
    shot: ShotType
    characters: list[str] = Field(default_factory=list)
    action: str = Field(description="角色动作/表情")
    scene_desc: str = Field(default="", description="场景描述")
    dialogue: str = Field(default="", description="该格台词（可空）")
    bubble_type: BubbleType = "none"
    technique: list[str] = Field(default_factory=list, description="技法标签，如 集中线/运动线")


class PageScript(BaseModel):
    """S2 输出：单页。``panels`` 条数必须等于所选模板的格数（阶段层校验）。"""

    scene_id: int = 0          # 已无场结构，保留字段便于兼容（默认 0）
    page_index: int = Field(ge=1)
    template_id: str
    panels: list[PanelScript] = Field(min_length=1)

    @model_validator(mode="after")
    def _panel_order_contiguous(self) -> "PageScript":
        orders = sorted(p.panel_order for p in self.panels)
        if orders != list(range(1, len(self.panels) + 1)):
            raise ValueError(f"panel_order 必须是 1..{len(self.panels)} 的连续序号，实际 {orders}")
        return self


class Storyboard(BaseModel):
    """S2 批量输出：一次产出若干页（按小说文本切分），供分批调用以控制输出长度。"""

    pages: list[PageScript] = Field(min_length=1)

    @model_validator(mode="after")
    def _page_index_unique(self) -> "Storyboard":
        idx = [p.page_index for p in self.pages]
        if len(set(idx)) != len(idx):
            raise ValueError(f"page_index 出现重复：{idx}")
        return self


# --------------------------------------------------------------------------
# S3 每格提示词（原 S4）
# --------------------------------------------------------------------------
class PanelPrompt(BaseModel):
    panel_ref: str = Field(description="对应 panel:页.序，如 panel:3.2")
    prompt_pos: str
    prompt_neg: str = ""
    # 该格最终采用的 LoRA（可从角色绑定/项目默认继承）
    loras: list[dict] = Field(default_factory=list)   # [{"name":..., "weight":...}]
    seed: int | None = None
    width: int | None = None
    height: int | None = None


class PagePrompts(BaseModel):
    page_ref: str
    panels: list[PanelPrompt] = Field(min_length=1)


# --------------------------------------------------------------------------
# API DTO
# --------------------------------------------------------------------------
class ProjectCreate(BaseModel):
    title: str
    outline: str = ""
    target_pages: int = Field(default=16, ge=1)
    review_mode: Literal["auto", "manual"] = "manual"


class ReviewAction(BaseModel):
    verdict: Literal["approve", "reject"]
    comment: str = ""


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    model: str
    extra: dict = Field(default_factory=dict)
