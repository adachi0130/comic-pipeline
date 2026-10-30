"""fabric.js path / group 的几何还原与栅格化。

只服务于旧存档转换（``legacy.py``）：MED 生成的技法图（集中线、运动线等）是
fabric ``group`` 包 ``path`` 的矢量对象。转换目标不是逐点还原矢量编辑能力——
MED 里它们本来也只能整组移动/缩放——而是**按页面坐标栅格化成一张贴纸**，
保留可见效果与"作为一个对象整体操作"的可用性。

fabric 的几何约定（按本项目真实存档核实）：
- path 命令是 ``["M", x, y]`` / ``["C", c1x, c1y, c2x, c2y, x, y]`` / ``["z"]`` 数组；
- path 对象的 ``left``/``top``（originX/Y=left/top）是"把命令包围盒的左上角平移到
  left/top"的位置，因此页内局部坐标 = ``(p - 命令包围盒min) + (left, top)``；
- group 的子对象坐标是相对 group 中心的；group 自己的 ``left``/``top``（originX/Y=
  left/top）是外接框左上角，页内中心 = ``(left + width*scaleX/2, top + height*scaleY/2)``，
  子对象页坐标 = group 中心 + 旋转/翻转后的（子对象局部坐标 × group 缩放）。
"""

from __future__ import annotations

import base64
import io
import math
import re
from typing import Any

from PIL import Image, ImageDraw

_RGBA_RE = re.compile(r"rgba?\(([^)]*)\)", re.I)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def color_to_rgba(value: Any, fallback=(0, 0, 0, 255)) -> tuple[int, int, int, int]:
    """解析 fabric 颜色：``rgb(...)`` / ``rgba(...)`` / ``#hex`` / ``transparent``。"""
    text = str(value or "").strip()
    if not text or text.lower() == "transparent":
        return (0, 0, 0, 0)
    match = _RGBA_RE.match(text)
    if match:
        parts = [p.strip() for p in match.group(1).split(",") if p.strip()]
        try:
            r, g, b = (int(float(p)) for p in parts[:3])
        except (ValueError, TypeError):
            return fallback
        alpha = 255
        if len(parts) > 3:
            try:
                alpha = int(round(float(parts[3]) * 255))
            except (ValueError, TypeError):
                alpha = 255
        return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)), max(0, min(255, alpha)))
    if text.startswith("#"):
        hexpart = text[1:]
        if len(hexpart) == 3:
            hexpart = "".join(ch * 2 for ch in hexpart)
        if len(hexpart) >= 6:
            try:
                return (int(hexpart[0:2], 16), int(hexpart[2:4], 16), int(hexpart[4:6], 16), 255)
            except ValueError:
                return fallback
    return fallback


def flatten_fabric_path(commands: list) -> list[list[tuple[float, float]]]:
    """把 fabric path 命令展开成折线集合（每段 ``M`` 开一条新折线）。

    曲线按固定段数采样，保证同一存档每次转换结果一致。返回的坐标仍在
    path 自身的命令坐标系里，调用方再按对象位置换算。
    """
    polylines: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    samples = 12
    for command in commands or []:
        if not isinstance(command, (list, tuple)) or not command:
            continue
        kind = str(command[0]).upper()
        values = [_num(v) for v in command[1:]]
        relative = str(command[0]).islower()
        if kind == "Z":
            if len(current) > 1:
                current.append(current[0])
            if current:
                polylines.append(current)
            current = []
            continue
        if kind in ("M", "L"):
            for index in range(0, len(values) - 1, 2):
                x, y = values[index], values[index + 1]
                if relative:
                    x += cursor[0]
                    y += cursor[1]
                if kind == "M" and index == 0:
                    if len(current) > 1:
                        polylines.append(current)
                    current = [(x, y)]
                else:
                    current.append((x, y))
                cursor = (x, y)
            continue
        if kind == "C":
            for index in range(0, len(values) - 5, 6):
                c1 = (values[index] + (cursor[0] if relative else 0),
                      values[index + 1] + (cursor[1] if relative else 0))
                c2 = (values[index + 2] + (cursor[0] if relative else 0),
                      values[index + 3] + (cursor[1] if relative else 0))
                end = (values[index + 4] + (cursor[0] if relative else 0),
                       values[index + 5] + (cursor[1] if relative else 0))
                for step in range(1, samples + 1):
                    t = step / samples
                    u = 1 - t
                    x = u**3 * cursor[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * end[0]
                    y = u**3 * cursor[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * end[1]
                    current.append((x, y))
                cursor = end
            continue
        if kind == "Q":
            for index in range(0, len(values) - 3, 4):
                ctrl = (values[index] + (cursor[0] if relative else 0),
                        values[index + 1] + (cursor[1] if relative else 0))
                end = (values[index + 2] + (cursor[0] if relative else 0),
                       values[index + 3] + (cursor[1] if relative else 0))
                for step in range(1, samples + 1):
                    t = step / samples
                    u = 1 - t
                    x = u * u * cursor[0] + 2 * u * t * ctrl[0] + t * t * end[0]
                    y = u * u * cursor[1] + 2 * u * t * ctrl[1] + t * t * end[1]
                    current.append((x, y))
                cursor = end
            continue
        if kind in ("H", "V"):
            for value in values:
                x, y = ((cursor[0] + value, cursor[1]) if relative else (value, cursor[1])) if kind == "H" \
                    else ((cursor[0], cursor[1] + value) if relative else (cursor[0], value))
                current.append((x, y))
                cursor = (x, y)
    if len(current) > 1:
        polylines.append(current)
    return polylines


def _path_command_bounds(polylines: list[list[tuple[float, float]]]) -> tuple[float, float]:
    xs = [p[0] for line in polylines for p in line]
    ys = [p[1] for line in polylines for p in line]
    if not xs or not ys:
        return 0.0, 0.0
    return min(xs), min(ys)


def _object_local_points(obj: dict) -> list[list[tuple[float, float]]]:
    """path 对象 → 组内局部坐标折线（left/top 平移到对象位置）。"""
    polylines = flatten_fabric_path(obj.get("path") or [])
    if not polylines:
        return []
    min_x, min_y = _path_command_bounds(polylines)
    left, top = _num(obj.get("left")), _num(obj.get("top"))
    return [[(left + (x - min_x), top + (y - min_y)) for x, y in line] for line in polylines]


def _apply_transform(
    points: list[tuple[float, float]],
    *,
    center: tuple[float, float],
    scale_x: float,
    scale_y: float,
    angle: float,
    flip_x: bool = False,
    flip_y: bool = False,
) -> list[tuple[float, float]]:
    radians = math.radians(angle)
    cos, sin = math.cos(radians), math.sin(radians)
    out = []
    for x, y in points:
        sx = -x if flip_x else x
        sy = -y if flip_y else y
        px = sx * scale_x
        py = sy * scale_y
        out.append((center[0] + px * cos - py * sin, center[1] + px * sin + py * cos))
    return out


def _group_page_points(group: dict, local_lines: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """把组内的多段折线逐条变换到页面坐标（保持线段分组，不摊平）。"""
    scale_x = _num(group.get("scaleX"), 1.0) or 1.0
    scale_y = _num(group.get("scaleY"), 1.0) or 1.0
    width = _num(group.get("width")) * scale_x
    height = _num(group.get("height")) * scale_y
    origin_x = (group.get("originX") or "left").lower()
    origin_y = (group.get("originY") or "top").lower()
    left, top = _num(group.get("left")), _num(group.get("top"))
    center_x = left + width / 2 if origin_x == "left" else (left - width / 2 if origin_x == "right" else left)
    center_y = top + height / 2 if origin_y == "top" else (top - height / 2 if origin_y == "bottom" else top)
    return [
        _apply_transform(
            line,
            center=(center_x, center_y),
            scale_x=scale_x,
            scale_y=scale_y,
            angle=_num(group.get("angle")),
            flip_x=bool(group.get("flipX")),
            flip_y=bool(group.get("flipY")),
        )
        for line in local_lines
    ]


def rasterize_group(group: dict, *, padding: int = 6) -> dict | None:
    """把一个纯 path 的 fabric group 栅格化为贴纸记录。

    返回 ``{"dataUrl", "x", "y", "width", "height", "rotation": 0, "opacity"}``；
    组内没有可用路径时返回 None。
    """
    local_lines: list[tuple[str, list[tuple[float, float]]]] = []
    for child in group.get("objects") or []:
        if not isinstance(child, dict) or (child.get("type") or "").lower() != "path":
            continue
        lines = _object_local_points(child)
        if lines:
            local_lines.append((child, lines))
    if not local_lines:
        return None

    # 先把所有子路径变换到页面坐标，再按页面包围盒栅格化。
    all_lines: list[tuple[dict, list[tuple[float, float]]]] = []
    for child, lines in local_lines:
        page_lines = _group_page_points(group, lines)
        if page_lines:
            all_lines.append((child, page_lines))
    if not all_lines:
        return None

    xs = [p[0] for _c, lines in all_lines for line in lines for p in line]
    ys = [p[1] for _c, lines in all_lines for line in lines for p in line]
    min_x, min_y = min(xs) - padding, min(ys) - padding
    max_x, max_y = max(xs) + padding, max(ys) + padding
    width = max(1, int(math.ceil(max_x - min_x)))
    height = max(1, int(math.ceil(max_y - min_y)))
    if width * height > 16_000_000:
        return None  # 防御：异常大的组不栅格化

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    scale_x = _num(group.get("scaleX"), 1.0) or 1.0
    scale_y = _num(group.get("scaleY"), 1.0) or 1.0
    average_scale = (abs(scale_x) + abs(scale_y)) / 2 or 1.0
    for child, lines in all_lines:
        fill = color_to_rgba(child.get("fill"), (0, 0, 0, 0))
        stroke = color_to_rgba(child.get("stroke"), (0, 0, 0, 0))
        stroke_width = max(1, int(round(_num(child.get("strokeWidth")) * average_scale)))
        page_lines = [[(x - min_x, y - min_y) for x, y in line] for line in lines]
        if fill[3] > 0:
            for line in page_lines:
                if len(line) >= 3:
                    draw.polygon(line, fill=fill)
        if stroke[3] > 0 and _num(child.get("strokeWidth")) > 0:
            for line in page_lines:
                if len(line) >= 2:
                    draw.line(line, fill=stroke, width=stroke_width, joint="curve")

    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", optimize=True)
    data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "dataUrl": data_url,
        "x": min_x,
        "y": min_y,
        "width": float(width),
        "height": float(height),
        "rotation": 0,
        "opacity": _num(group.get("opacity"), 1.0),
        "name": str(group.get("name") or "技法图"),
    }


def is_invisible_object(obj: dict) -> bool:
    """透明底板：填充与描边都不可见，也不透明度为 0。"""
    fill = color_to_rgba(obj.get("fill"), (0, 0, 0, 0))
    stroke = color_to_rgba(obj.get("stroke"), (0, 0, 0, 0))
    if fill[3] > 0 or stroke[3] > 0:
        return False
    return True
