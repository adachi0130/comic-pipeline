"""出图服务：把“一次出图请求”落到 ComfyUI 并取回图片字节。

供作业处理器（S5）与接口层复用。这里不碰数据库，只做纯出图。

后端地址、当前工作流、参数映射都来自 ``comfy.store``（前端可改、落盘持久）。
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path

from ..config import (
    WorkflowParams,
    get_settings,
    load_workflow_params,
)
from . import store
from .client import ComfyClient, GeneratedImage
from .workflow import apply

_params_cache: WorkflowParams | None = None
_params_cache_key: str = ""


def get_comfy_config():
    """当前出图后端配置（每次读盘，保证前端改完立即生效）。"""
    return store.load_comfy_config()


def get_client() -> ComfyClient:
    """按配置返回活动后端客户端（cloud=仙宫云 / local=本机）。"""
    s = get_settings()
    cfg = get_comfy_config()
    return ComfyClient(
        cfg.active_url() or s.comfy_base_url,
        timeout_s=s.comfy_timeout_s,
        api_key=cfg.active_api_key(),
    )


def get_local_client() -> ComfyClient:
    s = get_settings()
    cfg = get_comfy_config()
    return ComfyClient(cfg.local_url or s.comfy_local_fallback_url, timeout_s=s.comfy_timeout_s)


def get_workflow(*, name: str | None = None):
    """读取当前工作流（API 格式）。``name`` 为空时用配置里的活动工作流。"""
    cfg = get_comfy_config()
    wf_name = name or cfg.workflow_name
    if not wf_name:
        # 还没有选中任何工作流：直接给一句人话，而不是“文件不存在 xxx.json”
        from .workflow import WorkflowError

        raise WorkflowError(
            "还没有选中工作流。请到「出图 → 出图设置 → ② 工作流」导入一个工作流并「设为当前」。"
        )
    return store.load_workflow_json(wf_name)


def get_workflow_params(*, refresh: bool = False, name: str | None = None) -> WorkflowParams:
    """读取当前工作流的参数映射（按工作流名缓存）。"""
    global _params_cache, _params_cache_key
    cfg = get_comfy_config()
    wf_name = name or cfg.workflow_name
    key = wf_name or "__legacy__"
    if _params_cache is None or refresh or _params_cache_key != key:
        if wf_name:
            _params_cache = store.load_params(wf_name)
        else:
            _params_cache = load_workflow_params()
        _params_cache_key = key
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


def generate(
    req: GenRequest,
    *,
    client: ComfyClient | None = None,
    should_cancel=None,
    snapshot: dict | None = None,
) -> list[GeneratedImage]:
    """按请求出图，返回所有候选图的字节。

    ``snapshot`` 若给了 dict，会把**最后一次实际入队的工作流**（API 格式，含参数/LoRA）
    写进 ``snapshot['workflow']``，供"保存这张图的工作流快照"用。
    """
    client = client or get_client()
    params = get_workflow_params()
    if not params.bindings and not params.prompt_placeholder:
        raise RuntimeError(
            "工作流参数映射为空，也没有 %prompt% 占位符。请到「出图 → 出图设置」里选中工作流并「自动映射」。"
        )
    wf = get_workflow()

    # 默认参数兜底：用户在前端配的 default_params 先垫底，单格显式值覆盖之
    cfg = get_comfy_config()
    # seed 处理：<=0 或不填视为“随机”，由我们生成合法种子（ComfyUI KSampler 要求 seed>=0，
    # 且 API 工作流没有 control_after_generate，所以必须自己换种子才能让每张不同）。
    fixed_seed = req.seed if (req.seed is not None and req.seed > 0) else None
    merged = {**(cfg.default_params or {})}
    values: dict = {
        "prompt_pos": req.prompt_pos,
        "prompt_neg": req.prompt_neg,
        "seed": fixed_seed if fixed_seed is not None else random.randint(1, 2**31 - 1),
        "steps": req.steps,
        "cfg": req.cfg,
        "sampler": req.sampler,
        "scheduler": req.scheduler,
        "width": req.width,
        "height": req.height,
        "ckpt_name": req.ckpt_name,
        "denoise": req.denoise,
    }
    merged.update({k: v for k, v in values.items() if v is not None})
    merged.update(req.extra_values or {})

    results: list[GeneratedImage] = []
    for _ in range(max(1, req.count)):
        if should_cancel and should_cancel():
            break
        # 每张换一个合法种子，保证候选图不同（除非用户指定了固定 seed）
        if fixed_seed is None:
            merged["seed"] = random.randint(1, 2**31 - 1)
        applied = apply(wf, params, merged, req.loras)
        if snapshot is not None:
            snapshot["workflow"] = applied
        prompt_id = client.queue_prompt(applied)
        entry = client.wait_for(
            prompt_id,
            timeout_s=600.0,
            interval_s=get_settings().comfy_poll_interval_s,
            should_cancel=should_cancel,
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
