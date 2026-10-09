# 本地 OpenAI 兼容 mock LLM（仅供自测，不对外）。
# 支持流式（SSE）与非流式，因为酒馆默认走 stream=true。
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, time

MOCK_TEXT = (
    "（桥自测）雨点砸在废墟的铁皮上，少年抱紧怀里的干粮。远处传来机械关节的喀哒声——"
    "那是一台受损的机械少女，蓝光在雨幕里一明一灭。她抬起手，又缓缓放下，仿佛在确认眼前的人是否值得信任。"
)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json({"data": [{"id": "mock-model", "object": "model"}]})
            return
        self._json({})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            req = {}
        stream = bool(req.get("stream"))

        if not stream:
            self._json({
                "id": "mock", "object": "chat.completion", "created": 0, "model": "mock-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": MOCK_TEXT}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 30, "total_tokens": 40},
            })
            return

        # SSE 流式
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def chunk(delta, finish=None):
            payload = {
                "id": "mock", "object": "chat.completion.chunk", "created": 0, "model": "mock-model",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()

        chunk({"role": "assistant", "content": ""})
        # 按字符分块，模拟真实流式
        for i in range(0, len(MOCK_TEXT), 12):
            chunk({"content": MOCK_TEXT[i:i + 12]})
            time.sleep(0.35)
        chunk({}, finish="stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    print("mock LLM on http://127.0.0.1:8899")
    HTTPServer(("127.0.0.1", 8899), H).serve_forever()
