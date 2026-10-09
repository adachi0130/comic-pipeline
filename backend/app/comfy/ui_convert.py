"""ComfyUI「UI 格式」工作流 → 「API 格式」转换。

ComfyUI 里点「保存」得到的是 UI 格式（``nodes`` + ``links``，参数在
``widgets_values`` 数组里，用位置对应输入名）；而 ``POST /prompt`` 需要 API 格式
（``{node_id: {class_type, inputs}}``，参数是具名的）。

位置 → 名字的对应关系必须查 ``/object_info``（节点定义）才知道，所以这个转换
依赖一次 ``object_info`` 拉取。

另外还处理三类**前端虚拟节点**（它们只活在浏览器里，不能进 API）：
- **KJNodes 的 SetNode / GetNode**：把 ``Set_名字`` 的输入源直接接到所有 ``Get_名字`` 的消费者；
- **cg-use-everywhere 的 Anything Everywhere**：按 ``extra.ue_links`` 把广播源补到目标输入；
- **子图（subgraph）/ 本地缺失的节点**：无法解析，明确列出告知，不静默丢。

参考 ComfyUI 前端的 graphToPrompt 思路 + KSampler 的
``seed`` 后面跟一个 ``control_after_generate`` 的已知例外。
"""

from __future__ import annotations

import re
from typing import Any

# 需要额外补一个 JS 控件的 widget（种子后面的“生成后控制”）
SEED_WIDGETS = ("seed", "noise_seed")

# 控件类型集合
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}

# 前端虚拟节点：不进 API，需要解析
SET_TYPES = {"SetNode"}
GET_TYPES = {"GetNode"}
UE_TYPE_HINTS = ("anything everywhere",)

# 子图 / 子图内部节点的 class_type 是 uuid 形式
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class ConvertError(RuntimeError):
    pass


def is_ui_format(wf: dict[str, Any]) -> bool:
    return isinstance(wf.get("nodes"), list)


def _is_lora_dict(v: Any) -> bool:
    """rgthree Power Lora Loader 的每个槽是一个对象 ``{on, lora, strength, strengthTwo}``。"""
    return isinstance(v, dict) and "lora" in v and ("on" in v or "strength" in v)


def _is_ue(node: dict) -> bool:
    t = (node.get("type") or "").lower()
    return any(h in t for h in UE_TYPE_HINTS)


def _widget_names(class_type: str, object_info: dict[str, Any]) -> list[str]:
    """按声明顺序列出某节点的“控件类”输入名。"""
    spec = (object_info.get(class_type) or {}).get("input") or {}
    names: list[str] = []
    for group in ("required", "optional"):
        for name, entry in (spec.get(group) or {}).items():
            if _is_widget(entry):
                names.append(name)
    return names


def _is_widget(entry: Any) -> bool:
    """判断一个输入定义是不是控件（而非连线）。

    object_info 里的写法：
    - ``["INT", {...}]``        普通标量控件（数值/文本/布尔）
    - ``[["a","b"], {...}]``    COMBO 控件（下拉选项）
    - ``"MODEL"`` / ``["MODEL", ...]``  连线输入（不算控件）
    """
    if isinstance(entry, list):
        first = entry[0] if entry else None
        if isinstance(first, list):          # [["选项"], {...}] → COMBO
            return True
        if isinstance(first, str):           # ["INT", {...}] / ["MODEL", ...]
            return first in WIDGET_TYPES
        return False
    if isinstance(entry, str):
        return entry in WIDGET_TYPES
    if isinstance(entry, tuple) and entry:
        return _is_widget(entry[0])
    if isinstance(entry, dict):
        if entry.get("forceInput"):
            return False
        t = entry.get("type")
        return _is_widget(t) if t is not None else False
    return False


def _expected_widget_values(class_type: str, object_info: dict[str, Any]) -> list[str]:
    """把「控件输入名」展开成与 widgets_values 一一对应的列表（含 JS 追加控件）。"""
    out: list[str] = []
    for name in _widget_names(class_type, object_info):
        out.append(name)
        if name in SEED_WIDGETS:
            out.append("__control_after_generate__")
    return out


def _link_map(wf_ui: dict[str, Any]) -> dict[tuple[int, int], tuple[str, int]]:
    """把 links 转成 ``(目标节点, 目标槽) -> (源节点, 源槽)``。"""
    out: dict[tuple[int, int], tuple[str, int]] = {}
    for lk in wf_ui.get("links") or []:
        # [link_id, origin_id, origin_slot, target_id, target_slot, type]
        if not isinstance(lk, list) or len(lk) < 5:
            continue
        try:
            out[(int(lk[3]), int(lk[4]))] = (str(lk[1]), int(lk[2]))
        except (TypeError, ValueError):
            continue
    return out


def _resolve_by_link_id(wf_ui: dict[str, Any], link_id: Any) -> tuple[str, int] | None:
    """用 link id 找到源 ``(node_id, slot)``。"""
    for lk in wf_ui.get("links") or []:
        if isinstance(lk, list) and len(lk) >= 3 and str(lk[0]) == str(link_id):
            return (str(lk[1]), int(lk[2]))
    return None


def ui_to_api(wf_ui: dict[str, Any], object_info: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """把 UI 格式工作流转成 API 格式。

    返回 ``(api_workflow, warnings)``。
    """
    if not is_ui_format(wf_ui):
        raise ConvertError("这不是 UI 格式工作流（缺少 nodes 列表）")

    nodes = [n for n in wf_ui.get("nodes") or [] if isinstance(n, dict)]
    node_by_id = {str(n.get("id")): n for n in nodes}
    warnings: list[str] = []

    # ---- PASS 0：KJNodes Set/Get 名字 → 源 ----
    set_by_name: dict[str, tuple[str, int]] = {}
    for n in nodes:
        if (n.get("type") or "") not in SET_TYPES:
            continue
        wv = n.get("widgets_values") or []
        name = str(wv[0]) if wv else ""
        ins = n.get("inputs") or []
        if name and ins and ins[0].get("link") is not None:
            src = _resolve_by_link_id(wf_ui, ins[0]["link"])
            if src:
                set_by_name[name] = src
    get_src: dict[str, tuple[str, int] | None] = {}
    for n in nodes:
        if (n.get("type") or "") not in GET_TYPES:
            continue
        wv = n.get("widgets_values") or []
        name = str(wv[0]) if wv else ""
        get_src[str(n.get("id"))] = set_by_name.get(name)

    def resolve_link(link: Any) -> Any:
        """把指向 Get 节点的链接换成它真正的源。"""
        if isinstance(link, list) and len(link) >= 2:
            src = get_src.get(str(link[0]))
            if src:
                return [src[0], src[1]]
        return link

    # ---- 构建 API（跳过虚拟节点）----
    api: dict[str, Any] = {}
    missing_classes: set[str] = set()
    subgraph_classes: set[str] = set()

    for node in nodes:
        cls = node.get("type") or ""
        if cls in SET_TYPES or cls in GET_TYPES or _is_ue(node):
            continue
        nid = node.get("id")
        if nid is None or not cls or cls in ("Note", "Reroute", "PrimitiveNode", "MarkdownNote"):
            continue

        if _UUID_RE.match(cls):
            subgraph_classes.add(cls)
            continue

        nid_s = str(nid)
        api[nid_s] = {"class_type": cls, "inputs": {}, "_meta": {"title": node.get("title") or ""}}
        inputs = api[nid_s]["inputs"]

        # 0) Power Lora Loader 之类的“对象式槽”：widgets_values 里每个 dict 就是一个槽，
        #    直接搬进同名输入，不能被“控件对位”逻辑吞掉。
        if isinstance(node.get("widgets_values"), list):
            for wv in node["widgets_values"]:
                if _is_lora_dict(wv):
                    idx = len([k for k in inputs if k.startswith("lora_")])
                    inputs[f"lora_{idx}"] = dict(wv)

        # 1) 连线输入
        for slot in node.get("inputs") or []:
            if not isinstance(slot, dict):
                continue
            name = slot.get("name")
            if name is None:
                continue
            if slot.get("link") is not None:
                src = _resolve_by_link_id(wf_ui, slot["link"])
                if src is not None:
                    inputs[name] = list(resolve_link(list(src)))
            # link 为空的连线类输入不写值（可能由 Anything Everywhere 补上，见下）

        # 2) widgets_values 按 object_info 顺序对位
        widgets = node.get("widgets_values")
        if widgets is None:
            continue
        if not isinstance(widgets, list):
            warnings.append(f"节点 {nid}（{cls}）控件值是对象，已跳过其参数")
            continue
        if cls not in object_info:
            missing_classes.add(cls)
            continue

        expected = _expected_widget_values(cls, object_info)
        vi = 0
        for name in expected:
            if vi >= len(widgets):
                break
            val = widgets[vi]
            vi += 1
            if name == "__control_after_generate__":
                continue
            if name not in inputs:
                inputs[name] = val
        if vi != len(widgets):
            warnings.append(
                f"节点 {nid}（{cls}）控件数量对不上：工作流 {len(widgets)} 个，"
                f"节点定义 {len(expected)} 个，可能漏/多了参数"
            )

    # ---- PASS 2：Anything Everywhere 广播（按 extra.ue_links 精确补）----
    ue_links = (wf_ui.get("extra") or {}).get("ue_links") or []
    for ue in ue_links:
        if not isinstance(ue, dict):
            continue
        dn = str(ue.get("downstream"))
        up = str(ue.get("upstream"))
        up_slot = int(ue.get("upstream_slot", 0) or 0)
        slot_idx = ue.get("downstream_slot")
        target = node_by_id.get(dn)
        if target is None or dn not in api:
            continue
        ins = target.get("inputs") or []
        slot_name = None
        if isinstance(slot_idx, int) and 0 <= slot_idx < len(ins):
            slot_name = ins[slot_idx].get("name")
        if not slot_name:
            continue
        src = get_src.get(up) or (up, up_slot)
        api[dn]["inputs"][slot_name] = [str(src[0]), int(src[1])]

    # ---- 汇总提示 ----
    if missing_classes:
        warnings.append(
            "后端缺少这些节点定义，已跳过其参数（对应自定义节点没装/没加载）："
            + "、".join(sorted(missing_classes))
        )
    if subgraph_classes:
        warnings.append(
            "工作流里有「子图」节点（"
            + "、".join(sorted(subgraph_classes))
            + "），其内部定义无法从 UI 文件读到，无法自动转换。"
            "请在 ComfyUI 里打开该工作流，右键子图 → 展开/解组，或改用「保存（API 格式）」导出后导入。"
        )
    return api, warnings
