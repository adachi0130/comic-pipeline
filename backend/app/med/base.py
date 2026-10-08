"""分页合成抽象：``PageComposer``。

把“装版式 → 落提示词 → 贴图 → 加技法 → 导出整页”定义成接口，Manga Editor Desu
只是其中一个适配器实现。这样 MED 的“无官方 API / 内部函数易变 / GPL v3”三重风险
都被隔离在适配器里，将来换实现（自研渲染器或其他工具）不动上层阶段代码。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class PanelArt:
    """要贴进某一格的成图。"""

    order: int              # 1-based，阅读顺序，对应 S3 的 panel_order
    image_path: str         # 本地 PNG 路径
    prompt: str = ""        # 该格提示词（可选，用于回填 MED 的 text2img_prompt）


@dataclass
class ToneOp:
    """技法叠加操作。"""

    kind: str               # focus / speed / tone ...
    panel_order: int | None = None
    options: dict = field(default_factory=dict)


@dataclass
class ComposeResult:
    ok: bool
    png_path: str = ""      # 导出的整页 PNG（落盘路径）
    panels: int = 0
    applied_prompts: int = 0
    placed: int = 0
    warnings: list[str] = field(default_factory=list)
    error: str = ""


@runtime_checkable
class PageComposer(Protocol):
    """分页合成器接口。"""

    def open(self) -> None: ...
    def close(self) -> None: ...

    def compose(
        self,
        *,
        template_svg: str,
        is_landscape: bool,
        prompts: list[str],
        arts: list[PanelArt],
        tones: list[ToneOp] | None = None,
        right_to_left: bool = True,
        multiplier: int = 1,
    ) -> ComposeResult: ...
