"""S1 正文扩写（酒馆扩展桥）。

与原设计不同：**不再有结构规划（原 S1）**。流程是——
  你用酒馆（配好角色卡 / 世界书 / 预设）写正文 → 回传本系统 → 你审核 →
  通过后可继续发「续写提示」→ 新段落**追加**到小说里 → 全部通过后小说即可展示 →
  再进入 S2 分页分格。

数据模型：每一段正文是一个 ``PROSE`` 产物，ref = ``seg:{序号}``，可单独审核；
小说全文 = 各段按序号拼接。这既保留“逐段审核”，又天然支持“续写累积”。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from .. import artifacts as A
from ..models import Artifact, ArtifactKind, ArtifactStatus

KIND = "prose"

DEFAULT_INSTRUCTION = (
    "请以小说形式写出这一幕。注重画面感与人物内心（便于后续改编成分镜），"
    "对话精炼。只输出正文，不要标题、不要解释。"
)

# 「调用 LLM 写正文」时的系统提示词。
LLM_SYSTEM = (
    "你是一位漫画原作小说作者。请依据给定的作品标题与故事大纲，用小说笔法把它扩写成正文。"
    "要求：画面感强、人物内心清晰（便于后续改编成分镜），对话精炼，段落有节奏起伏。"
    "只输出小说正文本身——不要写标题、不要分节小标题、不要任何解释或说明文字。"
)


def llm_user_mapping(
    *,
    title: str,
    outline: str,
    instruction: str = "",
    mode: str = "start",
    context_tail: str = "",
) -> dict[str, str]:
    """构造「调用 LLM 写正文」用户提示词模板的占位符映射。

    与酒馆路径的区别：这里**一定会带上项目的标题与故事大纲**（这是本项目自己的
    LLM 调用，没有酒馆的角色卡/世界书兜底，标题与大纲是它唯一的设定来源）。
    实际措辞由 ``backend/prompts/s1_prose.md``（或前端覆盖）里的模板决定。
    """
    if (instruction or "").strip():
        instr = ("写作要求：" if mode != "continue" else "续写要求：") + instruction.strip()
    elif mode == "continue":
        instr = "请接着上面的前文继续往下写，保持文风、人称与节奏一致。"
    else:
        instr = "请根据标题与大纲，写出这个故事的开篇正文。"

    ctx = ""
    if mode == "continue" and (context_tail or "").strip():
        ctx = "以下是已写好的前文结尾（仅供衔接，不要重复）：\n……" + context_tail.strip() + "\n\n"

    return {
        "TITLE": (title or "").strip() or "（未填写）",
        "OUTLINE": (outline or "").strip() or "（未填写）",
        "INSTRUCTION": instr,
        "CONTEXT_TAIL": ctx,
    }



def seg_index(ref: str) -> int:
    try:
        return int(ref.split(":", 1)[1])
    except (IndexError, ValueError):
        return 10**9


def segments(session: Session, project_id: int) -> list[Artifact]:
    """按序号返回当前版本的正文分段。"""
    rows = A.all_current(session, project_id, ArtifactKind.PROSE.value)
    rows.sort(key=lambda a: seg_index(a.ref))
    return rows


def approved_segments(session: Session, project_id: int) -> list[Artifact]:
    return [a for a in segments(session, project_id) if a.status == ArtifactStatus.APPROVED.value]


def next_index(session: Session, project_id: int) -> int:
    segs = segments(session, project_id)
    return (max(seg_index(a.ref) for a in segs) + 1) if segs else 1


def novel_text(session: Session, project_id: int, *, only_approved: bool = True) -> str:
    """小说全文（各段拼接）。

    默认**只取已通过的分段**——未审核的内容不进入小说正文。
    内部需要草稿上下文时显式传 ``only_approved=False``。
    """
    segs = approved_segments(session, project_id) if only_approved else segments(session, project_id)
    return "\n\n".join((a.payload or {}).get("text", "") for a in segs if (a.payload or {}).get("text"))


def novel_state(session: Session, project_id: int) -> dict:
    """给前端的小说状态：全文、分段、统计、能否续写。

    ``text`` 只包含**已通过**的分段——未审核的内容不进小说全文。
    ``all_text`` 含草稿，仅供内部参考。
    """
    segs = segments(session, project_id)
    approved = [a for a in segs if a.status == ArtifactStatus.APPROVED.value]
    approved_text = "\n\n".join(
        (a.payload or {}).get("text", "") for a in approved if (a.payload or {}).get("text")
    )
    all_text = "\n\n".join((a.payload or {}).get("text", "") for a in segs if (a.payload or {}).get("text"))
    # 允许续写：无未通过的分段（全部已通过），或还没有任何分段
    can_continue = all(a.status == ArtifactStatus.APPROVED.value for a in segs)
    return {
        "text": approved_text,               # 小说全文 = 只含已通过
        "chars": len(approved_text),
        "all_text": all_text,
        "all_chars": len(all_text),
        "segments": [
            {
                "id": a.id,
                "ref": a.ref,
                "index": seg_index(a.ref),
                "status": a.status,
                "version": a.version,
                "mode": (a.payload or {}).get("mode", "start"),
                "instruction": (a.payload or {}).get("instruction", ""),
                "text": (a.payload or {}).get("text", ""),
                "chars": len((a.payload or {}).get("text", "")),
                "receipt": (a.payload or {}).get("receipt", {}),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in segs
        ],
        "approved_count": len(approved),
        "total_count": len(segs),
        "can_continue": can_continue,
    }


def append_segment(
    session: Session,
    *,
    project_id: int,
    text: str,
    mode: str = "start",
    instruction: str = "",
    status: str = ArtifactStatus.REVIEW.value,
    receipt: dict | None = None,
) -> Artifact:
    """把酒馆回传的一段正文追加为新的分段产物。

    ``receipt`` 是本次生成的依据（角色卡 / 世界书 / 预设 / 模型），随正文一起存下来，
    供前端「本次生成依据」展示与回看。
    """
    idx = next_index(session, project_id)
    # 依赖上一段，形成血缘：改上一段 → 下一段标记需重跑复核
    segs = segments(session, project_id)
    inputs = [segs[-1]] if segs else []
    return A.create(
        session,
        project_id=project_id,
        kind=ArtifactKind.PROSE.value,
        ref=f"seg:{idx}",
        payload={
            "text": text,
            "mode": mode,
            "instruction": instruction,
            "receipt": receipt or {},
        },
        inputs=inputs,
        status=status,
    )
