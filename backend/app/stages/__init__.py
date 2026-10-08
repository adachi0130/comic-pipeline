"""阶段作业处理器：集中注册到作业队列。

已实现：S1 结构规划、S3 分页分格、S4 分镜提示词、S5 逐格出图、S6 分页合成。
待补：S2 正文（酒馆扩展桥）、S7 整册导出。
"""

from __future__ import annotations

from .. import jobs
from . import s1_structure, s3_script, s4_prompt, s5_image, s6_compose, s7_book


def register_all() -> None:
    jobs.register(s1_structure.KIND, s1_structure.handle)
    jobs.register(s3_script.KIND, s3_script.handle)
    jobs.register(s4_prompt.KIND, s4_prompt.handle)
    jobs.register(s5_image.KIND, s5_image.handle)
    jobs.register(s6_compose.KIND, s6_compose.handle)
    jobs.register(s7_book.KIND, s7_book.handle)


__all__ = ["register_all"]
