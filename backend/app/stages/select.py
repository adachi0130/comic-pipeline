"""选图策略（可插拔）。

默认 ``first``：自动模式下取第一张候选；人工模式下不自动选，等前端点选。
将来要加“按分数择优”，只需在此注册新策略。
"""

from __future__ import annotations

from collections.abc import Callable


def first(candidates: list[dict]) -> int | None:
    return 0 if candidates else None


STRATEGIES: dict[str, Callable[[list[dict]], int | None]] = {
    "first": first,
}


def register(name: str, fn: Callable[[list[dict]], int | None]) -> None:
    STRATEGIES[name] = fn


def select_index(candidates: list[dict], strategy: str = "first") -> int | None:
    fn = STRATEGIES.get(strategy, first)
    return fn(candidates)
