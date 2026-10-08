"""S2 正文生成（酒馆扩展桥）。

与其它阶段不同，S2 的实际生成发生在**酒馆浏览器页面**里：本模块只负责“建作业 +
把引导词写进 payload”，由 ``/api/bridge/tasks/claim`` 交给扩展，扩展生成完再
``POST /api/bridge/result`` 回传。因此这里不注册成作业处理器（入队后由扩展领取）。
"""

from __future__ import annotations

KIND = "s2_prose"

DEFAULT_INSTRUCTION = (
    "请以小说形式扩写这一场。保持与上文连贯，注重画面感（便于后续改编成分镜），"
    "对话精炼。只输出正文，不要标题、不要解释。"
)
