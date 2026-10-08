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
# S1 结构规划
# --------------------------------------------------------------------------
class Scene(BaseModel):
    summary: str = Field(description="一场的一句话剧情摘要")
    characters: list[str] = Field(default_factory=list, description="出场角色名")
    goal: str = Field(default="", description="本场目标")
    conflict: str = Field(default="", description="本场冲突")
    page_budget: int = Field(ge=1, description="本场分配页数（≥1）")
    pace_role: PaceRole = "rising"


class Chapter(BaseModel):
    title: str
    page_budget: int = Field(ge=1)
    scenes: list[Scene] = Field(min_length=1)

    @model_validator(mode="after")
    def _chapter_budget_matches_scenes(self) -> "Chapter":
        s = sum(sc.page_budget for sc in self.scenes)
        if self.page_budget != s:
            raise ValueError(f"章 '{self.title}' 的 page_budget={self.page_budget} 与各场之和={s} 不一致")
        return self


class Structure(BaseModel):
    """S1 输出：章 -> 场，且全场页预算之和 == 全书目标页数。"""

    target_pages: int = Field(ge=1)
    chapters: list[Chapter] = Field(min_length=1)

    @model_validator(mode="after")
    def _total_budget_matches(self) -> "Structure":
        total = sum(sc.page_budget for ch in self.chapters for sc in ch.scenes)
        if total != self.target_pages:
            raise ValueError(
                f"所有场 page_budget 之和={total} 必须严格等于 target_pages={self.target_pages}"
            )
        return self


# --------------------------------------------------------------------------
# S3 每页分格脚本（页产物 = 下游契约）
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
    """S3 输出：单页。``panels`` 条数必须等于所选模板的格数（阶段层校验）。"""

    scene_id: int
    page_index: int = Field(ge=1)
    template_id: str
    panels: list[PanelScript] = Field(min_length=1)

    @model_validator(mode="after")
    def _panel_order_contiguous(self) -> "PageScript":
        orders = sorted(p.panel_order for p in self.panels)
        if orders != list(range(1, len(self.panels) + 1)):
            raise ValueError(f"panel_order 必须是 1..{len(self.panels)} 的连续序号，实际 {orders}")
        return self


# --------------------------------------------------------------------------
# S4 每格提示词
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
