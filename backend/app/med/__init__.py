"""历史兼容层：旧的 MED 分页合成适配器。

**新流程不再使用本包。** 分页合成已改为自研渲染核心（``backend/app/comic/``），
手动编辑走 ``backend/static/ui/editor/``。本包保留是为了：
- 让仍引用 ``PageComposer`` / ``ComposeResult`` 的旧代码与测试能导入；
- 在对照排查历史存档时，还看得到当时的驱动方式。

新代码请使用 ``app.comic.document`` / ``app.comic.render``。
"""

from .base import ComposeResult, PageComposer, PanelArt, ToneOp

__all__ = ["ComposeResult", "PageComposer", "PanelArt", "ToneOp", "MedComposer"]


def __getattr__(name: str):
    # 延迟导入，避免未安装 playwright 时导入包就失败
    if name == "MedComposer":
        from .composer import MedComposer

        return MedComposer
    raise AttributeError(name)
