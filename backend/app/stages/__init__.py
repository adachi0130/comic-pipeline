"""阶段作业处理器：集中注册到作业队列。

M0 只实现 S5（逐格出图）以打通最小闭环；S1/S3/S4 在 M1、S6/S7 在 M2/M3 补齐。
"""

from __future__ import annotations

from .. import jobs
from . import s5_image


def register_all() -> None:
    jobs.register(s5_image.KIND, s5_image.handle)


__all__ = ["register_all"]
