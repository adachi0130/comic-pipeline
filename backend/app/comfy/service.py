"""出图服务：把“一次出图请求”落到 ComfyUI 并取回图片字节。

供作业处理器（S5）与接口层复用。这里不碰数据库，只做纯出图。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..config import WorkflowParams, get_settings, load_workflow_params
from .client import ComfyClient, GeneratedImage
from .workflow import apply, load_workflow

_params_cache: WorkflowParams | None = None


def get_client() -> ComfyClient:
    s = get_settings()
    return ComfyClient(s.comfy_base_url, timeout_s=s.comfy_timeout_s)


def get_local_client() -> ComfyClient:
    s = get_settings()
    return ComfyClient(s.comfy_local_fallback_url, timeout_s=s.comfy_timeout_s)


def get_workflow_params(*, refresh: bool = False) -> WorkflowParams:
    global _params_cache
    if _params_cache is None or refresh:
        _params_cache = load_workflow_params()
    return _params_cache


@dataclass
class GenRequest:
    """一次出图请求（一格的 N 张候选）。"""

    prompt_pos: str
    prompt_neg: str = ""
    seed: int | None = None
    steps: int | None = None
    cfg: float | None = None
    sampler: str | None = None
    scheduler: str | None = None
    width: int | None = None
    height: int | None = None
    ckpt_name: str | None = None
    denoise: float | None = None
    loras: list[dict] = field(default_factory=list)   # [{"name":..., "weight":...}]
    count: int = 1
    extra_values: dict = field(default_factory=dict)


def generate(req: GenRequest, *, client: ComfyClient | None = None) -> list[GeneratedImage]:
    """按请求出图，返回所有候选图的字节。"""
    s = get_settings()
    client = client or get_client()
    params = get_workflow_params()
    if not params.bindings:
        raise RuntimeError(
            "工作流参数映射为空。请先运行 scripts/inspect_workflow.py 生成 config/workflow_params.yaml"
        )
    wf = load_workflow(s.workflow_path)

    values: dict = {
        "prompt_pos": req.prompt_pos,
        "prompt_neg": req.prompt_neg,
        "seed": req.seed if req.seed is not None else -1,
        "steps": req.steps,
        "cfg": req.cfg,
        "sampler": req.sampler,
        "scheduler": req.scheduler,
        "width": req.width,
        "height": req.height,
        "ckpt_name": req.ckpt_name,
        "denoise": req.denoise,
    }
    values = {k: v for k, v in values.items() if v is not None}
    values.update(req.extra_values or {})

    results: list[GeneratedImage] = []
    for _ in range(max(1, req.count)):
        # seed=-1 时让 ComfyUI 随机；每张确保不同
        applied = apply(wf, params, values, req.loras)
        prompt_id = client.queue_prompt(applied)
        entry = client.wait_for(
            prompt_id,
            timeout_s=600.0,
            interval_s=get_settings().comfy_poll_interval_s,
        )
        results.extend(client.collect_images(entry, output_node_ids=params.output_node_ids or None))
    return results


def save_images(images: list[GeneratedImage], out_dir: Path, *, stem: str = "cand") -> list[Path]:
    """把候选图写到磁盘，返回路径列表。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, img in enumerate(images, start=1):
        p = out_dir / f"{stem}_{i:02d}{_ext(img.filename)}"
        p.write_bytes(img.data)
        paths.append(p)
    return paths


def _ext(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    return suffix if suffix in (".png", ".jpg", ".jpeg", ".webp") else ".png"
