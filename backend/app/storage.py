"""项目文件边界与新产物存储；旧路径保持原位，无数据迁移。"""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path


class StorageError(ValueError):
    pass


def validate_ref(ref: str, kind: str) -> str:
    patterns = {"panel": r"panel:[1-9][0-9]*\.[1-9][0-9]*", "page": r"page:[1-9][0-9]*"}
    if not isinstance(ref, str) or len(ref) > 128 or not re.fullmatch(patterns[kind], ref):
        raise StorageError(f"{kind} ref 不合法")
    return ref.replace(":", "_")


def _data_dir() -> Path:
    from .config import get_settings

    return get_settings().data_dir


def _resolved(path: Path) -> Path:
    resolved = path.resolve()
    # Windows 在父目录并发出现时，realpath 可能保留扩展前缀；统一 OS 返回的表示。
    # 客户端输入仍须先通过词法目录检查，设备路径无法借此跳过边界。
    text = str(resolved)
    if os.name == "nt":
        if text.startswith("\\\\?\\UNC\\"):
            return Path("\\\\" + text[8:])
        if re.match(r"^\\\\\?\\[A-Za-z]:\\", text):
            return Path(text[4:])
    return resolved


def project_root(project_id: int) -> Path:
    if isinstance(project_id, bool) or not isinstance(project_id, int) or project_id < 1:
        raise StorageError("项目 ID 不合法")
    data = _resolved(_data_dir())
    root = data / "projects" / str(project_id)
    # 拒绝 projects 或项目目录的符号链接/联接，防止跨项目和外部重定向。
    if _resolved(root) != root:
        raise StorageError("项目目录存在重定向")
    return root


def resolve_project_path(raw: str | Path, project_id: int, *, must_exist: bool = True) -> Path:
    """兼容已有绝对路径与相对路径；解析后只允许本项目内的普通文件。"""
    if not isinstance(raw, (str, Path)) or not str(raw) or "\x00" in str(raw):
        raise StorageError("文件路径不合法")
    path = Path(raw)
    # Windows ADS 以及显式遍历在解析前拒绝，避免触碰远程/外部路径。
    parts = path.parts[1:] if path.drive else path.parts
    if any(part == ".." or ":" in part for part in parts):
        raise StorageError("文件路径包含非法分量")
    root = project_root(project_id)
    absolute = path.absolute()
    nominal_root = _data_dir().absolute() / "projects" / str(project_id)
    if not (absolute.is_relative_to(root) or absolute.is_relative_to(nominal_root)):
        raise StorageError("文件路径超出本项目目录")
    try:
        resolved = _resolved(absolute)
    except (OSError, RuntimeError, ValueError) as exc:
        raise StorageError("文件路径无法解析") from exc
    if not resolved.is_relative_to(root):
        raise StorageError("文件链接超出本项目目录")
    if must_exist and not resolved.is_file():
        raise FileNotFoundError("产物文件不存在")
    return resolved


def new_output_dir(project_id: int, category: str, *, ref: str | None = None) -> Path:
    """每次写入建立独立 UUID 目录，存在时失败，绝不复用旧目录。"""
    if category not in {"candidates", "pages", "med_pages", "book"}:
        raise StorageError("产物目录类型不合法")
    parent = project_root(project_id) / category
    if ref is not None:
        parent /= validate_ref(ref, "panel" if category == "candidates" else "page")
    directory = parent / uuid.uuid4().hex
    resolve_project_path(directory, project_id, must_exist=False)
    parent.mkdir(parents=True, exist_ok=True)
    resolve_project_path(directory, project_id, must_exist=False)
    directory.mkdir(exist_ok=False)
    resolve_project_path(directory, project_id, must_exist=False)
    return directory


def write_new(path: Path, data: bytes) -> None:
    """排他创建，文件冲突时保留原文件并报错。"""
    with path.open("xb") as stream:
        stream.write(data)


def validate_payload_edit(existing: dict, changes: dict) -> None:
    # 文件引用只由上传/生成入口创建，防止通用编辑伪造或改写历史文件引用。
    for key in ("candidates", "files", "path"):
        if key in changes and changes[key] != existing.get(key):
            raise StorageError(f"{key} 文件引用由服务端管理，请使用上传或生成入口")


def safe_filename(name: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name).strip().rstrip(". ")[:100]
    clean = clean.rstrip(". ") or "comic"
    reserved = {"CON", "PRN", "AUX", "NUL"}
    reserved.update(f"{prefix}{n}" for prefix in ("COM", "LPT") for n in range(1, 10))
    if clean.split(".", 1)[0].upper() in reserved:
        clean = "comic_" + clean
    return clean
