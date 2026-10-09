"""ComfyUI「UI 格式」工作流 → 「API 格式」转换。

ComfyUI 里点「保存」得到的是 UI 格式（``nodes`` + ``links``，参数在
``widgets_values`` 数组里，用位置对应输入名）；而 ``POST /prompt`` 需要 API 格式
（``{node_id: {class_type, inputs}}``，参数是具名的）。

位置 → 名字的对应关系必须查 ``/object_info``（节点定义）才知道，所以这个转换
依赖一次 ``object_info`` 拉取。若某个节点的 widget 数量对不上（自定义节点
常常带 JS 追加的控件），会尽量按已知规则对齐并给出提示，宁可少写不错写。

参考 ComfyUI 前端的 graphToPrompt 思路 + KSampler 的
``seed`` 后面跟一个 ``control_after_generate`` 的已知例外。
"""

from __future__ import annotations

from typing import Any

# 需要额外补一个 JS 控件的 widget（种子后面的“生成后控制”）
SEED_WIDGETS = ("seed", "noise_seed")

# 这些类型的输入是“连线”，不是控件
NON_WIDGET_TYPES = {
    "MODEL",
    "CLIP",
    "VAE",
    "CONDITIONING",
    "LATENT",
    "IMAGE",
    "MASK",
    "CONTROL_NET",
    "STYLE_MODEL",
    "CLIP_VISION",
    "CLIP_VISION_OUTPUT",
    "GUIDER",
    "SAMPLER",
    "SIGMAS",
    "NOISE",
    "AUDIO",
    "UPSCALE_MODEL",
    "GLIGEN",
    "SAMPLE",
    "WEBCAM",
    "*",
}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


class ConvertError(RuntimeError):
    pass


def is_ui_format(wf: dict[str, Any]) -> bool:
    return isinstance(wf.get("nodes"), list)


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
    """判断一个输入定义是不是控件（而非连线）。"""
    if isinstance(entry, list):  # combo: [[选项...], {配置}]
        return True
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
            # KSampler 等：seed 后跟一个 control_after_generate（JS 控件，不在 object_info 里）
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


def ui_to_api(wf_ui: dict[str, Any], object_info: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """把 UI 格式工作流转成 API 格式。

    返回 ``(api_workflow, warnings)``。
    """
    if not is_ui_format(wf_ui):
        raise ConvertError("这不是 UI 格式工作流（缺少 nodes 列表）")

    nodes = [n for n in wf_ui.get("nodes") or [] if isinstance(n, dict)]
    links = _link_map(wf_ui)
    api: dict[str, Any] = {}
    warnings: list[str] = []
    missing_classes: set[str] = set()

    for node in nodes:
        nid = node.get("id")
        if nid is None:
            continue
        class_type = node.get("type")
        if not class_type or class_type in ("Note", "Reroute", "PrimitiveNode", "MarkdownNote"):
            continue  # 纯注释/中继节点不入 API

        nid_s = str(nid)
        api[nid_s] = {"class_type": class_type, "inputs": {}, "_meta": {"title": node.get("title") or ""}}
        inputs = api[nid_s]["inputs"]

        # 1) 连线输入：node.inputs 里带 link 的
        for idx, slot in enumerate(node.get("inputs") or []):
            if not isinstance(slot, dict):
                continue
            name = slot.get("name")
            link_id = slot.get("link")
            if name is None:
                continue
            if link_id is not None:
                # 优先用 node.inputs 里的 link id 反查
                src = _resolve_by_link_id(wf_ui, link_id, links)
                if src is not None:
                    inputs[name] = src
            # name 是连线类输入（link 为空）也不写值

        # 2) widgets_values：按 object_info 的顺序对应
        widgets = node.get("widgets_values")
        if widgets is None:
            continue
        if not isinstance(widgets, list):
            # 个别节点存成 dict（如 rgthree 的某些）；跳过并提示
            warnings.append(f"节点 {nid}（{class_type}）控件值是对象，已跳过其参数")
            continue

        if class_type not in object_info:
            missing_classes.add(class_type)
            continue

        expected = _expected_widget_values(class_type, object_info)
        # 逐位置写入：跳过 __control_after_generate__ 这类 JS 追加控件的占位
        vi = 0
        for name in expected:
            if vi >= len(widgets):
                break
            val = widgets[vi]
            vi += 1
            if name == "__control_after_generate__":
                continue  # 该值不进入 API
            # 只在不与连线冲突时写入
            if name not in inputs:
                inputs[name] = val
        if vi != len(widgets):
            warnings.append(
                f"节点 {nid}（{class_type}）控件数量对不上：工作流 {len(widgets)} 个，"
                f"节点定义 {len(expected)} 个，可能漏/多了参数"
            )

    if missing_classes:
        warnings.append(
            "后端缺少这些节点定义，未能写入其控件参数："
            + "、".join(sorted(missing_classes))
        )
    return api, warnings


def _resolve_by_link_id(
    wf_ui: dict[str, Any], link_id: Any, links: dict[tuple[int, int], tuple[str, int]]
) -> list | None:
    """用 link id 找到源 ``[node_id, slot]``。"""
    for lk in wf_ui.get("links") or []:
        if not isinstance(lk, list) or len(lk) < 3:
            continue
        if str(lk[0]) == str(link_id):
            return [str(lk[1]), int(lk[2])]
    return None
