"""供应商无关的 LLM 客户端。

只依赖 **OpenAI 兼容协议**：``POST {base_url}/chat/completions``。
因此 DashScope / DeepSeek / Kimi / 智谱 / OpenRouter / Ollama / vLLM 都能直接用；
遇到不完全兼容的供应商，再加一个薄适配器即可，不污染主链路。

三个能力：
1. ``chat``            —— 一次普通对话
2. ``chat_json``       —— 要求返回 JSON（能开 JSON mode 就开，失败自动降级）
3. ``structured``      —— 在 2 的基础上用 pydantic 校验；失败把错误回喂给模型重试
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from ..models import LLMCall

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


@dataclass
class ProviderConfig:
    """一次调用所需的供应商信息（可从数据库 LLMProvider 构造）。"""

    base_url: str
    model: str
    api_key: str = ""
    extra: dict[str, Any] = field(default_factory=dict)
    timeout_s: float = 120.0

    @property
    def endpoint(self) -> str:
        base = self.base_url.rstrip("/")
        # 允许用户直接给到 /v1 或给到域名；统一拼 /chat/completions
        return f"{base}/chat/completions"


@dataclass
class ChatResult:
    text: str
    usage: dict[str, Any]
    raw: dict[str, Any]
    duration_ms: int


class LLMClient:
    def __init__(self, provider: ProviderConfig) -> None:
        self.provider = provider

    # ---------------- 基础对话 ----------------
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
        extra_body: dict[str, Any] | None = None,
    ) -> ChatResult:
        p = self.provider
        body: dict[str, Any] = {
            "model": p.model,
            "messages": messages,
        }
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        # 供应商额外参数（如 top_p、enable_thinking 等）
        for k in ("top_p", "frequency_penalty", "presence_penalty", "stop"):
            if k in p.extra:
                body[k] = p.extra[k]
        if extra_body:
            body.update(extra_body)

        headers = {
            "Content-Type": "application/json",
            # 部分中转站（如 newapi + Cloudflare）会拦截非浏览器 UA（403 error code 1010），
            # 必须伪装成浏览器请求，否则酒馆能通、我们直连却被拒。
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "application/json",
        }
        if p.api_key:
            headers["Authorization"] = f"Bearer {p.api_key}"

        started = time.perf_counter()
        max_attempts = int(p.extra.get("max_retries", 3)) if p.extra else 3
        backoff = 0.8
        with httpx.Client(timeout=p.timeout_s) as client:
            resp = None
            for attempt in range(max_attempts):
                try:
                    resp = client.post(p.endpoint, headers=headers, json=body)
                except httpx.HTTPError as e:
                    if attempt + 1 >= max_attempts:
                        raise LLMError(f"请求失败：{e}") from e
                    time.sleep(backoff * (2 ** attempt))
                    continue

                # 中转站常见 429/5xx 抖动：退避重试
                if resp.status_code in (429, 500, 502, 503, 504) and attempt + 1 < max_attempts:
                    time.sleep(backoff * (2 ** attempt))
                    continue
                break

            # 部分供应商不支持 response_format：降级重试一次
            if resp is not None and resp.status_code >= 400 and json_mode:
                body.pop("response_format", None)
                try:
                    resp = client.post(p.endpoint, headers=headers, json=body)
                except httpx.HTTPError as e:
                    raise LLMError(f"请求失败：{e}") from e

        duration_ms = int((time.perf_counter() - started) * 1000)

        if resp.status_code >= 400:
            raise LLMError(f"HTTP {resp.status_code}: {resp.text[:800]}")

        try:
            data = resp.json()
        except ValueError as e:
            raise LLMError(f"响应非 JSON：{resp.text[:400]}") from e

        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"响应缺少 choices：{json.dumps(data, ensure_ascii=False)[:400]}")
        content = choices[0].get("message", {}).get("content", "")
        if isinstance(content, list):  # 某些供应商返回分块 content
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))

        return ChatResult(
            text=content or "",
            usage=data.get("usage") or {},
            raw=data,
            duration_ms=duration_ms,
        )

    # ---------------- 结构化输出 ----------------
    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = 0.6,
        max_tokens: int | None = None,
    ) -> ChatResult:
        res = self.chat(messages, temperature=temperature, max_tokens=max_tokens, json_mode=True)
        res.text = _strip_code_fence(res.text)
        return res

    def structured(
        self,
        messages: list[dict[str, str]],
        schema: type[T],
        *,
        max_retries: int = 2,
        temperature: float | None = 0.6,
        max_tokens: int | None = None,
        log: "LLMLogContext | None" = None,
    ) -> T:
        """要求模型返回符合 ``schema`` 的 JSON；失败则把错误回喂重试。"""
        msgs = list(messages)
        last_error = ""
        for attempt in range(max_retries + 1):
            try:
                res = self.chat_json(msgs, temperature=temperature, max_tokens=max_tokens)
            except LLMError as e:
                last_error = str(e)
                if log:
                    log.record(self, msgs, "", {}, last_error)
                continue

            if log:
                log.record(self, msgs, res.text, res.usage, "")

            try:
                return schema.model_validate_json(res.text)
            except (ValidationError, ValueError) as e:
                last_error = str(e)
                msgs = list(messages) + [
                    {"role": "assistant", "content": res.text},
                    {
                        "role": "user",
                        "content": (
                            "上面的输出不符合要求的 JSON 结构，错误如下：\n"
                            f"{last_error}\n"
                            "请只输出修正后的 JSON，不要任何解释、不要 markdown 代码块。"
                        ),
                    },
                ]
        raise LLMError(f"结构化输出校验失败（已重试 {max_retries} 次）：{last_error}")


def _strip_code_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        # 去掉 ```json ... ``` 包裹
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


@dataclass
class LLMLogContext:
    """把每次调用落 ``llm_calls`` 的上下文。"""

    session: Session
    stage: str = ""
    project_id: int | None = None
    provider_id: int | None = None

    def record(
        self,
        client: LLMClient,
        request_messages: list[dict[str, str]],
        response_text: str,
        usage: dict[str, Any],
        error: str,
    ) -> None:
        self.session.add(
            LLMCall(
                project_id=self.project_id,
                stage=self.stage,
                provider_id=self.provider_id,
                model=client.provider.model,
                request={"messages": request_messages, "base_url": client.provider.base_url},
                response=response_text or "",
                usage=usage or {},
                error=error or "",
            )
        )
        self.session.flush()
