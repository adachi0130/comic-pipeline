"""旧 MED 存档（fabric.js JSON）→ 新编辑文档。

为什么不直接丢弃旧档：用户已有项目里的 ``med_doc`` 是唯一保留了图片构图、气泡、
文字的编辑状态。删掉就等于丢失。因此这里做**只读转换**，并明确列出无法转换的内容，
绝不静默丢弃。

fabric 对象的关键几何约定（实测自本项目存档）：
- ``polygon``：``points`` 是**相对对象中心**的局部坐标；``left``/``top`` 是未旋转时的
  左上角，``angle`` 为绕中心旋转角度，``scaleX``/``scaleY`` 为缩放。
  顶点在页面上的坐标 = 中心 + 旋转后的（局部点 × 缩放）。
- ``image``：``left``/``top`` 是左上角（originX/originY 可能是 center），
  ``width``/``height`` 是裁切后显示尺寸，``scaleX``/``scaleY`` 为缩放，
  ``clipPath`` 可能带绝对定位的裁剪多边形。
- ``textbox``/``text``：文本元素，可映射为 ``text`` 类元素。
- ``rect``：通常作为底板，映射为 ``text`` 元素的填充或直接忽略并记录。

转换结果会带上 ``conversion`` 摘要：``converted`` / ``dropped`` / ``warnings``，
前端据此提示“哪些内容没能带过来”，而不是假装完整。
"""

from __future__ import annotations

import json
import math
from typing import Any

from .document import DEFAULT_LAYERS, SCHEMA_VERSION, EDITOR_ID
from .fabric_paths import is_invisible_object, rasterize_group


class LegacyConversionError(ValueError):
    """旧存档结构无法识别。"""


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _local_points(obj: dict) -> list[tuple[float, float]]:
    raw = obj.get("points") or []
    out = []
    for point in raw:
        if isinstance(point, dict) and "x" in point and "y" in point:
            out.append((_num(point["x"]), _num(point["y"])))
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            out.append((_num(point[0]), _num(point[1])))
    return out


def _object_center(obj: dict, half_width: float, half_height: float) -> tuple[float, float]:
    """fabric 的 left/top 依 originX/originY 不同含义；统一折算成中心点。"""
    left, top = _num(obj.get("left")), _num(obj.get("top"))
    origin_x = (obj.get("originX") or "left").lower()
    origin_y = (obj.get("originY") or "top").lower()
    center_x = left + (0 if origin_x == "left" else -half_width if origin_x == "right" else -half_width)
    # 上面一行等价写清：left/center/right 三种原点
    if origin_x == "left":
        center_x = left + half_width
    elif origin_x == "right":
        center_x = left - half_width
    else:
        center_x = left
    if origin_y == "top":
        center_y = top + half_height
    elif origin_y == "bottom":
        center_y = top - half_height
    else:
        center_y = top
    return center_x, center_y


def _page_points(obj: dict) -> list[list[float]]:
    local = _local_points(obj)
    if len(local) < 3:
        return []
    scale_x = _num(obj.get("scaleX"), 1.0) or 1.0
    scale_y = _num(obj.get("scaleY"), 1.0) or 1.0
    width = _num(obj.get("width")) * scale_x
    height = _num(obj.get("height")) * scale_y
    center_x, center_y = _object_center(obj, width / 2, height / 2)
    angle = math.radians(_num(obj.get("angle")))
    cos, sin = math.cos(angle), math.sin(angle)
    points = []
    for x, y in local:
        sx, sy = x * scale_x, y * scale_y
        points.append([center_x + sx * cos - sy * sin, center_y + sx * sin + sy * cos])
    return points


def _image_record(obj: dict) -> dict | None:
    src = obj.get("src")
    if not isinstance(src, str) or not src.startswith("data:image/"):
        return None
    scale_x = _num(obj.get("scaleX"), 1.0) or 1.0
    scale_y = _num(obj.get("scaleY"), 1.0) or 1.0
    width = _num(obj.get("width"))
    height = _num(obj.get("height"))
    center_x, center_y = _object_center(obj, width * scale_x / 2, height * scale_y / 2)
    return {
        "dataUrl": src,
        "width": width,
        "height": height,
        # 新文档用“原图尺寸 × scale”摆放；这里把 fabric 的显示缩放还原成它
        "scale": max(scale_x, scale_y),
        "x": center_x - width * scale_x / 2,
        "y": center_y - height * scale_y / 2,
        "rotation": _num(obj.get("angle")),
    }


def _text_element(obj: dict, order: int) -> dict:
    # MED 的 textbox 用 originX/originY = center/center 序列化；新文档的 x/y 是
    # 左上角。按中心原点折算，否则文字会整体偏右下、跑出手绘气泡。
    scale_x = _num(obj.get("scaleX"), 1.0) or 1.0
    scale_y = _num(obj.get("scaleY"), 1.0) or 1.0
    width = max(24.0, _num(obj.get("width"), 240.0) * scale_x)
    height = max(24.0, _num(obj.get("height"), 80.0) * scale_y)
    center_x, center_y = _object_center(obj, width / 2, height / 2)
    left, top = center_x - width / 2, center_y - height / 2
    font_size = _num(obj.get("fontSize"), 28.0)
    fill = obj.get("fill")
    kind = "text"
    return {
        "id": str(obj.get("name") or obj.get("id") or f"text-{order}"),
        "kind": kind,
        "name": str(obj.get("name") or ""),
        "layerId": "dialogue",
        "order": order,
        "x": left,
        "y": top,
        "width": width,
        "height": height,
        "rotation": _num(obj.get("angle")),
        "skewX": _num(obj.get("skewX")),
        "skewY": _num(obj.get("skewY")),
        "flipX": bool(obj.get("flipX")),
        "flipY": bool(obj.get("flipY")),
        "opacity": _num(obj.get("opacity"), 1.0),
        "presetId": None,
        "dataUrl": None,
        "text": str(obj.get("text") or ""),
        "fontFamily": str(obj.get("fontFamily") or "sans-serif"),
        "fontSize": font_size,
        "textAlign": str(obj.get("textAlign") or "center"),
        "writingMode": "horizontal-tb",
        "lineHeight": _num(obj.get("lineHeight"), 1.25) or 1.25,
        "color": str(fill) if isinstance(fill, str) and fill.startswith("#") else "#111111",
        "fill": "none",
        "stroke": "#111111",
        "strokeWidth": 0,
        "feather": 0,
        "mask": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1}],
    }


def _infer_canvas(objects: list) -> tuple[float, float]:
    """从所有画框/图片的外接范围推导画布尺寸（早期存档没写 width/height）。

    取最大值并向上取整到 1px，避免裁剪掉最外侧画框的边线。
    """
    max_x = max_y = 0.0
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        kind = (obj.get("type") or "").lower()
        if kind == "polygon":
            points = _page_points(obj)
            if points:
                max_x = max(max_x, max(point[0] for point in points))
                max_y = max(max_y, max(point[1] for point in points))
            continue
        if kind == "image":
            scale_x = _num(obj.get("scaleX"), 1.0) or 1.0
            scale_y = _num(obj.get("scaleY"), 1.0) or 1.0
            width = _num(obj.get("width")) * scale_x
            height = _num(obj.get("height")) * scale_y
            center_x, center_y = _object_center(obj, width / 2, height / 2)
            max_x = max(max_x, center_x + width / 2)
            max_y = max(max_y, center_y + height / 2)
            continue
        left, top = _num(obj.get("left")), _num(obj.get("top"))
        width = _num(obj.get("width")) * (_num(obj.get("scaleX"), 1.0) or 1.0)
        height = _num(obj.get("height")) * (_num(obj.get("scaleY"), 1.0) or 1.0)
        if (obj.get("originX") or "left").lower() == "center":
            left -= width / 2
        if (obj.get("originY") or "top").lower() == "center":
            top -= height / 2
        max_x = max(max_x, left + width)
        max_y = max(max_y, top + height)
    if max_x <= 0 or max_y <= 0:
        return 0.0, 0.0
    return math.ceil(max_x), math.ceil(max_y)



def _same_points(a: list, b: list, tolerance: float = 0.5) -> bool:
    """两多边形顶点数相同且逐点误差在容差内（老快照的浮点噪声可忽略）。"""
    if len(a) != len(b):
        return False
    return all(
        abs(point_a[0] - point_b[0]) <= tolerance and abs(point_a[1] - point_b[1]) <= tolerance
        for point_a, point_b in zip(a, b)
    )


def convert_legacy_doc(doc: Any, *, page_ref: str, template_id: str = "") -> dict:
    """把 fabric 存档转成新编辑文档。

    ``doc`` 可以是 JSON 字符串或已解析对象。失败抛 ``LegacyConversionError``，
    由调用方决定是否退回“只显示旧整页图”。
    """
    if isinstance(doc, str):
        try:
            doc = json.loads(doc)
        except json.JSONDecodeError as exc:
            raise LegacyConversionError(f"旧存档不是合法 JSON：{exc}") from exc
    if not isinstance(doc, dict):
        raise LegacyConversionError("旧存档结构不是对象")

    width = _num(doc.get("width"))
    height = _num(doc.get("height"))

    objects = doc.get("objects") or []
    if not isinstance(objects, list):
        raise LegacyConversionError("旧存档 objects 不是数组")

    # 早期桥版本不写顶层 width/height，画布尺寸要靠对象外接范围推导。
    if width <= 0 or height <= 0:
        width, height = _infer_canvas(objects)
        if width <= 0 or height <= 0:
            raise LegacyConversionError("旧存档缺少有效画布尺寸，且无法从对象范围推导")

    panels: list[dict] = []
    elements: list[dict] = []
    strokes: list[dict] = []
    panel_by_name: dict[str, dict] = {}
    converted_ids: set[int] = set()
    dropped: list[str] = []
    warnings: list[str] = []
    converted_groups: list[str] = []
    skipped_invisible: list[str] = []

    # 第一遍：画框（polygon 且 isPanel 或名字像 polygonN）
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        if (obj.get("type") or "").lower() != "polygon":
            continue
        points = _page_points(obj)
        if len(points) < 3:
            dropped.append(f"polygon {obj.get('name') or ''}（顶点不足）")
            continue
        order = len(panels) + 1
        name = str(obj.get("name") or f"panel-{order}")
        panel = {
            "id": name,
            "layerId": "panels",
            "order": order,
            "type": "regular",
            "section": 0,
            "points": points,
            "borderWidth": _num(obj.get("strokeWidth"), 2.0),
            "panelRef": f"panel:{page_ref.split(':', 1)[-1]}.{order}",
            "panelOrder": order,
            "image": None,
            "task": None,
            "legacyName": name,
            "prompt": str(obj.get("text2img_prompt") or ""),
        }
        panels.append(panel)
        panel_by_name[name] = panel
        converted_ids.add(id(obj))

    # 第二遍：图片按 relatedPoly 绑到对应画框
    for obj in objects:
        if not isinstance(obj, dict) or id(obj) in converted_ids:
            continue
        kind = (obj.get("type") or "").lower()
        if kind == "image":
            image = _image_record(obj)
            if image is None:
                dropped.append(f"image {obj.get('name') or ''}（不是内嵌 dataURL）")
                continue
            target = None
            related = obj.get("relatedPoly")
            if isinstance(related, dict):
                target = panel_by_name.get(str(related.get("name") or ""))
            if target is None:
                name = str(obj.get("name") or "")
                for panel_name, panel in panel_by_name.items():
                    if panel_name and panel_name in name:
                        target = panel
                        break
            if target is None and isinstance(related, dict) and related.get("points"):
                # 老版本把 relatedPoly 存成完整对象快照且 name 为空（如 "undefined In Image"）。
                # 快照的页面顶点应与某个画框完全一致，按几何匹配兜底。
                related_points = _page_points(related)
                for panel in panels:
                    if _same_points(panel["points"], related_points):
                        target = panel
                        break
            if target is None:
                dropped.append(f"image {obj.get('name') or ''}（找不到所属画框）")
                continue
            target["image"] = image
            continue
        if kind in ("textbox", "text", "i-text"):
            elements.append(_text_element(obj, len(elements) + 1))
            continue
        if kind == "path":
            points = obj.get("path")
            dropped.append(f"path {obj.get('name') or ''}（自由笔迹转换尚未支持）")
            continue
        if kind == "group":
            children = (obj.get("objects") or [])
            child_kinds = {str(child.get("type") or "").lower() for child in children if isinstance(child, dict)}
            if child_kinds <= {"path"}:
                # MED 生成的技法图（集中线/运动线）：整组栅格化为贴纸，
                # 保留"作为整体移动/缩放/删除"的可用性（MED 里它们同样不可逐点编辑）。
                sticker = rasterize_group(obj)
                if sticker is not None:
                    sticker.update({
                        "id": str(obj.get("name") or f"technique-{len(elements) + 1}"),
                        "kind": "sticker",
                        "layerId": "dialogue",
                        "order": len(elements) + 1,
                        "rotation": 0, "skewX": 0, "skewY": 0, "flipX": False, "flipY": False,
                        "presetId": None, "text": "", "fontFamily": "sans-serif", "fontSize": 24,
                        "textAlign": "center", "writingMode": "horizontal-tb", "lineHeight": 1.25,
                        "color": "#111111", "fill": "none", "stroke": "#111111", "strokeWidth": 0,
                        "feather": 0,
                        "mask": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1}],
                        "legacyName": str(obj.get("name") or ""),
                    })
                    elements.append(sticker)
                    converted_groups.append(str(obj.get("name") or "group"))
                    warnings.append(
                        f"技法图 {sticker.get('name')} 已转换为位图贴纸（原为矢量），放大可能轻微模糊。")
                    continue
            dropped.append(f"group {obj.get('name') or ''}（组内类型 {','.join(sorted(child_kinds)) or '空'}，未转换）")
            continue
        if kind == "rect":
            if is_invisible_object(obj):
                # 透明底板在 MED 里也不渲染，转换记录说明即可，不算内容丢失。
                skipped_invisible.append(f"rect {obj.get('name') or ''}（透明底板，不参与渲染）")
                continue
            dropped.append(f"rect {obj.get('name') or ''}（可见矩形底板，未转换）")
            continue
        if kind in ("line", "circle", "triangle"):
            dropped.append(f"{kind} {obj.get('name') or ''}（装饰/底板，未转换）")
            continue
        dropped.append(f"{kind or '未知'}（未转换）")

    if not panels:
        raise LegacyConversionError("旧存档里没有可识别的分镜画框")

    bound = sum(1 for panel in panels if panel["image"])
    if bound < len(panels):
        warnings.append(f"{len(panels) - bound} 个画框没有内嵌图片，需重新贴图。")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "editor": EDITOR_ID,
        "width": width,
        "height": height,
        "layout": {"templateId": template_id, "canvas": [width, height], "orderSource": "legacy-fabric"},
        "layers": [dict(layer) for layer in DEFAULT_LAYERS],
        "panels": panels,
        "strokes": strokes,
        "elements": elements,
        "fonts": [],
        "binding": {
            "pageRef": page_ref,
            "templateId": template_id,
            "panelRefs": {str(panel["order"]): panel["panelRef"] for panel in panels},
        },
        "conversion": {
            "from": "med_doc/fabric",
            "converted": {
                "panels": len(panels),
                "images": bound,
                "elements": len(elements),
                "strokes": 0,
                "groups": len(converted_groups),
            },
            "dropped": dropped,
            "skipped_invisible": skipped_invisible,
            "warnings": warnings,
        },
    }
