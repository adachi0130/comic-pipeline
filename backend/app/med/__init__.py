"""分页合成器（MED 适配器 + 可插拔接口）。"""

from .base import ComposeResult, PageComposer, PanelArt, ToneOp

__all__ = ["ComposeResult", "PageComposer", "PanelArt", "ToneOp", "MedComposer"]


def __getattr__(name: str):
    # 延迟导入，避免未安装 playwright 时导入包就失败
    if name == "MedComposer":
        from .composer import MedComposer

        return MedComposer
    raise AttributeError(name)
