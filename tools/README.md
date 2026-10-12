# tools/

本地开发/自测辅助脚本，不参与生产流水线。

- `start_all.py` —— 启动后端及常驻桥，只管理本次取得的子进程句柄。
  不扫描或结束已有进程，不全局清理浏览器；停止请在原终端按 Ctrl+C。
  `--stop` 只提示停止方法并返回 2。旧 `kill_existing/kill_orphan_browsers` 调用无清理副作用。
- `tavern_bridge.py` —— 常驻酒馆浏览器；会话自动清理已禁用，旧 `clean_empty_chats` 调用返回 0。
  不对真实会话文件进行扫描或删除。
- `mock_llm.py` —— 本地 OpenAI 兼容 mock LLM（支持流式 SSE 与非流式），
  用于在没有真实 API 额度的情况下验证 S2 酒馆桥与文字链：
  `python tools/mock_llm.py`，然后把酒馆的 custom_url 指向 `http://127.0.0.1:8899/v1`。
