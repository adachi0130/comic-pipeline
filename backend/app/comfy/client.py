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
    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = 30.0,
        api_key: str = "",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.api_key = (api_key or "").strip()

    # ---------------- 内部 ----------------
    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """统一请求头。云端（仙宫云等）需要鉴权时带 ``Authorization: Bearer``。"""
        h = dict(extra or {})
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _get(self, path: str, **kw: Any) -> httpx.Response:
        kw["headers"] = self._headers(kw.get("headers"))
        return httpx.get(f"{self.base_url}{path}", **kw)

    def _post(self, path: str, **kw: Any) -> httpx.Response:
        kw["headers"] = self._headers(kw.get("headers"))
        return httpx.post(f"{self.base_url}{path}", **kw)

    # ---------------- 探测 ----------------
    def ping(self, timeout_s: float = 5.0) -> bool:
        """活着就算通：/system_stats → 退而求其次 /object_info → /queue。"""
        for path, is_get in (("/system_stats", True), ("/object_info", True), ("/queue", True)):
            try:
                r = self._get(path, timeout=timeout_s)
                if r.status_code == 200:
                    return True
            except httpx.HTTPError:
                continue
        return False

    def object_info(self) -> dict[str, Any]:
        try:
            r = self._get("/object_info", timeout=self.timeout_s)
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

    # ---------------- 出图后端上已有的工作流 / 模型 ----------------
    def list_workflows(self) -> list[str]:
        """ComfyUI 用户目录里的工作流文件名列表（``/userdata?dir=workflows``）。"""
        try:
            r = self._get("/userdata", params={"dir": "workflows", "recurse": "true"}, timeout=self.timeout_s)
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ComfyError(f"读取工作流列表失败：{e}") from e
        if not isinstance(data, list):
            return []
        return sorted(str(x) for x in data if str(x).lower().endswith(".json"))

    def get_workflow(self, name: str) -> dict[str, Any]:
        """取一个工作流的原始 JSON（UI 格式或 API 格式）。"""
        # /userdata/<相对路径>，文件名里的斜杠要编码成 %2F
        encoded = "workflows/" + name
        path = "/userdata/" + encoded.replace("/", "%2F")
        try:
            r = self._get(path, timeout=self.timeout_s)
            if r.status_code == 404:
                # 有些环境不做子目录编码，退回逐段编码
                from urllib.parse import quote

                path = "/userdata/workflows%2F" + quote(name)
                r = self._get(path, timeout=self.timeout_s)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as e:
            raise ComfyError(f"读取工作流 {name} 失败：{e}") from e

    def list_models(self, kind: str) -> list[str]:
        """``/models/<kind>``：loras / checkpoints / vae / sampler_name 等。"""
        try:
            r = self._get(f"/models/{kind}", timeout=self.timeout_s)
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError):
            return []
        return [str(x) for x in data] if isinstance(data, list) else []

    # ---------------- 入队 / 取结果 ----------------
    def queue_prompt(self, workflow_api: dict[str, Any], *, client_id: str | None = None) -> str:
        cid = client_id or str(uuid.uuid4())
        body = {"prompt": workflow_api, "client_id": cid}
        try:
            r = self._post("/prompt", json=body, timeout=self.timeout_s)
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
            r = self._get(f"/history/{prompt_id}", timeout=self.timeout_s)
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
            r = self._get("/view", params=params, timeout=self.timeout_s)
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
            self._post("/interrupt", timeout=self.timeout_s)
        except httpx.HTTPError:
            pass

    def delete_from_queue(self, prompt_id: str) -> None:
        try:
            self._post("/queue", json={"delete": [prompt_id]}, timeout=self.timeout_s)
        except httpx.HTTPError:
            pass
