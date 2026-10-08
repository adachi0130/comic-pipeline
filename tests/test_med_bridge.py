"""MED 驱动桥的冒烟测试（无头，端到端）。

自动做四件事并断言结果：
1. 起一个只读静态服务器托管 ``backend/static``（含 /editor 与 /ui）；
2. Playwright 打开 ``/editor/``，注入 ``med_bridge.js``；
3. 从 templates 表取一个模板，装上去，读阅读顺序，落提示词；
4. 用一张程序生成的小 PNG 贴进第 1 格，导出整页 PNG 并落盘。

用法（项目根）：
    .venv/Scripts/python.exe tests/test_med_bridge.py
退出码 0 表示桥可用。
"""

from __future__ import annotations

import functools
import http.server
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

STATIC = ROOT / "backend" / "static"


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D401
        pass


class _ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """多线程静态服务器：MED 一次会并发请求 200+ 个脚本/素材，
    单线程服务器会把并发连接拒掉（ERR_CONNECTION_REFUSED），导致脚本缺失。"""

    daemon_threads = True
    allow_reuse_address = True


def serve(port: int) -> socketserver.TCPServer:
    handler = functools.partial(_Quiet, directory=str(STATIC))
    httpd = _ThreadingServer(("127.0.0.1", port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def make_png(path: Path, color=(80, 120, 200), size=(240, 240)) -> None:
    try:
        from PIL import Image
    except ImportError:
        # 无 Pillow 时写一个最小合法 PNG（1x1 深蓝）
        import base64

        path.write_bytes(
            base64.b64decode(
                b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            )
        )
        return
    Image.new("RGB", size, color).save(path)


def main() -> int:
    port = 8791
    httpd = serve(port)
    base = f"http://127.0.0.1:{port}"

    # 取一个 3 格模板
    from app.db import SessionLocal
    from app.models import Template
    from sqlalchemy import select

    session = SessionLocal()
    try:
        tpl = session.scalars(
            select(Template).where(Template.panels_count == 3).limit(1)
        ).first()
        if tpl is None:
            print("模板表为空，请先跑 build_template_menu.py")
            return 2
        template_id, panels_count, svg_path, is_land = tpl.id, tpl.panels_count, tpl.svg_path, tpl.dir == "landscape"
    finally:
        session.close()

    svg = Path(svg_path).read_text(encoding="utf-8")

    tmp = ROOT / "data" / "tmp_smoke"
    tmp.mkdir(parents=True, exist_ok=True)
    img = tmp / "panel_test.png"
    make_png(img)

    from app.med.composer import MedComposer
    from app.med.base import PanelArt

    composer = MedComposer(base)
    try:
        composer.open()
    except Exception as e:  # noqa: BLE001
        print(f"打开 MED 失败：{e}")
        print("提示：需先 pip install playwright && playwright install chromium")
        return 3

    try:
        print(f"模板：{template_id}（{panels_count} 格）")
        n = composer.install_template(svg, is_land)
        print(f"  [check] 安装后格数 = {n}")
        assert n == panels_count, f"格数不符：{n} != {panels_count}"

        order = composer.reading_order(True)
        print(f"  [check] 阅读顺序条目 = {len(order)}，首条 = {order[0]}")
        assert len(order) == panels_count

        prompts = [f"manga panel {i+1}, test" for i in range(panels_count)]
        applied = composer.apply_prompts(prompts, right_to_left=True)
        print(f"  [check] 落提示词 = {applied}/{panels_count}")
        assert applied == panels_count

        composer.place_image(1, str(img), right_to_left=True)
        print("  [check] 贴图到第 1 格 OK")

        url = composer.export_png_dataurl(1)
        from app.med.composer import _decode_dataurl

        data = _decode_dataurl(url)
        out = tmp / "composed_page.png"
        out.write_bytes(data)
        print(f"  [check] 导出 PNG {len(data)} 字节 -> {out}")
        assert len(data) > 1000, "导出的 PNG 太小，疑似空白"
    finally:
        composer.close()
        httpd.shutdown()

    print("MED 桥冒烟测试通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
