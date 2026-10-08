"""LLM 层：供应商无关客户端 + 按阶段选供应商。"""

from .client import ChatResult, LLMClient, LLMError, LLMLogContext, ProviderConfig

__all__ = ["LLMClient", "LLMError", "LLMLogContext", "ProviderConfig", "ChatResult"]
