"""阶段作业处理器：集中注册到作业队列（新流程，无结构规划）。

阶段：S1 正文(prose) → S2 分页分格(script) → S3 分镜提示词(prompt) → S4 逐格出图(image)
      → S5 分页合成(compose) → S6 整册导出(book)
S1 正文由酒馆扩展领取生成，不作为普通作业注册。
"""

from __future__ import annotations

from .. import jobs
from . import book, compose, image, prompt, script


def register_all() -> None:
    jobs.register(script.KIND, script.handle)
    jobs.register(prompt.KIND, prompt.handle)
    jobs.register(image.KIND, image.handle)
    jobs.register(compose.KIND, compose.handle)
    jobs.register(book.KIND, book.handle)


__all__ = ["register_all"]
