"""从项目产物构建编辑文档（editor_doc）。

「同一页」有两个消费者：
1. 前端编辑器打开时，需要一份**可编辑文档**：分镜框来自模板几何、图片来自已采用的
   候选图，另可叠加用户手工图层。
2. 后台 S5 自动拼页，需要同样的几何和同样的图片，但不需要用户打开页面。

两者都走这里，所以拼出来的结果一致。默认生成的文档**只有版式和图片**，
不含任何装饰（集中线、运动线、文字），符合“一键生成只贴图”的要求。

文档格式（schemaVersion=1）：
```json
{
  "schemaVersion": 1,
  "editor": "comic-pipeline/editor",
  "width": 704.24, "height": 996,
  "layout": {"templateId": "vertical:ab_2_0", "canvas": [704.24, 996], "orderSource": "reading-order"},
  "layers": [{"id": "panels", "kind": "panels", "visible": true, "locked": false}, ...],
  "panels": [{"id", "layerId", "order", "type", "points", "borderWidth", "image", "panelRef"}],
  "strokes": [], "elements": [], "fonts": [],
  "binding": {"pageRef": "page:1", "templateId": "...", "panelRefs": {"1": "panel:1.1"}}
}
```
``panels[*].panelRef`` 与 ``binding.panelRefs`` 把画框稳定绑定到业务格
``panel:页.格``，删除/重排画框也不会让已有图片静默换位。
"""

from __future__ import annotations

import re
from typing import Callable

from sqlalchemy.orm import Session

from .. import artifacts as A
from ..models import ArtifactKind, Template
from .templates import geometry_for

SCHEMA_VERSION = 1
EDITOR_ID = "comic-pipeline/editor"

DEFAULT_LAYERS = [
    {"id": "panels", "name": "", "kind": "panels", "visible": True, "locked": False},
    {"id": "overlays", "name": "", "kind": "overlays", "visible": True, "locked": False},
    {"id": "dialogue", "name": "", "kind": "dialogue", "visible": True, "locked": False},
]


class DocumentError(ValueError):
    """页面产物不足以构建编辑文档。"""


def _legacy_order_map(entries: list[dict]) -> dict[int, int]:
    """给没有 ``order`` 的旧几何补出阅读顺序：``index → order``。

    旧快照只按 SVG 文档顺序存 ``index``，而本项目 69 个模板里有 58 个的文档顺序
    与阅读顺序不同。这里用外接矩形复算 MED 的排序（上→下分行、行内右→左），
    让老页面也能落到正确的业务格，而不是按数组下标错位。
    """
    rects = []
    for position, entry in enumerate(entries, start=1):
        index = int(entry.get("index") or position)
        x0 = float(entry.get("x_pct") or 0)
        y0 = float(entry.get("y_pct") or 0)
        x1 = x0 + float(entry.get("width_pct") or 0)
        y1 = y0 + float(entry.get("height_pct") or 0)
        rects.append({"index": index, "top": y0, "bottom": y1, "left": x0, "right": x1})

    rects.sort(key=lambda item: item["top"])
    rows: list[dict] = []
    for item in rects:
        center = item["top"] + (item["bottom"] - item["top"]) / 2
        row = next((candidate for candidate in rows if candidate["top"] <= center <= candidate["bottom"]), None)
        if row is None:
            row = {"top": item["top"], "bottom": item["bottom"], "items": []}
            rows.append(row)
        row["items"].append(item)

    mapping: dict[int, int] = {}
    order = 1
    for row in rows:
        row["items"].sort(key=lambda item: (-item["left"], item["top"]))
        for item in row["items"]:
            mapping[item["index"]] = order
            order += 1
    return mapping


def _points_from_geometry(geometry: dict, panel_order: int, canvas: list[float]) -> list[list[float]]:
    """优先用真实多边形；只有百分比矩形时按百分比还原成矩形顶点。"""
    cw, ch = float(canvas[0] or 1), float(canvas[1] or 1)
    entries = geometry.get("panels") or []

    has_order = any(entry.get("order") for entry in entries)
    index_to_order = {} if has_order else _legacy_order_map(entries)

    chosen = None
    for entry in entries:
        if has_order:
            if entry.get("order") == panel_order:
                chosen = entry
                break
        else:
            index = int(entry.get("index") or 0)
            if index_to_order.get(index) == panel_order:
                chosen = entry
                break
    if chosen is None:
        return []

    if chosen.get("points_pct"):
        return [[float(x) / 100.0 * cw, float(y) / 100.0 * ch] for x, y in chosen["points_pct"]]

    x = float(chosen.get("x_pct") or 0) / 100.0 * cw
    y = float(chosen.get("y_pct") or 0) / 100.0 * ch
    w = float(chosen.get("width_pct") or 0) / 100.0 * cw
    h = float(chosen.get("height_pct") or 0) / 100.0 * ch
    if w <= 0 or h <= 0:
        return []
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def panel_geometry_order(geometry: dict) -> dict[int, dict]:
    """order → 该格几何描述；旧几何按阅读顺序复算后映射。"""
    entries = geometry.get("panels") or []
    has_order = any(entry.get("order") for entry in entries)
    if has_order:
        return {int(entry.get("order")): entry for entry in entries if entry.get("order")}
    index_to_order = _legacy_order_map(entries)
    result: dict[int, dict] = {}
    for position, entry in enumerate(entries, start=1):
        index = int(entry.get("index") or position)
        order = index_to_order.get(index)
        if order:
            result[order] = entry
    return result


def page_number(page_ref: str) -> int:
    match = re.fullmatch(r"page:([1-9][0-9]*)", page_ref or "")
    if not match:
        raise DocumentError(f"页标识不合法：{page_ref}")
    return int(match.group(1))


def build_from_project(
    session: Session,
    project_id: int,
    page_ref: str,
    *,
    page_script=None,
    geometry: dict | None = None,
    image_resolver: Callable[[str, dict], dict | None] | None = None,
) -> dict:
    """按项目当前产物构建一页的编辑文档（仅版式 + 图片）。

    ``image_resolver(panel_ref, image_artifact)`` 可返回该格图片的附加描述
    （例如 ``{"dataUrl": ...}``）；后台拼页传路径解析器，前端传 URL。
    """
    if page_script is None:
        page_script = A.current(session, project_id, ArtifactKind.PAGE_SCRIPT.value, page_ref)
    if page_script is None:
        raise DocumentError(f"缺少分页脚本：{page_ref}")

    payload = page_script.payload or {}
    if geometry is None:
        template_id = payload.get("template_id")
        template = session.get(Template, template_id) if template_id else None
        geometry = payload.get("geometry") or (geometry_for(template) if template else {})
        # 旧页面快照里的几何只有百分比外接矩形，会让斜切/重叠格被矩形化。
        # 模板 SVG 还在时优先用现解析的真实顶点，视觉与阅读顺序都更准确。
        if template is not None and not any(entry.get("points_pct") for entry in (geometry.get("panels") or [])):
            fresh = geometry_for(template)
            if any(entry.get("points_pct") for entry in (fresh.get("panels") or [])):
                geometry = fresh
    if not geometry:
        raise DocumentError(f"{page_ref} 没有模板几何")

    canvas = [float(v) for v in (geometry.get("canvas") or [704, 996])]
    no = page_number(page_ref)
    panels_payload = sorted(payload.get("panels") or [], key=lambda item: item.get("panel_order") or 0)
    if not panels_payload:
        raise DocumentError(f"{page_ref} 没有分格")

    geometry_by_order = panel_geometry_order(geometry)
    panels = []
    panel_refs: dict[str, str] = {}
    for position, panel in enumerate(panels_payload, start=1):
        order = int(panel.get("panel_order") or position)
        points = _points_from_geometry(geometry, order, canvas)
        if len(points) < 3:
            raise DocumentError(f"{page_ref} 第 {order} 格缺少可用几何")
        entry = geometry_by_order.get(order) or {}
        panel_ref = f"panel:{no}.{order}"
        panel_refs[str(order)] = panel_ref
        border = entry.get("border_width")
        record = {
            "id": f"panel-{order}",
            "layerId": "panels",
            "order": order,
            "type": "regular",
            "section": 0,
            "points": points,
            "borderWidth": float(border if border is not None else 2.0),
            "panelRef": panel_ref,
            "panelOrder": order,
            "image": None,
            "task": None,
        }
        image_artifact = A.current(session, project_id, ArtifactKind.IMAGE.value, panel_ref)
        if image_artifact is not None:
            candidates = (image_artifact.payload or {}).get("candidates") or []
            index = (image_artifact.payload or {}).get("selected_index")
            if type(index) is int and 0 <= index < len(candidates):
                # 默认构图：图片按“铺满画框”摆放，编辑器打开即可看到已采用的图。
                # 这里不写死像素，而是给出 scale=0 表示“由前端按画框自动 cover”，
                # 并在 x/y/width/height 留 0 交由前端计算；若解析器提供了真实尺寸
                # （例如前端 URL 解析器），则用真实值。
                spec = {"scale": 0, "x": 0, "y": 0, "rotation": 0, "width": 0, "height": 0}
                spec["artifactId"] = image_artifact.id
                spec["candidateIndex"] = index
                spec["url"] = f"/api/artifacts/{image_artifact.id}/candidate/{index}"
                if image_resolver is not None:
                    extra = image_resolver(panel_ref, image_artifact)
                    if extra:
                        spec.update(extra)
                record["image"] = spec
        panels.append(record)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "editor": EDITOR_ID,
        "width": canvas[0],
        "height": canvas[1],
        "layout": {
            "templateId": payload.get("template_id"),
            "canvas": canvas,
            "orderSource": geometry.get("order_source") or ("reading-order" if geometry.get("reading_order") else "index"),
        },
        "layers": [dict(layer) for layer in DEFAULT_LAYERS],
        "panels": panels,
        "strokes": [],
        "elements": [],
        "fonts": [],
        "binding": {
            "pageRef": page_ref,
            "templateId": payload.get("template_id"),
            "scriptVersion": page_script.version,
            "panelRefs": panel_refs,
        },
    }


def panel_ref_of(document: dict, panel: dict) -> str:
    """画框 → 业务格标识；优先用画框自带的绑定，其次按 order 推。"""
    if panel.get("panelRef"):
        return str(panel["panelRef"])
    binding = document.get("binding") or {}
    refs = binding.get("panelRefs") or {}
    order = panel.get("panelOrder") or panel.get("order")
    if str(order) in refs:
        return str(refs[str(order)])
    page = binding.get("pageRef")
    if page and order:
        return f"panel:{page.split(':', 1)[-1]}.{int(order)}"
    return ""
