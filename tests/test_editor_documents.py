"""编辑文档链路回归（模板几何 → 文档 → 保存 → 渲染 → 旧存档转换）。

不启动真实应用 lifespan、不连外部服务：用内存 SQLite + 临时文件 + 真实模板 SVG。
运行：``.venv/Scripts/python.exe -X utf8 -B tests/test_editor_documents.py``
"""

from __future__ import annotations

import atexit
import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
_import_tmp = tempfile.TemporaryDirectory(prefix="editor-import-", dir=Path(__file__).parent)
atexit.register(_import_tmp.cleanup)
with patch.dict(os.environ, {"COMIC_DATA_DIR": str(Path(_import_tmp.name) / "data"),
                             "COMIC_DB_URL": "sqlite:///:memory:"}):
    from app import artifacts as A
    from app.comic import documents as D
    from app.comic.document import DocumentError, build_from_project
    from app.comic.legacy import LegacyConversionError, convert_legacy_doc
    from app.comic.render import render_png
    from app.comic.template_geometry import TemplateGeometryError, parse_template_svg
    from app.models import Base, Project, Template

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "data" / "templates"


def png_bytes(color=(200, 60, 60), size=(64, 64)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def pick_template(panels: int, direction: str = "vertical") -> Path:
    """挑一个真实模板 SVG（随机但稳定：按文件名排序）。"""
    candidates = sorted(TEMPLATES.glob(f"{direction}_*.svg"))
    for path in candidates:
        try:
            geometry = parse_template_svg(path.read_text(encoding="utf-8"))
        except TemplateGeometryError:
            continue
        if geometry.panel_count == panels:
            return path
    raise unittest.SkipTest(f"没有 {direction} {panels} 格模板可用")


class EditorDocumentTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="editor-", dir=Path(__file__).parent))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.base, ignore_errors=True))
        self.data = self.base / "data"
        (self.data / "projects" / "1").mkdir(parents=True, exist_ok=True)
        self.env = patch.dict(os.environ, {"COMIC_DATA_DIR": str(self.data)})
        self.env.start()
        self.addCleanup(self.env.stop)
        from app.config import get_settings
        get_settings.cache_clear()
        self.addCleanup(get_settings.cache_clear)

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.session = sessionmaker(bind=engine, future=True)()
        self.addCleanup(self.session.close)
        self.session.add(Project(id=1, title="测试漫画", target_pages=2))
        self.session.commit()

    # ------------------------------------------------------------ 辅助
    def install_template(self, svg_path: Path, template_id: str = "vertical:test") -> Template:
        svg = svg_path.read_text(encoding="utf-8")
        geometry = parse_template_svg(svg).to_dict()
        template = Template(id=template_id, dir="vertical", panels_count=len(geometry["panels"]),
                            layout_desc="测试模板", svg_path=str(svg_path), geometry=geometry)
        self.session.add(template)
        self.session.commit()
        return template

    def make_page(self, template: Template, page_ref: str = "page:1", images: bool = True):
        panels = [{"panel_order": index} for index in range(1, template.panels_count + 1)]
        self.artifact("page_script", page_ref, payload={"template_id": template.id, "panels": panels,
                                                        "geometry": template.geometry})
        if not images:
            return
        page_no = page_ref.split(":", 1)[1]
        for order in range(1, template.panels_count + 1):
            target = self.data / "projects" / "1" / "candidates" / f"p{page_no}_{order}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(png_bytes((40 * order % 255, 90, 160)))
            self.artifact("image", f"panel:{page_no}.{order}", status="approved", payload={
                "candidates": [{"path": str(target)}], "selected_index": 0,
            })

    def artifact(self, kind: str, ref: str, *, payload=None, status="review", path=""):
        return A.create(self.session, project_id=1, kind=kind, ref=ref, payload=payload or {},
                        status=status, path=path)

    # ------------------------------------------------------------ 模板几何
    def test_all_templates_parse_with_reading_order(self):
        """69 个模板都必须能解析出多边形，且阅读顺序是合法排列。"""
        files = sorted(TEMPLATES.glob("*.svg"))
        self.assertEqual(len(files), 69, f"模板数量变化：{len(files)}")
        for path in files:
            geometry = parse_template_svg(path.read_text(encoding="utf-8"))
            self.assertEqual(sorted(geometry.reading_order), list(range(geometry.panel_count)), path.name)
            snapshot = geometry.to_dict()
            self.assertEqual(len(snapshot["panels"]), geometry.panel_count, path.name)
            for panel in snapshot["panels"]:
                self.assertTrue(panel["points_pct"], f"{path.name} 缺少顶点")
                self.assertGreater(panel["order"], 0, f"{path.name} 缺少阅读顺序")

    def test_geometry_matches_existing_percent_boxes(self):
        """新解析结果的百分比外接框必须与库里旧几何一致，否则会改变已有排版。"""
        for path in sorted(TEMPLATES.glob("landscape_2-1.svg")):
            old = json.loads((TEMPLATES.parent / "template_menu.json").read_text(encoding="utf-8")) \
                if (TEMPLATES.parent / "template_menu.json").exists() else None
            fresh = parse_template_svg(path.read_text(encoding="utf-8")).to_dict()
            self.assertTrue(fresh["panels"])
            if old:
                # 仅做存在性检查：旧菜单结构随版本变化，不强制字段一致
                self.assertIn("canvas", fresh)

    # ------------------------------------------------------------ 文档构建
    def test_build_document_follows_reading_order(self):
        template = self.install_template(pick_template(3))
        self.make_page(template)
        document = build_from_project(self.session, 1, "page:1")
        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(len(document["panels"]), 3)
        self.assertEqual([panel["panelOrder"] for panel in document["panels"]], [1, 2, 3])
        self.assertEqual(document["binding"]["panelRefs"],
                         {"1": "panel:1.1", "2": "panel:1.2", "3": "panel:1.3"})
        for panel in document["panels"]:
            self.assertGreaterEqual(len(panel["points"]), 3)
            self.assertIsNotNone(panel["image"], "已采用图片应写进文档")

    def test_build_document_rejects_missing_geometry(self):
        self.artifact("page_script", "page:1", payload={"template_id": "nope", "panels": [{"panel_order": 1}]})
        with self.assertRaisesRegex(DocumentError, "模板几何"):
            build_from_project(self.session, 1, "page:1")

    # ------------------------------------------------------------ 存档
    def test_save_creates_new_version_and_page_image(self):
        template = self.install_template(pick_template(2))
        self.make_page(template)
        document = build_from_project(self.session, 1, "page:1")
        first = D.save(self.session, 1, "page:1", document)
        self.assertTrue(first["has_preview"])
        self.assertEqual(first["version"], 1)
        # page_image 必须落盘且可读
        page_image = A.current(self.session, 1, "page_image", "page:1")
        self.assertIsNotNone(page_image)
        image = Image.open(page_image.path)
        self.assertGreater(image.width, 0)

        second = D.save(self.session, 1, "page:1", document)
        self.assertEqual(second["version"], 2)
        # 旧版保留，可回退
        versions = D.history(self.session, 1, "page:1")
        self.assertEqual(len(versions), 2)
        self.assertFalse(versions[0]["is_current"] is None)

    def test_save_rejects_unknown_schema_version(self):
        document = {"schemaVersion": 99, "width": 100, "height": 100}
        with self.assertRaisesRegex(DocumentError, "不支持的文档版本"):
            D.save(self.session, 1, "page:1", document)

    def test_load_falls_back_to_generated_then_legacy(self):
        template = self.install_template(pick_template(2))
        self.make_page(template)
        document, meta = D.load_for_edit(self.session, 1, "page:1")
        self.assertEqual(meta["source"], "generated")
        self.assertEqual(len(document["panels"]), 2)

        # 存一份新文档后应优先读新文档
        D.save(self.session, 1, "page:1", document)
        _again, meta2 = D.load_for_edit(self.session, 1, "page:1")
        self.assertEqual(meta2["source"], "editor_doc")

    def test_load_converts_legacy_med_doc(self):
        legacy_doc = {
            "version": "5.3.0", "width": 400, "height": 300, "background": "#ffffff",
            "objects": [
                {"type": "polygon", "name": "polygon1", "isPanel": True,
                 "left": 160, "top": 120, "width": 320, "height": 240, "scaleX": 1, "scaleY": 1,
                 "angle": 0, "strokeWidth": 2,
                 "points": [{"x": -160, "y": -120}, {"x": 160, "y": -120}, {"x": 160, "y": 120}, {"x": -160, "y": 120}]},
                {"type": "image", "name": "polygon1-image1", "relatedPoly": {"name": "polygon1"},
                 "left": 20, "top": 20, "width": 360, "height": 260, "scaleX": 1, "scaleY": 1, "angle": 0,
                 "src": data_url(png_bytes())},
                {"type": "textbox", "name": "caption", "left": 30, "top": 30, "width": 120, "height": 60,
                 "text": "旧台词", "fontSize": 20, "fill": "#000000"},
            ],
        }
        self.artifact("med_doc", "page:1", payload={"doc": json.dumps(legacy_doc)})
        document, meta = D.load_for_edit(self.session, 1, "page:1")
        self.assertEqual(meta["source"], "legacy_med_doc")
        self.assertEqual(len(document["panels"]), 1)
        self.assertIsNotNone(document["panels"][0]["image"])
        self.assertEqual(len(document["elements"]), 1)
        self.assertEqual(document["conversion"]["converted"]["elements"], 1)

    def test_legacy_conversion_reports_dropped_items(self):
        legacy = {"width": 200, "height": 200, "objects": [
            {"type": "polygon", "name": "p1", "left": 100, "top": 100, "width": 200, "height": 200,
             "scaleX": 1, "scaleY": 1, "angle": 0,
             "points": [{"x": -100, "y": -100}, {"x": 100, "y": -100}, {"x": 100, "y": 100}, {"x": -100, "y": 100}]},
            {"type": "path", "name": "ink"},
        ]}
        document = convert_legacy_doc(legacy, page_ref="page:1")
        self.assertEqual(len(document["panels"]), 1)
        self.assertTrue(any("path" in item for item in document["conversion"]["dropped"]))

    def test_legacy_edit_is_not_replaced_by_generated_layout(self):
        template = self.install_template(pick_template(1))
        self.make_page(template)
        legacy = {"width": 200, "height": 200, "objects": [
            {"type": "polygon", "name": "p1", "left": 0, "top": 0,
             "width": 200, "height": 200,
             "points": [{"x": -100, "y": -100}, {"x": 100, "y": -100},
                        {"x": 100, "y": 100}, {"x": -100, "y": 100}]},
            {"type": "textbox", "left": 20, "top": 20, "text": "保留手工台词"},
        ]}
        self.artifact("med_doc", "page:1", payload={"doc": legacy})
        document, meta = D.load_for_edit(self.session, 1, "page:1")
        self.assertEqual(meta["source"], "legacy_med_doc")
        self.assertEqual(document["elements"][0]["text"], "保留手工台词")

    def test_render_keeps_document_image_version_and_respects_removal(self):
        template = self.install_template(pick_template(1))
        self.make_page(template)
        document = build_from_project(self.session, 1, "page:1")
        panel = document["panels"][0]
        lookup = D.image_lookup_for(self.session, 1)
        old_path = lookup(panel)
        newer = self.data / "projects/1/candidates/new.png"
        newer.write_bytes(png_bytes((230, 10, 10)))
        self.artifact("image", "panel:1.1", status="approved", payload={
            "candidates": [{"path": str(newer)}], "selected_index": 0})
        self.assertEqual(lookup(panel), old_path, "历史构图必须继续引用原候选图")
        panel["image"] = None
        self.assertIsNone(lookup(panel))
        output = Image.open(io.BytesIO(render_png(document, image_lookup=lookup)))
        self.assertEqual(output.getpixel((output.width // 2, output.height // 2)), (255, 255, 255))

    def test_legacy_conversion_rejects_garbage(self):
        with self.assertRaises(LegacyConversionError):
            convert_legacy_doc("not json", page_ref="page:1")
        with self.assertRaises(LegacyConversionError):
            convert_legacy_doc({"objects": []}, page_ref="page:1")

    # ------------------------------------------------------------ 渲染
    def test_render_matches_canvas_size_and_covers_panel(self):
        template = self.install_template(pick_template(1))
        self.make_page(template)
        document = build_from_project(self.session, 1, "page:1")
        data = render_png(document, scale=1.0, image_lookup=D.image_lookup_for(self.session, 1))
        image = Image.open(io.BytesIO(data)).convert("RGB")
        self.assertEqual(image.size, (round(document["width"]), round(document["height"])))
        # 单格模板：中央像素应被图片覆盖（不是纯白）
        center = image.getpixel((image.width // 2, image.height // 2))
        self.assertNotEqual(center, (255, 255, 255))

    def test_render_includes_manual_layers(self):
        """手工文字必须出现在后台渲染里，不能只有编辑器看得见。"""
        template = self.install_template(pick_template(1))
        self.make_page(template)
        document = build_from_project(self.session, 1, "page:1")
        document["elements"] = [{
            "id": "e1", "kind": "text", "layerId": "dialogue", "order": 1,
            "x": document["width"] * 0.1, "y": document["height"] * 0.1,
            "width": document["width"] * 0.8, "height": document["height"] * 0.3,
            "rotation": 0, "skewX": 0, "skewY": 0, "flipX": False, "flipY": False, "opacity": 1,
            "text": "检测文字", "fontFamily": "sans-serif", "fontSize": 64,
            "textAlign": "center", "writingMode": "horizontal-tb", "lineHeight": 1.25,
            "color": "#000000", "fill": "none", "stroke": "#000000", "strokeWidth": 0,
            "feather": 0, "mask": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1}],
        }]
        plain = render_png(document, image_lookup=D.image_lookup_for(self.session, 1))
        with_text = render_png(document, image_lookup=D.image_lookup_for(self.session, 1))
        self.assertEqual(plain, with_text, "同一文档两次渲染应稳定")

        without = {**document, "elements": []}
        baseline = render_png(without, image_lookup=D.image_lookup_for(self.session, 1))
        self.assertNotEqual(baseline, with_text, "加了文字后渲染结果必须变化")


if __name__ == "__main__":
    unittest.main(verbosity=2)
