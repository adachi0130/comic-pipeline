"""无需第三方依赖的真实文件边界、链接和不可变写入测试。"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import storage


class StorageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="storage-safety-", dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.data = self.base / "data"
        self.patch = patch.object(storage, "_data_dir", return_value=self.data)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.root = storage.project_root(1)
        self.root.mkdir(parents=True)
        self.legacy = self.root / "pages" / "page_1.png"
        self.legacy.parent.mkdir()
        self.legacy.write_bytes(b"legacy")
        self.outside = self.base / "external.jsonl"
        self.outside.write_bytes(b"keep external data")

    def link_dir(self, link: Path, target: Path):
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            # 只在本测试新建的临时目录中创建联接，不需要管理员权限。
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                                    capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_legacy_file_is_readable_without_migration(self):
        self.assertEqual(storage.resolve_project_path(self.legacy, 1).read_bytes(), b"legacy")
        relative = os.path.relpath(self.legacy, Path.cwd())
        self.assertEqual(storage.resolve_project_path(relative, 1), self.legacy)

    def test_external_absolute_path_is_rejected(self):
        with self.assertRaises(storage.StorageError):
            storage.resolve_project_path(self.outside, 1)
        self.assertEqual(self.outside.read_bytes(), b"keep external data")

    def test_other_project_and_prefix_collision_are_rejected(self):
        for pid in (2, 10):
            path = storage.project_root(pid) / "page.png"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"other")
            with self.assertRaises(storage.StorageError):
                storage.resolve_project_path(path, 1)

    def test_malicious_path_components_are_rejected(self):
        values = ["", None, "\x00", str(self.root / ".." / "external.jsonl"),
                  str(self.legacy) + ":secret", r"C:\Windows\win.ini",
                  r"\\server\share\secret", r"\\?\C:\Windows\win.ini"]
        for value in values:
            with self.subTest(value=value), self.assertRaises(storage.StorageError):
                storage.resolve_project_path(value, 1)

    def test_symlink_or_junction_escape_is_rejected(self):
        self.link_dir(self.root / "escape", self.base)
        with self.assertRaises(storage.StorageError):
            storage.resolve_project_path(self.root / "escape" / self.outside.name, 1)

    def test_project_root_redirect_is_rejected(self):
        target = self.data / "projects" / "3"
        target.mkdir()
        self.link_dir(self.data / "projects" / "2", target)
        with self.assertRaises(storage.StorageError):
            storage.project_root(2)

    def test_output_redirect_is_rejected_before_any_write(self):
        external = self.base / "external"
        external.mkdir()
        self.link_dir(self.root / "med_pages", external)
        with self.assertRaises(storage.StorageError):
            storage.new_output_dir(1, "med_pages", ref="page:1")
        self.assertEqual(list(external.iterdir()), [])

    def test_malicious_refs_cannot_create_files(self):
        before = set(self.root.rglob("*"))
        for kind, values in {"panel": ["../x", r"panel:1.1\..\x", "panel:1.1/../../x", "panel:0.1"],
                             "page": ["page:../x", r"page:1\..\x", "page:0", "page:1:stream"]}.items():
            for value in values:
                with self.subTest(value=value), self.assertRaises(storage.StorageError):
                    storage.new_output_dir(1, "candidates" if kind == "panel" else "pages", ref=value)
        self.assertEqual(set(self.root.rglob("*")), before)

    def test_every_output_category_keeps_previous_bytes(self):
        for category in ("candidates", "pages", "med_pages", "book"):
            ref = "panel:1.1" if category == "candidates" else "page:1" if category != "book" else None
            one = storage.new_output_dir(1, category, ref=ref) / "result.png"
            two = storage.new_output_dir(1, category, ref=ref) / "result.png"
            storage.write_new(one, b"version 1")
            storage.write_new(two, b"version 2")
            self.assertNotEqual(one, two)
            self.assertEqual(one.read_bytes(), b"version 1")
            self.assertEqual(two.read_bytes(), b"version 2")
        self.assertEqual(self.legacy.read_bytes(), b"legacy")

    def test_existing_file_is_never_overwritten(self):
        with self.assertRaises(FileExistsError):
            storage.write_new(self.legacy, b"replacement")
        self.assertEqual(self.legacy.read_bytes(), b"legacy")

    def test_directory_collision_fails_without_reuse(self):
        with patch.object(storage.uuid, "uuid4") as uuid:
            uuid.return_value.hex = "fixed"
            first = storage.new_output_dir(1, "pages", ref="page:1")
            storage.write_new(first / "keep.png", b"keep")
            with self.assertRaises(FileExistsError):
                storage.new_output_dir(1, "pages", ref="page:1")
            self.assertEqual((first / "keep.png").read_bytes(), b"keep")

    def test_concurrent_outputs_have_unique_paths(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(lambda _: storage.new_output_dir(1, "candidates", ref="panel:1.1"), range(16)))
        self.assertEqual(len(set(paths)), 16)

    @unittest.skipUnless(os.name == "nt", "Windows 扩展路径表示")
    def test_os_extended_prefix_does_not_reject_normal_project_path(self):
        original = Path.resolve
        def extended(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            return Path("\\\\?\\" + str(result))
        with patch.object(Path, "resolve", extended):
            self.assertEqual(storage.resolve_project_path(self.legacy, 1), self.legacy)
            self.assertEqual(storage.resolve_project_path(self.legacy, 1).read_bytes(), b"legacy")
            with self.assertRaises(storage.StorageError):
                storage.resolve_project_path(self.outside, 1)

    def test_payload_cannot_inject_file_references(self):
        for key in ("candidates", "files", "path"):
            with self.subTest(key=key), self.assertRaises(storage.StorageError):
                storage.validate_payload_edit({}, {key: str(self.outside)})
        storage.validate_payload_edit({"prompt_pos": "old"}, {"prompt_pos": "new", "loras": []})

    def test_missing_files_and_directories_are_not_downloadable(self):
        for path in (self.root, self.root / "missing.png"):
            with self.assertRaises(FileNotFoundError):
                storage.resolve_project_path(path, 1)

    def test_safe_export_names(self):
        for name in ("CON", "NUL.txt", "../comic", "comic.", 'bad:<>|name', "A" * 300):
            clean = storage.safe_filename(name)
            self.assertNotIn(":", clean)
            self.assertNotIn("/", clean)
            self.assertFalse(clean.endswith((".", " ")))
            self.assertLessEqual(len(clean), 106)
        self.assertEqual(storage.safe_filename("我的漫画"), "我的漫画")


if __name__ == "__main__":
    unittest.main()
