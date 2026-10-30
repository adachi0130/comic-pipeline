"""模板几何服务：把 SVG 解析结果补齐进 ``templates.geometry``。

数据库里已有的 ``geometry``（由 ``build_template_menu.py`` 生成）只有百分比外接矩形，
不足以还原斜切/重叠格的真实外形。本模块在读取时按 SVG 现算一份完整快照，
**不覆盖旧字段**，只追加 ``polygons`` / ``reading_order`` / 每格 ``order``。

为什么在读取时算而不是写库：模板 SVG 是导出到 ``data/templates`` 的稳定文件，
每次读取都解析成本很低（69 个文件实测毫秒级），而写库会让“删库重建”与
“模板文件更新”之间出现漂移。需要固定快照时（如分格脚本）另行写入 payload。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from ..models import Template
from .template_geometry import TemplateGeometry, TemplateGeometryError, parse_template_svg


def template_svg_text(template: Template) -> str:
    if not template.svg_path:
        return ""
    path = Path(template.svg_path)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def geometry_for(template: Template) -> dict:
    """返回模板几何：优先用 SVG 现算，失败时退回库里已有的旧几何。"""
    stored = dict(template.geometry or {})
    svg = template_svg_text(template)
    if not svg:
        return stored
    try:
        fresh = parse_template_svg(svg).to_dict()
    except TemplateGeometryError:
        return stored
    # 旧字段（无 order/polygons）直接补全；已有新字段时以新算结果为准。
    merged = {**stored, **fresh}
    return merged


def load_geometry(session: Session, template_id: str) -> TemplateGeometry | None:
    """按模板 ID 取解析后的几何对象；模板或 SVG 缺失时返回 None。"""
    template = session.get(Template, template_id)
    if template is None:
        return None
    svg = template_svg_text(template)
    if not svg:
        return None
    try:
        return parse_template_svg(svg)
    except TemplateGeometryError:
        return None
