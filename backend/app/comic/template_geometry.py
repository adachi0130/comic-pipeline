"""把本项目 MED 来源的模板 SVG 解析成可渲染的几何。

为什么需要这个模块：MED 的内部函数（``getPanelObjectList`` / ``sortPanelsInReadingOrder``）
是唯一知道“SVG 里这些 polygon 的阅读顺序”的地方。要脱离 MED 运行，就必须自己复刻
这两件事，并与 MED 的排序结果保持一致，否则 ``panel:页.格`` 会指向另一张画面。

**阅读顺序**：完全复刻 MED ``sortPanelsInReadingOrder`` 的算法——
先按 ``rect.top`` 升序，再把中心点落在已有行纵向区间内的并成一行，
行内按 ``rect.left`` 降序（右→左）。注意行区间以首个入行的分镜为准、后续不再扩张，
这是 MED 的原样行为，改动它会让已有项目页的格号错位。

模板 SVG 版权：来自 Manga Editor Desu!（GPL-3.0，作者 new-sankaku）。
本模块只读取其几何，不运行 MED。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from xml.etree import ElementTree

SVG_NS = "http://www.w3.org/2000/svg"

# 单位矩阵
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

_TRANSFORM_RE = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
_STYLE_PROP_RE = re.compile(r"([\w-]+)\s*:\s*([^;]+)")


class TemplateGeometryError(ValueError):
    """模板 SVG 无法解析成可用几何。"""


@dataclass
class Polygon:
    """画布坐标系里的一个画框。"""

    points: list[tuple[float, float]]
    border_width: float = 0.0
    fill: str = ""
    stroke: str = ""

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def area(self) -> float:
        return abs(_signed_area(self.points))


@dataclass
class TemplateGeometry:
    """一个模板的完整几何快照。"""

    canvas: tuple[float, float]
    polygons: list[Polygon] = field(default_factory=list)   # 文档顺序
    reading_order: list[int] = field(default_factory=list)  # 阅读顺序 → 文档下标

    @property
    def panel_count(self) -> int:
        return len(self.polygons)

    def polygon_for_order(self, panel_order: int) -> Polygon:
        """按 1-based 阅读顺序取画框。"""
        if not 1 <= panel_order <= len(self.reading_order):
            raise TemplateGeometryError(f"格序号越界：{panel_order}（共 {len(self.reading_order)}）")
        return self.polygons[self.reading_order[panel_order - 1]]

    def order_for_index(self, document_index: int) -> int:
        """文档下标 → 1-based 阅读顺序；不在阅读顺序里时返回 0。"""
        try:
            return self.reading_order.index(document_index) + 1
        except ValueError:
            return 0

    def to_dict(self) -> dict:
        """转成 templates.geometry 兼容结构，并补充新编辑器需要的字段。

        ``index`` 保持文档顺序（旧消费者依赖它），``order`` 才是阅读顺序。
        两类消费者因此不会互相踩到：
        - 旧 ``prompt.py`` 只认 ``index``（快照里的旧页面行为不变）；
        - 新编辑器/渲染器只认 ``order``（与 MED 的 ``panel_order`` 一致）。
        """
        cw, ch = self.canvas
        box_area = (cw or 1.0) * (ch or 1.0)
        margin = 0.01 * max(cw or 0.0, ch or 0.0)
        panels = []
        for doc_index, poly in enumerate(self.polygons):
            x0, y0, x1, y1 = poly.bounds
            w, h = max(x1 - x0, 0.0), max(y1 - y0, 0.0)
            ratio = (w / h) if h else 0.0
            panels.append({
                "index": doc_index + 1,
                "order": self.order_for_index(doc_index),
                "shape": "landscape" if ratio > 1.25 else ("portrait" if ratio < 0.8 else "square"),
                "x_pct": _pct(x0, cw),
                "y_pct": _pct(y0, ch),
                "width_pct": _pct(w, cw),
                "height_pct": _pct(h, ch),
                "area_pct": round((w * h) / box_area * 100, 1) if box_area else 0.0,
                "bleed": bool(x0 <= margin or y0 <= margin or x1 >= cw - margin or y1 >= ch - margin),
                # 完整顶点（百分比），让斜切/重叠格不被矩形化
                "points_pct": [[_pct(x, cw), _pct(y, ch)] for x, y in poly.points],
                "border_width": round(poly.border_width, 3),
            })
        return {
            "canvas": [round(cw, 2), round(ch, 2)],
            "panels": panels,
            "reading_order": [i + 1 for i in self.reading_order],
        }


def _pct(value: float, total: float) -> float:
    return round(value / total * 100, 3) if total else 0.0


def _signed_area(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for i, (x, y) in enumerate(points):
        nx, ny = points[(i + 1) % len(points)]
        total += x * ny - nx * y
    return total / 2.0


# ---------------------------------------------------------------- SVG 解析
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _nums(text: str) -> list[float]:
    return [float(v) for v in _NUM_RE.findall(text or "")]


def _mat_mul(m1: tuple[float, ...], m2: tuple[float, ...]) -> tuple[float, ...]:
    """先 m1 再 m2 的复合矩阵（SVG 语义：m1 在外层）。"""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _parse_transform(text: str) -> tuple[float, ...]:
    matrix = IDENTITY
    for kind, args in _TRANSFORM_RE.findall(text or ""):
        v = _nums(args)
        if kind == "matrix" and len(v) >= 6:
            m = tuple(v[:6])
        elif kind == "translate" and v:
            m = (1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0)
        elif kind == "scale" and v:
            sx = v[0]
            sy = v[1] if len(v) > 1 else sx
            m = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif kind == "rotate" and v:
            angle = math.radians(v[0])
            cos, sin = math.cos(angle), math.sin(angle)
            m = (cos, sin, -sin, cos, 0.0, 0.0)
            if len(v) >= 3:  # 绕指定点旋转
                cx, cy = v[1], v[2]
                m = _mat_mul(m, (1.0, 0.0, 0.0, 1.0, -cx, -cy))
                m = _mat_mul((1.0, 0.0, 0.0, 1.0, cx, cy), m)
        elif kind in ("skewX", "skewY") and v:
            t = math.tan(math.radians(v[0]))
            m = (1.0, 0.0, t, 1.0, 0.0, 0.0) if kind == "skewX" else (1.0, t, 0.0, 1.0, 0.0, 0.0)
        else:
            continue
        matrix = _mat_mul(matrix, m)
    return matrix


def _apply(matrix: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def _matrix_scale(matrix: tuple[float, ...]) -> float:
    a, b, c, d, _e, _f = matrix
    det = abs(a * d - b * c)
    return math.sqrt(det) if det else 1.0


def _style_of(element) -> dict[str, str]:
    style = {}
    for key, value in _STYLE_PROP_RE.findall(element.get("style") or ""):
        style[key.strip().lower()] = value.strip()
    for name in ("fill", "stroke", "stroke-width"):
        if element.get(name) is not None:
            style.setdefault(name, element.get(name))
    return style


def parse_template_svg(svg: str, *, right_to_left: bool = True) -> TemplateGeometry:
    """解析模板 SVG 全文，返回画布尺寸、全部多边形与阅读顺序。"""
    if not isinstance(svg, str) or "<svg" not in svg.lower():
        raise TemplateGeometryError("模板 SVG 内容为空或不是 SVG")
    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError as exc:
        raise TemplateGeometryError(f"模板 SVG 解析失败：{exc}") from exc
    if _local(root.tag) != "svg":
        raise TemplateGeometryError("模板 SVG 根节点不是 <svg>")

    canvas = _canvas_size(root)
    polygons: list[Polygon] = []
    _walk(root, IDENTITY, polygons, is_root=True)
    if not polygons:
        raise TemplateGeometryError("模板 SVG 里没有找到画框（polygon）")

    order = reading_order(polygons, right_to_left=right_to_left)
    return TemplateGeometry(canvas=canvas, polygons=polygons, reading_order=order)


def _canvas_size(root) -> tuple[float, float]:
    view_box = _nums(root.get("viewBox") or "")
    if len(view_box) >= 4 and view_box[2] > 0 and view_box[3] > 0:
        return view_box[2], view_box[3]
    width = _nums(root.get("width") or "")
    height = _nums(root.get("height") or "")
    if width and height and width[0] > 0 and height[0] > 0:
        return width[0], height[0]
    # 兜底：用所有多边形的外包范围
    return 1.0, 1.0


def _walk(element, matrix: tuple[float, ...], out: list[Polygon], *, is_root: bool = False) -> None:
    tag = _local(element.tag)
    if tag == "defs":  # 定义块里的图形不参与排版
        return
    current = _mat_mul(matrix, _parse_transform(element.get("transform") or ""))
    if tag in ("polygon", "path") and not is_root:
        points = _polygon_points(element)
        if len(points) >= 3:
            style = _style_of(element)
            border = _nums(style.get("stroke-width", ""))
            out.append(
                Polygon(
                    points=[_apply(current, x, y) for x, y in points],
                    border_width=(border[0] * _matrix_scale(current)) if border else 0.0,
                    fill=style.get("fill", ""),
                    stroke=style.get("stroke", ""),
                )
            )
        return
    for child in list(element):
        _walk(child, current, out)


def _polygon_points(element) -> list[tuple[float, float]]:
    if _local(element.tag) == "polygon":
        values = _nums(element.get("points") or "")
        return list(zip(values[0::2], values[1::2]))
    # path：只接受由 M/L/H/V/Z 组成的直线路径，遇到曲线就当作无法解析
    data = element.get("d") or ""
    if re.search(r"[CcSsQqTtAa]", data):
        raise TemplateGeometryError("模板路径包含曲线，无法转成画框多边形")
    points: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    for command, args in re.findall(r"([MmLlHhVvZz])([^MmLlHhVvZz]*)", data):
        values = _nums(args)
        if command in "Zz":
            continue
        relative = command.islower()
        if command in "Mm" and len(values) >= 2:
            for i in range(0, len(values) - 1, 2):
                cursor = (cursor[0] + values[i], cursor[1] + values[i + 1]) if relative else (values[i], values[i + 1])
                points.append(cursor)
        elif command in "Ll" and len(values) >= 2:
            for i in range(0, len(values) - 1, 2):
                cursor = (cursor[0] + values[i], cursor[1] + values[i + 1]) if relative else (values[i], values[i + 1])
                points.append(cursor)
        elif command in "Hh" and values:
            for value in values:
                cursor = (cursor[0] + value, cursor[1]) if relative else (value, cursor[1])
                points.append(cursor)
        elif command in "Vv" and values:
            for value in values:
                cursor = (cursor[0], cursor[1] + value) if relative else (cursor[0], value)
                points.append(cursor)
    return points


def reading_order(polygons: list[Polygon], *, right_to_left: bool = True) -> list[int]:
    """复刻 MED ``sortPanelsInReadingOrder``：先按 top 分列，再按 left 排序。

    注意行区间以首个落行分镜的 top/bottom 为准且不再扩张（MED 原样行为）；
    改成“动态扩张行区间”会让跨格大图所在页的格号与历史项目错位。
    """
    items = []
    for index, poly in enumerate(polygons):
        x0, y0, x1, y1 = poly.bounds
        items.append({"index": index, "top": y0, "bottom": y1, "left": x0})
    items.sort(key=lambda item: item["top"])

    rows: list[dict] = []
    for item in items:
        center = item["top"] + (item["bottom"] - item["top"]) / 2
        row = next((r for r in rows if r["top"] <= center <= r["bottom"]), None)
        if row is None:
            row = {"top": item["top"], "bottom": item["bottom"], "items": []}
            rows.append(row)
        row["items"].append(item)

    ordered: list[int] = []
    for row in rows:
        row["items"].sort(key=lambda item: -item["left"] if right_to_left else item["left"])
        ordered.extend(item["index"] for item in row["items"])
    return ordered


# ------------------------------------------------------- 用于渲染的归一化
def panel_polygons_by_order(geometry: TemplateGeometry) -> list[list[tuple[float, float]]]:
    """按阅读顺序返回每格顶点（画布绝对坐标）。"""
    return [geometry.polygon_for_order(order).points for order in range(1, geometry.panel_count + 1)]


def panel_border_by_order(geometry: TemplateGeometry) -> list[float]:
    return [geometry.polygon_for_order(order).border_width for order in range(1, geometry.panel_count + 1)]
