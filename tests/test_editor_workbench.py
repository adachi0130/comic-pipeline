"""内嵌工作台冒烟：真实本地 MED + 临时项目/数据库/图片，无真实应用 lifespan。

运行：.venv/Scripts/python.exe -X utf8 -B tests/test_editor_workbench.py
需要已拉取 MED 并安装 Playwright Chromium。
"""
from __future__ import annotations

import functools
import http.server
import json
import re
import socketserver
import threading
from pathlib import Path
from unittest.mock import patch


def main():
    from test_data_safety import DataSafetyTests, A, Template, png, data_url
    from app.api.routes import projects, meta, bridge, providers, assets, comfy
    from app.comfy import store
    from playwright.sync_api import sync_playwright, expect

    root = Path(__file__).resolve().parents[1]
    static = root / 'backend/static'
    case = DataSafetyTests('test_med_doc_without_preview_remains_editable')
    case.setUp()
    for name, value in (('COMFY_CONFIG_PATH', case.base / 'comfy.yaml'), ('WORKFLOW_DIR', case.base / 'workflows')):
        boundary = patch.object(store, name, value)
        boundary.start()
        case.addCleanup(boundary.stop)
    # 只读 MED 已锁定版本的实际 SVG 模板，写入临时模板表。
    source = (static / 'editor/js/svg/manga-panels-image-vertical.js').read_text(encoding='utf-8')
    svg = json.loads(re.search(r'svg:\s*("(?:\\.|[^"\\])*")', source).group(1))
    template_path = case.base / 'template.svg'
    template_path.write_text(svg, encoding='utf-8')
    case.session.add(Template(id='vertical:test', dir='vertical', panels_count=1,
                              layout_desc='单格竖版', svg_path=str(template_path),
                              geometry={'canvas': [704, 996], 'panels': [{'x_pct': 0, 'y_pct': 0, 'width_pct': 100, 'height_pct': 100}]}))
    case.session.commit()
    case.artifact('page_script', 'page:1', payload={'template_id': 'vertical:test', 'panels': [{'panel_order': 1}]})
    case.artifact('image', 'panel:1.1', payload={'candidates': [case.candidate(case.file('candidates/panel.png', png('skyblue')))], 'selected_index': 0})
    app = case.client.app
    for module in (projects, meta, bridge, providers, assets, comfy):
        app.include_router(module.router, prefix='/api')
    captures = []
    api_lock = threading.Lock()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith('/api/'):
                return self.api()
            return super().do_GET()

        def do_POST(self):
            self.api()

        def do_PATCH(self):
            self.api()

        def api(self):
            if self.path.split('?')[0] == '/api/health':
                body, status, content_type = b'{"ok":true}', 200, 'application/json'
            elif self.path.split('?')[0] in ('/api/jobs/events', '/api/tavern/events'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    self.wfile.write(b': keepalive\n\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            else:
                content = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                with api_lock, patch.object(comfy.service, 'get_client', side_effect=RuntimeError('模拟环境不访问 ComfyUI')):
                    response = case.client.request(self.command, self.path, content=content,
                                                   headers={'Content-Type': 'application/json'})
                body, status, content_type = response.content, response.status_code, response.headers.get('content-type', 'application/json')
                if '/med-doc/' in self.path and self.command == 'POST': captures.append(json.loads(body))
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    server = Server(('127.0.0.1', 0), functools.partial(Handler, directory=str(static)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    # 保存截图也放临时目录，避免覆盖已有项目文件。
    screenshots = case.base / 'screenshots'
    screenshots.mkdir()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser_context = browser.new_context(viewport={'width': 1440, 'height': 1100})
            page = browser_context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/ui/')
            page.locator('[data-pick="1"]').click()
            page.locator('.nav [data-tab="compose"]').click()
            page.locator('#cps-do').click()
            expect(page.locator('#tab-editor')).to_be_visible()
            expect(page.locator('#ed-save')).to_be_enabled(timeout=60000)
            assert len(browser.contexts[0].pages) == 1, '常用编辑不得打开新窗口'
            actual = page.frames[-1]
            assert actual.locator('.tutorial-overlay').count() == 0, '内嵌画布不应被独立教程遮挡'
            assert actual.evaluate('() => window.__MED.panelCount()') == 1
            assert actual.evaluate('() => canvas.getObjects().some(o => o.type === "image")'), '选定图片未自动贴入'
            actual.evaluate('() => { canvas.add(new fabric.Text("漫画测试", {left: 80, top: 80})); canvas.renderAll(); }')
            saved_size = actual.evaluate('() => [canvas.getWidth(), canvas.getHeight()]')
            expect(page.locator('#ed-state')).to_have_text('未保存修改')
            page.locator('#ed-save').click()
            expect(page.locator('#ed-state')).to_have_text('已保存', timeout=30000)
            assert captures[-1]['has_preview'] and captures[-1]['page_image_id']
            assert page.url.endswith('/ui/'), '保存不应导致主页面跳转'
            assert page.locator('#tab-editor').is_visible()
            page.locator('#ed-expand').click()
            expect(page.locator('#ed-expand')).to_have_attribute('aria-pressed', 'true')
            page.screenshot(path=str(screenshots / 'editor-desktop.png'))
            page.locator('#ed-expand').click()
            # 返回预览后再进同一页，保留同一个 iframe 会话。
            frame_url = page.locator('#ed-frame').get_attribute('src')
            page.locator('#ed-back').click()
            expect(page.locator('#tab-compose')).to_be_visible()
            page.locator('#cps-do').click()
            assert page.locator('#ed-frame').get_attribute('src') == frame_url
            # 重开工作台，恢复已保存画布、文字与画布尺寸。
            page.reload()
            expect(page.locator('#ed-save')).to_be_enabled(timeout=60000)
            actual = page.frames[-1]
            assert actual.evaluate('() => canvas.getObjects().some(o => o.text === "漫画测试")')
            restored_size = actual.evaluate('() => [canvas.getWidth(), canvas.getHeight()]')
            # MED 会按当前视窗缩放显示，保存的页面比例与内容必须保留。
            assert abs(restored_size[0] / restored_size[1] - saved_size[0] / saved_size[1]) < 1e-6, (saved_size, restored_size)
            for width in (768, 390):
                page.set_viewport_size({'width': width, 'height': 1000})
                page.wait_for_timeout(150)
                assert actual.evaluate('() => canvas.getObjects().some(o => o.text === "漫画测试")'), '适配窗口不能清空画布'
                assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1'), f'主工作台在 {width}px 溢出'
                page.screenshot(path=str(screenshots / f'editor-{width}.png'))
            assert not errors, errors
            # 将本次截图复制到调用者指定的独立可写目录，仅用于视觉检查。
            import os
            target = os.environ.get('COMIC_SMOKE_SCREENSHOTS')
            if target:
                import shutil
                target = Path(target)
                target.mkdir(parents=True, exist_ok=True)
                for shot in screenshots.glob('*.png'): shutil.copyfile(shot, target / shot.name)
            browser.close()
        print(json.dumps({'embedded_med': 'ok', 'auto_place_image': 'ok', 'dirty_save': 'ok',
                          'save_preview': 'ok', 'resume_canvas': 'ok', 'viewport_widths': [1440, 768, 390],
                          'page_errors': errors}, ensure_ascii=False))
        return 0
    finally:
        server.shutdown()
        server.server_close()
        case.doCleanups()


if __name__ == '__main__':
    raise SystemExit(main())
