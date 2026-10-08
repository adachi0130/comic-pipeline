# tools/

本地开发/自测辅助脚本，不参与生产流水线。

- `mock_llm.py` —— 本地 OpenAI 兼容 mock LLM（支持流式 SSE 与非流式），
  用于在没有真实 API 额度的情况下验证 S2 酒馆桥与文字链：
  `python tools/mock_llm.py`，然后把酒馆的 custom_url 指向 `http://127.0.0.1:8899/v1`。
