"""API 与阶段存储回归：内存 SQLite、临时文件、mock 出图/MED，无应用 lifespan。"""
from __future__ import annotations

import atexit
import base64
import io
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from urllib.parse import quote
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
# app.db 导入会读取配置；在导入前隔离数据目录和数据库，保护真实环境。
_import_tmp = tempfile.TemporaryDirectory(prefix="safety-import-", dir=Path(__file__).parent)
atexit.register(_import_tmp.cleanup)
with patch.dict(os.environ, {"COMIC_DATA_DIR": str(Path(_import_tmp.name) / "data"),
                             "COMIC_DB_URL": "sqlite:///:memory:"}):
    from app.api.routes import artifacts as routes, pipeline
    from app import artifacts as A, storage
    from app.db import get_session
    from app.models import Artifact, ArtifactKind, ArtifactStatus, Base, Job, Project, Template
    from app.stages import book, compose, image
    from app.comfy import service
    from app.comfy.client import GeneratedImage
    from app.med.base import ComposeResult

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


def png(color):
    output = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(output, format="PNG")
    return output.getvalue()


def data_url(data):
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


class DataSafetyTests(unittest.TestCase):
    def test_med_save_review_and_book_export_keep_versions(self):
        first = self.client.post('/api/projects/1/med-doc/page:1', json={'doc': '{}', 'png': data_url(png('red'))})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()['has_preview'])
        first_page = self.session.get(Artifact, first.json()['page_image_id'])
        old_path = Path(first_page.path)
        old_bytes = old_path.read_bytes()
        self.assertEqual(first_page.status, 'review')
        reviewed = self.client.post('/api/projects/1/page-images/approve-all', json={'page_ref': 'page:1'})
        self.assertEqual(reviewed.json()['approved'], 2)
        self.assertTrue(self.client.get('/api/projects/1/readiness').json()['S6']['ready'])
        exported = book.handle(self.session, Job(project_id=1, payload={'format': 'cbz'}))
        old_book = A.current(self.session, 1, 'book', 'book')
        with zipfile.ZipFile(exported['files']['cbz']) as archive:
            self.assertEqual(len(archive.namelist()), 1)
            self.assertEqual(archive.read(archive.namelist()[0]), old_bytes)
        second = self.client.post('/api/projects/1/med-doc/page:1', json={'doc': '{"changed":true}', 'png': data_url(png('blue'))})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()['version'], 2)
        self.assertNotEqual(second.json()['page_image_id'], first.json()['page_image_id'])
        self.session.expire_all()
        self.assertEqual(self.session.get(Artifact, old_book.id).status, 'stale')
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertFalse(self.client.get('/api/projects/1/readiness').json()['S6']['ready'])

    def test_med_doc_without_preview_remains_editable(self):
        response = self.client.post('/api/projects/1/med-doc/page:1', json={'doc': '{"objects":[]}'})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['has_preview'])
        self.assertIsNone(response.json()['page_image_id'])
        reopened = self.client.get('/api/projects/1/med-doc/page:1')
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.json()['doc'], '{"objects":[]}')

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="api-safety-", dir=Path(__file__).parent)
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.data = self.base / "data"
        boundary = patch.object(storage, "_data_dir", return_value=self.data)
        boundary.start()
        self.addCleanup(boundary.stop)
        self.root = storage.project_root(1)
        self.root.mkdir(parents=True)
        self.external = self.base / "external.jsonl"
        self.external.write_bytes(b"external must survive")
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        factory = sessionmaker(bind=self.engine, autoflush=False)
        self.session = factory()
        self.addCleanup(self.session.close)
        self.session.add_all([Project(id=i, title="我的漫画", outline="", target_pages=1) for i in (1, 2, 10)])
        self.session.commit()
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        app.include_router(pipeline.router, prefix="/api")
        def isolated_session():
            with factory() as session:
                yield session
        app.dependency_overrides[get_session] = isolated_session
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def artifact(self, kind, ref, *, payload=None, path="", project_id=1):
        art = A.create(self.session, project_id=project_id, kind=kind, ref=ref,
                       payload=payload or {}, path=str(path), status="approved")
        self.session.commit()
        return art

    def candidate(self, path):
        return {"index": 0, "path": str(path), "seed": None, "params": {}}

    def file(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def link_dir(self, link, target):
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_api_rejects_link_escape_reads_and_delete(self):
        self.link_dir(self.root / "escape", self.base)
        linked = self.root / "escape" / self.external.name
        art = self.artifact("image", "panel:1.1", payload={"candidates": [self.candidate(linked)]})
        self.assertEqual(self.client.get(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)
        self.assertEqual(self.external.read_bytes(), b"external must survive")

    def test_api_rejects_output_directory_redirection(self):
        external = self.base / "external-output"
        external.mkdir()
        for category, endpoint, body in (
            ("candidates", "panels/panel:1.1/candidates", {"data_url": data_url(png("red"))}),
            ("med_pages", "med-doc/page:1", {"doc": "{}", "png": data_url(png("red"))}),
        ):
            self.link_dir(self.root / category, external)
            response = self.client.post(f"/api/projects/1/{endpoint}", json=body)
            self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(list(external.iterdir()), [])

    def test_api_rejects_external_reads_and_delete(self):
        art = self.artifact("image", "panel:1.1", payload={"candidates": [self.candidate(self.external)]})
        self.assertEqual(self.client.get(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)
        page = self.artifact("page_image", "page:1", path=self.external)
        self.assertEqual(self.client.get(f"/api/artifacts/{page.id}/file").status_code, 403)
        self.assertEqual(self.external.read_bytes(), b"external must survive")
        self.assertEqual(len(A.versions_of(self.session, 1, "image", "panel:1.1")), 1)

    def test_api_rejects_cross_project_and_ads_reads(self):
        for project_id in (2, 10):
            path = storage.project_root(project_id) / "other.png"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"other project")
            art = self.artifact("image", "panel:1.1", payload={"candidates": [self.candidate(path)]})
            self.assertEqual(self.client.get(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)
        valid = self.file("safe.png", png("red"))
        art = self.artifact("image", "panel:1.2", payload={"candidates": [self.candidate(str(valid) + ":secret")]})
        self.assertEqual(self.client.get(f"/api/artifacts/{art.id}/candidate/0").status_code, 403)

    def test_payload_injection_is_rejected_without_new_version(self):
        art = self.artifact("image", "panel:1.1", payload={"candidates": []})
        for body in ({"candidates": [self.candidate(self.external)]}, {"files": {"pdf": str(self.external)}},
                     {"path": str(self.external)}):
            response = self.client.patch(f"/api/artifacts/{art.id}/payload", json=body)
            self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(len(A.versions_of(self.session, 1, "image", "panel:1.1")), 1)

    def test_normal_prompt_edit_remains_compatible(self):
        art = self.artifact("panel_prompt", "panel:1.1", payload={"prompt_pos": "old", "loras": []})
        response = self.client.patch(f"/api/artifacts/{art.id}/payload", json={"prompt_pos": "new"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["version"], 2)
        self.assertEqual(self.client.get(f"/api/artifacts/{art.id}").json()["payload"]["prompt_pos"], "old")

    def test_legacy_page_download_is_unchanged(self):
        path = self.file("pages/page_1.png", png("red"))
        art = self.artifact("page_image", "page:1", path=path)
        response = self.client.get(f"/api/artifacts/{art.id}/file")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, path.read_bytes())

    def test_candidate_removal_preserves_history_and_bytes(self):
        paths = [self.file(f"candidates/old/cand_{i}.png", png(c)) for i, c in enumerate(("red", "green", "blue"))]
        candidates = [{**self.candidate(p), "index": i} for i, p in enumerate(paths)]
        art = self.artifact("image", "panel:1.1", payload={"candidates": candidates, "selected_index": 1})
        original = [p.read_bytes() for p in paths]
        response = self.client.delete(f"/api/artifacts/{art.id}/candidate/0")
        self.assertEqual(response.status_code, 200, response.text)
        current = self.client.get(f"/api/artifacts/{response.json()['artifact_id']}").json()
        self.assertEqual(current["version"], 2)
        self.assertEqual(current["payload"]["selected_index"], 0)
        self.assertEqual([c["index"] for c in current["payload"]["candidates"]], [0, 1])
        old = self.client.get(f"/api/artifacts/{art.id}").json()["payload"]
        self.assertEqual(old["candidates"], candidates)
        self.assertEqual(old["selected_index"], 1)
        self.assertEqual([p.read_bytes() for p in paths], original)
        self.assertEqual(self.client.get(f"/api/artifacts/{art.id}/candidate/0").content, original[0])

    def test_repeated_uploads_use_distinct_paths(self):
        ids, paths = [], []
        for color in ("red", "blue"):
            response = self.client.post("/api/projects/1/panels/panel:1.1/candidates", json={"data_url": data_url(png(color))})
            self.assertEqual(response.status_code, 200, response.text)
            aid = response.json()["artifact_id"]
            ids.append(aid)
            paths.append(self.client.get(f"/api/artifacts/{aid}").json()["payload"]["candidates"][-1]["path"])
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(Path(paths[0]).read_bytes(), png("red"))
        self.assertEqual(Path(paths[1]).read_bytes(), png("blue"))
        self.assertEqual(self.client.get(f"/api/artifacts/{ids[0]}/candidate/0").content, png("red"))

    def test_api_malicious_refs_do_not_write(self):
        before = set(self.root.rglob("*"))
        for ref, suffix in ((r"panel:1.1\..\..\external", "panels/{}/candidates"),
                            (r"page:1\..\external", "med-doc/{}")):
            body = {"data_url": data_url(png("red"))} if ref.startswith("panel") else {"doc": "{}", "png": data_url(png("red"))}
            url = "/api/projects/1/" + suffix.format(quote(ref, safe=""))
            response = self.client.post(url, json=body)
            self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(set(self.root.rglob("*")), before)
        self.assertEqual(self.external.read_bytes(), b"external must survive")

    def test_med_preview_versions_preserve_legacy_and_new_files(self):
        legacy = self.file("med_pages/page_1.png", png("green"))
        old = self.artifact("med_doc", "page:1", payload={"doc": "legacy"}, path=legacy)
        ids = []
        for color in ("red", "blue"):
            response = self.client.post("/api/projects/1/med-doc/page:1", json={"doc": color, "png": data_url(png(color))})
            self.assertEqual(response.status_code, 200, response.text)
            ids.append(response.json()["artifact_id"])
        records = [self.client.get(f"/api/artifacts/{aid}").json() for aid in ids]
        self.assertNotEqual(records[0]["path"], records[1]["path"])
        self.assertEqual(self.client.get(f"/api/artifacts/{old.id}/file").content, png("green"))
        for record, color in zip(records, ("red", "blue")):
            self.assertEqual(Path(record["path"]).read_bytes(), png(color))

    def composition_inputs(self, candidate_path=None):
        svg = self.data / "templates" / "test.svg"
        svg.parent.mkdir(parents=True)
        svg.write_text("<svg/>")
        self.session.add(Template(id="vertical:test", dir="vertical", panels_count=1, svg_path=str(svg), geometry={}))
        self.session.commit()
        self.artifact("page_script", "page:1", payload={"template_id": "vertical:test", "panels": [{"panel_order": 1}]})
        source = candidate_path or self.file("candidates/legacy.png", png("red"))
        self.artifact("image", "panel:1.1", payload={"candidates": [self.candidate(source)], "selected_index": 0})

    def test_compose_writes_new_files_without_overwriting_legacy(self):
        self.composition_inputs()
        legacy = self.file("pages/page_1.png", png("green"))
        old = self.artifact("page_image", "page:1", path=legacy)
        job = Job(project_id=1, kind="compose", payload={"page_ref": "page:1"})
        composer = Mock()
        composer.compose.side_effect = [(ComposeResult(ok=True, panels=1, placed=1), png(c)) for c in ("red", "blue")]
        with patch("app.med.composer.MedComposer", return_value=composer):
            results = [compose.handle(self.session, job) for _ in range(2)]
        self.assertNotEqual(results[0]["png"], results[1]["png"])
        self.assertEqual(Path(results[0]["png"]).read_bytes(), png("red"))
        self.assertEqual(Path(results[1]["png"]).read_bytes(), png("blue"))
        self.assertEqual(self.client.get(f"/api/artifacts/{old.id}/file").content, png("green"))

    def test_compose_rejects_external_candidate_before_browser(self):
        self.composition_inputs(self.external)
        with patch("app.med.composer.MedComposer") as browser, self.assertRaises(storage.StorageError):
            compose.handle(self.session, Job(project_id=1, kind="compose", payload={"page_ref": "page:1"}))
        browser.assert_not_called()
        self.assertEqual(self.external.read_bytes(), b"external must survive")

    def test_image_regeneration_preserves_previous_candidates(self):
        legacy = self.file("candidates/legacy.png", png("green"))
        old = self.artifact("image", "panel:1.1", payload={"candidates": [self.candidate(legacy)]})
        job = Job(project_id=1, kind="image", payload={"panel_ref": "panel:1.1", "count": 1})
        generated = [[GeneratedImage("out.png", "", "output", png(c))] for c in ("red", "blue")]
        paths = []
        with patch.object(service, "generate", side_effect=generated):
            for _ in range(2):
                image.handle(self.session, job)
                paths.append(A.current(self.session, 1, "image", "panel:1.1").payload["candidates"][0]["path"])
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(Path(paths[0]).read_bytes(), png("red"))
        self.assertEqual(Path(paths[1]).read_bytes(), png("blue"))
        self.assertEqual(self.client.get(f"/api/artifacts/{old.id}/candidate/0").content, png("green"))

    def test_save_images_refuses_filename_collision(self):
        output = storage.new_output_dir(1, "candidates", ref="panel:1.1")
        first = GeneratedImage("out.png", "", "output", png("red"))
        second = GeneratedImage("out.png", "", "output", png("blue"))
        path = service.save_images([first], output)[0]
        with self.assertRaises(FileExistsError):
            service.save_images([second], output)
        self.assertEqual(path.read_bytes(), png("red"))

    def test_real_pdf_cbz_exports_preserve_previous_and_legacy_files(self):
        self.artifact("page_image", "page:1", path=self.file("pages/page_1.png", png("red")))
        legacy_pdf = self.file("book/我的漫画.pdf", b"legacy pdf")
        legacy_cbz = self.file("book/我的漫画.cbz", b"legacy cbz")
        old = self.artifact("book", "book", path=legacy_pdf, payload={"files": {"pdf": str(legacy_pdf), "cbz": str(legacy_cbz)}})
        job = Job(project_id=1, kind="book", payload={"format": "both"})
        first = book.handle(self.session, job)["files"]
        original = {kind: Path(path).read_bytes() for kind, path in first.items()}
        self.artifact("page_image", "page:1", path=self.file("pages/blue.png", png("blue")))
        second = book.handle(self.session, job)["files"]
        for kind in ("pdf", "cbz"):
            self.assertNotEqual(first[kind], second[kind])
            self.assertEqual(Path(first[kind]).read_bytes(), original[kind])
        self.assertTrue(Path(first["pdf"]).read_bytes().startswith(b"%PDF"))
        for files, color in ((first, "red"), (second, "blue")):
            with zipfile.ZipFile(files["cbz"]) as archive:
                self.assertEqual(archive.read(archive.namelist()[0]), png(color))
        self.assertEqual(legacy_pdf.read_bytes(), b"legacy pdf")
        self.assertEqual(legacy_cbz.read_bytes(), b"legacy cbz")
        self.assertEqual(self.client.get(f"/api/artifacts/{old.id}/file").content, b"legacy pdf")

    def test_export_writers_never_overwrite_existing_file(self):
        page = self.file("pages/page_1.png", png("red"))
        for suffix, writer in (("pdf", book._make_pdf), ("cbz", book._make_cbz)):
            path = self.file(f"book/existing.{suffix}", b"keep")
            with self.assertRaises(FileExistsError):
                writer([page], path)
            self.assertEqual(path.read_bytes(), b"keep")

    def test_book_rejects_external_page_before_writing(self):
        self.artifact("page_image", "page:1", path=self.external)
        with self.assertRaises(storage.StorageError):
            book.handle(self.session, Job(project_id=1, kind="book", payload={"format": "both"}))
        self.assertFalse((self.root / "book").exists())
        self.assertEqual(self.external.read_bytes(), b"external must survive")


if __name__ == "__main__":
    unittest.main()
