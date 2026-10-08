"""ComfyUI API 客户端。

只依赖 ComfyUI 原生 HTTP/WS 接口：
- ``GET  /object_info``     拉节点定义 → 从而得到 LoRA / checkpoint 候选列表
- ``POST /prompt``          入队（API 格式工作流）
- ``GET  /history/{id}``    取结果
- ``GET  /view``            下载图片字节

出图后端优先指向仙宫云（经 SSH 隧道映射到本地端口），本机 ComfyUI 可作备用调试。
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx


class ComfyError(RuntimeError):
    pass


@dataclass
class GeneratedImage:
    filename: str
    subfolder: str
    type: str
    data: bytes


class ComfyClient:
    def __init__(self, base_url: str, *, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    # ---------------- 探测 ----------------
    def ping(self) -> bool:
        try:
            r = httpx.get(f"{self.base_url}/system_stats", timeout=5.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    def object_info(self) -> dict[str, Any]:
        try:
            r = httpx.get(f"{self.base_url}/object_info", timeout=self.timeout_s)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ComfyError(f"拉取 /object_info 失败：{e}") from e
        return r.json()

    # ---------------- 资产列表 ----------------
    def _combo_candidates(self, info: dict[str, Any], node: str, field: str) -> list[str]:
        spec = (info.get(node) or {}).get("input", {})
        for group in ("required", "optional"):
            entry = (spec.get(group) or {}).get(field)
            if not entry:
                continue
            # combo 类型形如 [[候选...], {...}]
            if isinstance(entry, list) and entry and isinstance(entry[0], list):
                return [str(x) for x in entry[0]]
        return []

    def list_loras(self, info: dict[str, Any] | None = None) -> list[str]:
        """出图后端上的 LoRA 列表（来自 LoraLoader.lora_name 候选）。"""
        info = info or self.object_info()
        for node in ("LoraLoader", "LoraLoaderModelOnly"):
            if node in info:
                return self._combo_candidates(info, node, "lora_name")
        return []

    def list_checkpoints(self, info: dict[str, Any] | None = None) -> list[str]:
        info = info or self.object_info()
        return self._combo_candidates(info, "CheckpointLoaderSimple", "ckpt_name")

    def list_samplers(self, info: dict[str, Any] | None = None) -> list[str]:
        info = info or self.object_info()
        return self._combo_candidates(info, "KSampler", "sampler_name")

    def list_schedulers(self, info: dict[str, Any] | None = None) -> list[str]:
        info = info or self.object_info()
        return self._combo_candidates(info, "KSampler", "scheduler")

    # ---------------- 入队 / 取结果 ----------------
    def queue_prompt(self, workflow_api: dict[str, Any], *, client_id: str | None = None) -> str:
        cid = client_id or str(uuid.uuid4())
        body = {"prompt": workflow_api, "client_id": cid}
        try:
            r = httpx.post(f"{self.base_url}/prompt", json=body, timeout=self.timeout_s)
        except httpx.HTTPError as e:
            raise ComfyError(f"入队失败：{e}") from e
        if r.status_code >= 400:
            raise ComfyError(f"入队被拒 HTTP {r.status_code}：{r.text[:800]}")
        data = r.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"入队响应缺少 prompt_id：{json.dumps(data, ensure_ascii=False)[:400]}")
        return str(prompt_id)

    def history(self, prompt_id: str) -> dict[str, Any]:
        try:
            r = httpx.get(f"{self.base_url}/history/{prompt_id}", timeout=self.timeout_s)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ComfyError(f"取 history 失败：{e}") from e
        return r.json()

    def wait_for(self, prompt_id: str, *, timeout_s: float = 600.0, interval_s: float = 1.5) -> dict[str, Any]:
        """轮询直到该 prompt 出现在 history 中，返回其条目。"""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            h = self.history(prompt_id)
            if prompt_id in h:
                return h[prompt_id]
            time.sleep(interval_s)
        raise ComfyError(f"等待超时（{timeout_s}s）：prompt {prompt_id} 未完成")

    def download_image(self, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
        params = {"filename": filename, "subfolder": subfolder, "type": type_}
        try:
            r = httpx.get(f"{self.base_url}/view", params=params, timeout=self.timeout_s)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ComfyError(f"下载图片失败：{e}") from e
        return r.content

    def collect_images(self, history_entry: dict[str, Any], *, output_node_ids: list[str] | None = None) -> list[GeneratedImage]:
        """从 history 条目里取出所有输出图片字节。"""
        outputs = history_entry.get("outputs") or {}
        node_ids = output_node_ids or list(outputs.keys())
        out: list[GeneratedImage] = []
        for nid in node_ids:
            node_out = outputs.get(str(nid)) or {}
            for img in node_out.get("images", []) or []:
                fn = img.get("filename")
                if not fn:
                    continue
                sub = img.get("subfolder", "")
                typ = img.get("type", "output")
                out.append(
                    GeneratedImage(
                        filename=fn,
                        subfolder=sub,
                        type=typ,
                        data=self.download_image(fn, sub, typ),
                    )
                )
        return out

    # ---------------- 队列控制 ----------------
    def interrupt(self) -> None:
        try:
            httpx.post(f"{self.base_url}/interrupt", timeout=self.timeout_s)
        except httpx.HTTPError:
            pass

    def delete_from_queue(self, prompt_id: str) -> None:
        try:
            httpx.post(f"{self.base_url}/queue", json={"delete": [prompt_id]}, timeout=self.timeout_s)
        except httpx.HTTPError:
            pass
