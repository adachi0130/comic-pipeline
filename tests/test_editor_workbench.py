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
import zipfile
import io
import time
from pathlib import Path
from unittest.mock import patch, Mock


def main():
    from test_data_safety import DataSafetyTests, A, Template, Job, Project, book, png, data_url
    from app.api.routes import projects, meta, bridge, providers, assets, comfy, jobs, pipeline, prompts
    from app.comfy import store
    from sqlalchemy.orm import Session
    from playwright.sync_api import sync_playwright, expect

    root = Path(__file__).resolve().parents[1]
    static = root / 'backend/static'
    case = DataSafetyTests('test_med_doc_without_preview_remains_editable')
    case.setUp()
    case.session.get(Project, 2).title = '另一部漫画'
    case.session.commit()
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
    case.artifact('page_script', 'page:1', payload={'template_id': 'vertical:test', 'panels': [
        {'panel_order': 1, 'shot': 'close-up', 'role': 'main', 'technique': ['focus_lines'], 'notes': '保留字段'}]})
    case.artifact('panel_prompt', 'panel:1.1', payload={'prompt_pos': 'original prompt', 'prompt_neg': 'low quality',
                                                    'width': 704, 'height': 996, 'loras': []})
    case.artifact('prose', 'seg:1', payload={'text': '原始正文', 'mode': 'paste'})
    case.artifact('image', 'panel:1.1', payload={'candidates': [case.candidate(case.file('candidates/panel.png', png('skyblue')))], 'selected_index': 0})
    app = case.client.app
    for module in (projects, meta, bridge, providers, assets, comfy, jobs, prompts):
        app.include_router(module.router, prefix='/api')
    captures = []
    api_lock = threading.Lock()
    delay_project_one = threading.Event()
    delay_character_save = threading.Event()
    delay_assets_read = threading.Event()
    delay_project_switch = threading.Event()
    fake_comfy = Mock(base_url='http://mock.invalid', ping=Mock(return_value=True),
                      object_info=Mock(return_value={}), list_models=Mock(return_value=[]),
                      list_workflows=Mock(return_value=[]), list_loras=Mock(return_value=[]),
                      list_checkpoints=Mock(return_value=[]), list_samplers=Mock(return_value=[]),
                      list_schedulers=Mock(return_value=[]))

    def simulate_enqueue(kind, *, project_id=None, stage='', payload=None):
        assert kind == 'book', '冒烟检查不运行真实出图或模型作业'
        with Session(case.engine) as session:
            job = Job(project_id=project_id, kind=kind, stage=stage, payload=payload or {}, status='running')
            session.add(job); session.commit()
            job.result = book.handle(session, job)
            job.status = 'done'
            session.commit(); session.refresh(job)
            return job

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

        def do_PUT(self):
            self.api()

        def do_DELETE(self):
            self.api()

        def api(self):
            content_disposition = None
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
                if delay_project_one.is_set() and self.path.startswith('/api/projects/1/compose-board'):
                    time.sleep(0.6)
                if delay_project_switch.is_set() and self.command == 'GET' and self.path == '/api/projects/2':
                    time.sleep(0.45)
                if delay_character_save.is_set() and self.command == 'POST' and self.path == '/api/projects/1/characters':
                    time.sleep(0.45)
                if delay_assets_read.is_set() and self.command == 'GET' and self.path == '/api/projects/1/characters':
                    time.sleep(0.45)
                content = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                with api_lock, patch.object(comfy.service, 'get_client', side_effect=RuntimeError('模拟环境不访问 ComfyUI')), patch.object(pipeline.jobq, 'enqueue', side_effect=simulate_enqueue), patch.object(comfy, '_client', return_value=fake_comfy), patch.object(comfy, '_client_from', return_value=fake_comfy):
                    response = case.client.request(self.command, self.path, content=content,
                                                   headers={'Content-Type': 'application/json'})
                body, status, content_type = response.content, response.status_code, response.headers.get('content-type', 'application/json')
                content_disposition = response.headers.get('content-disposition')
                if '/med-doc/' in self.path and self.command == 'POST': captures.append(json.loads(body))
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            if content_disposition: self.send_header('Content-Disposition', content_disposition)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # 浏览器切页中止旧的轮询请求是预期情况。

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
            expect(page.locator('#breadcrumb-project')).to_have_text('我的漫画')
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
            # 实际整页快照审核后，从新导出中心生成并下载真实 PDF/CBZ。
            page.locator('#ed-back').click()
            page.locator('#cps-approve').click()
            page.locator('.nav [data-tab="exports"]').click()
            expect(page.locator('#export-run')).to_be_enabled()
            expect(page.locator('#export-pages')).to_contain_text('纳入导出')
            page.locator('#export-format').select_option('both')
            page.locator('#export-run').click()
            expect(page.locator('#export-history')).to_contain_text('版本 1')
            for fmt in ('pdf', 'cbz'):
                with page.expect_download() as event:
                    page.locator(f'#export-history a[href$="/{fmt}"]').click()
                data = Path(event.value.path()).read_bytes()
                assert event.value.suggested_filename.endswith('.' + fmt)
                if fmt == 'pdf': assert data.startswith(b'%PDF')
                else:
                    with zipfile.ZipFile(io.BytesIO(data)) as archive: assert len(archive.namelist()) == 1
            page.screenshot(path=str(screenshots / 'export-center-desktop.png'))
            for width in (768, 390):
                page.set_viewport_size({'width': width, 'height': 1000})
                page.wait_for_timeout(150)
                assert actual.evaluate('() => canvas.getObjects().some(o => o.text === "漫画测试")'), '适配窗口不能清空画布'
                assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1'), f'主工作台在 {width}px 溢出'
                expect(page.locator('#mobile-menu')).to_be_visible()
                expect(page.locator('.nav [data-tab="exports"]')).not_to_be_visible()
                page.locator('#mobile-menu').click()
                expect(page.locator('.nav [data-tab="exports"]')).to_be_visible()
                page.locator('.nav [data-tab="exports"]').click()
                expect(page.locator('#mobile-menu')).to_have_attribute('aria-expanded', 'false')
                expect(page.locator('#export-pages')).to_contain_text('纳入导出')
                page.screenshot(path=str(screenshots / f'export-center-{width}.png'))
            page.set_viewport_size({'width': 1440, 'height': 1100})
            page.locator('.nav [data-tab="editor"]').click()
            page.screenshot(path=str(screenshots / 'editor-regular-desktop.png'))
            # 新项目读取期间才产生的画布修改，也要在真正切换前确认。
            delay_project_switch.set()
            page.once('dialog', lambda dialog: dialog.dismiss())
            with page.expect_request(lambda request: request.method == 'GET' and request.url.endswith('/api/projects/2')):
                page.locator('#project-switch').select_option('2')
            actual.evaluate('() => canvas.add(new fabric.Text("切换途中修改", {left: 100, top: 160, fontSize: 24}))')
            expect(page.locator('#project-switch')).to_be_enabled()
            expect(page.locator('#project-switch')).to_have_value('1')
            assert actual.evaluate('() => canvas.getObjects().some(object => object.text === "切换途中修改")')
            delay_project_switch.clear()
            page.locator('#ed-save').click()
            expect(page.locator('#ed-state')).to_have_text('已保存')
            # 同一个工作区里切换项目，即便上一个项目的响应更晚，也不能显示其页。
            delay_project_one.set()
            page.locator('.nav [data-tab="compose"]').click()
            page.locator('#project-switch').select_option('2')
            expect(page.locator('#breadcrumb-project')).to_have_text('另一部漫画')
            expect(page.locator('#cps-detail')).to_contain_text('当前项目还没有漫画页')
            page.wait_for_timeout(850)
            expect(page.locator('#cps-menu')).to_contain_text('还没有分格页')
            expect(page.locator('#cps-detail')).not_to_contain_text('第一页')
            delay_project_one.clear()
            page.locator('.nav [data-tab="exports"]').click()
            expect(page.locator('#export-history')).to_contain_text('还没有导出版本')
            expect(page.locator('#export-run')).to_be_disabled()
            page.locator('#project-switch').select_option('1')
            expect(page.locator('#export-history')).to_contain_text('版本 1')
            page.screenshot(path=str(screenshots / 'navigation-desktop.png'))
            # 从直接入口编辑全局供应商和三个阶段模型，重开后仍显示实际绑定。
            page.locator('.nav [data-tab="settings"][data-section="providers"]').click()
            page.locator('#pv-name').fill('测试供应商')
            page.locator('#pv-url').fill('http://mock.invalid/v1')
            page.locator('#pv-model').fill('model-a')
            page.locator('#pv-key').fill('not-a-real-key')
            page.locator('#btn-addpv').click()
            expect(page.locator('#pvlist')).to_contain_text('测试供应商')
            provider_id = page.locator('[data-pv-edit]').first.get_attribute('data-pv-edit')
            page.locator('[data-pv-edit]').first.click()
            expect(page.locator('#pv-key')).to_have_value('')
            page.locator('#pv-model').fill('model-b')
            page.locator('#btn-addpv').click()
            expect(page.locator('#pvlist')).to_contain_text('model-b')
            expect(page.locator('#pvlist')).to_contain_text('已设 Key')
            page.locator('.nav [data-tab="settings"][data-section="models"]').click()
            expect(page.locator('.stage-bind')).to_have_count(3)
            page.locator('.stage-bind[data-stage="S1"]').select_option(provider_id)
            expect(page.locator('[data-model-state="S1"]')).to_contain_text('已保存')
            page.locator('.nav [data-tab="settings"][data-section="comfy"]').click()
            expect(page.locator('#settings-comfy-overview')).to_contain_text('还没有选定工作流')
            page.locator('.nav [data-tab="settings"][data-section="models"]').click()
            expect(page.locator('.stage-bind[data-stage="S1"]')).to_have_value(provider_id)
            page.screenshot(path=str(screenshots / 'configuration-models-desktop.png'))
            # 系统提示词入口可保存实际覆盖值，页面状态同步显示自定义。
            page.locator('.nav [data-tab="templates"]').click()
            page.locator('#templates-list [data-prompt="s1_prose"]').click()
            page.locator('#pp-sys').fill('测试系统提示词')
            page.locator('#pp-user').fill('{{TITLE}}\n{{OUTLINE}}')
            page.locator('#pp-save').click()
            expect(page.locator('#templates-list')).to_contain_text('已自定义')
            page.locator('#templates-list [data-prompt="s1_prose"]').click()
            expect(page.locator('#pp-sys')).to_have_value('测试系统提示词')
            page.locator('#pp-sys').fill('尚未保存的模板')
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('.modal:not(.hidden) [data-close]').click()
            expect(page.locator('#pp-sys')).to_have_value('尚未保存的模板')
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('.modal:not(.hidden) [data-close]').click()
            page.locator('#templates-list [data-prompt="s1_prose"]').click()
            expect(page.locator('#pp-sys')).to_have_value('测试系统提示词')
            page.locator('.modal:not(.hidden) [data-close]').click()
            # 项目角色、全局预设、画风分别可保存，并保留零权重。
            page.locator('.nav [data-tab="assets"][data-section="characters"]').click()
            page.locator('#pr-addchar').click()
            page.locator('.ch-name').first.fill('岛岛')
            page.locator('.ch-trig').first.fill('test character')
            page.locator('.ch-w').first.fill('0')
            page.locator('.ch-save').first.click()
            page.locator('#assets-refresh').click()
            expect(page.locator('.ch-name').first).to_have_value('岛岛')
            expect(page.locator('.ch-w').first).to_have_value('0')
            page.locator('.nav [data-tab="assets"][data-section="presets"]').click()
            page.locator('#asset-preset-scope').select_option('global')
            page.locator('[data-addpreset="positive"]').click()
            page.locator('.pres-name').first.fill('全局画面预设')
            page.locator('.pres-text').first.fill('masterpiece, clean lineart')
            page.locator('.pres-save').first.click()
            page.locator('.nav [data-tab="assets"][data-section="style"]').click()
            page.locator('#pr-addstyle').click()
            page.locator('.st-name').first.fill('style.safetensors')
            page.locator('.st-w').first.fill('0')
            page.locator('#pr-style-save').click()
            page.locator('#assets-refresh').click()
            expect(page.locator('.st-name').first).to_have_value('style.safetensors')
            expect(page.locator('.st-w').first).to_have_value('0')
            page.locator('.nav [data-tab="assets"][data-section="characters"]').click()
            page.screenshot(path=str(screenshots / 'assets-desktop.png'))
            for width in (768, 390):
                page.set_viewport_size({'width': width, 'height': 1000})
                assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1'), f'资产页面在 {width}px 溢出'
                if width == 390: assert page.locator('#toast-stack .toast:visible').count() <= 1, '手机只展示最新提示，避免遮挡表单'
                page.screenshot(path=str(screenshots / f'assets-{width}.png'))
            page.set_viewport_size({'width': 1440, 'height': 1100})
            page.locator('#project-switch').select_option('2')
            expect(page.locator('[data-asset-part="characters"]')).not_to_contain_text('test character')
            page.locator('.nav [data-tab="assets"][data-section="presets"]').click()
            expect(page.locator('.pres-name').first).to_have_value('全局画面预设')
            # 项目详情：切菜单保留草稿，保存一项不覆盖其他项，取消切换保护内容。
            page.locator('#project-switch').select_option('1')
            expect(page.locator('#breadcrumb-project')).to_have_text('我的漫画')
            page.locator('.nav [data-tab="projects"]').click()
            page.locator('#pd2-outline').fill('未保存的大纲草稿')
            page.locator('.nav [data-tab="images"]').click()
            page.locator('.nav [data-tab="projects"]').click()
            expect(page.locator('#pd2-outline')).to_have_value('未保存的大纲草稿')
            page.locator('#pd2-title').fill('保存保护测试')
            page.locator('[data-save="title"]').click()
            expect(page.locator('[data-project-field="title"] .save-feedback')).to_have_text('已保存')
            expect(page.locator('#pd-title-h')).to_have_text('保存保护测试')
            expect(page.locator('#pv-crumb')).to_contain_text('保存保护测试')
            expect(page.locator('#pd2-outline')).to_have_value('未保存的大纲草稿')
            assert browser_context.request.get(origin + '/api/projects/1').json()['outline'] != '未保存的大纲草稿'
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('#project-switch').select_option('2')
            expect(page.locator('#project-switch')).to_have_value('1')
            expect(page.locator('#pd2-outline')).to_have_value('未保存的大纲草稿')
            page.locator('#pd2-pages').fill('0')
            page.locator('[data-save="target_pages"]').click()
            expect(page.locator('[data-project-field="target_pages"] .save-feedback')).to_contain_text('保存失败')
            page.locator('#pd2-pages').fill('1')
            page.locator('[data-save="outline"]').click()
            expect(page.locator('[data-project-field="outline"] .save-feedback')).to_have_text('已保存')
            assert browser_context.request.get(origin + '/api/projects/1').json()['outline'] == '未保存的大纲草稿'
            page.screenshot(path=str(screenshots / 'project-save-feedback.png'))
            toast_bounds = page.locator('#toast-stack .toast').evaluate_all('elements => elements.map(element => { const rect = element.getBoundingClientRect(); return [rect.top, rect.bottom]; })')
            assert len(toast_bounds) <= 3
            assert all(toast_bounds[index][1] <= toast_bounds[index + 1][0] for index in range(len(toast_bounds) - 1)), toast_bounds
            # 分格改动保留镜别、技法和自定义字段，关闭未保存修改可取消。
            page.locator('.nav [data-tab="pages"]').click()
            page.locator('#pg-list [data-edit="page:1"]').click()
            page.locator('.pd-action').first.fill('修改后的动作')
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('.modal:not(.hidden) [data-close]').click()
            expect(page.locator('.pd-action').first).to_have_value('修改后的动作')
            page.locator('#pd-save').click()
            expect(page.locator('.modal:not(.hidden) .save-feedback')).to_have_text('已保存')
            result = browser_context.request.get(origin + '/api/projects/1/pages/page%3A1').json()['panels'][0]
            assert result['action'] == '修改后的动作' and result['shot'] == 'close-up'
            assert result['role'] == 'main' and result['technique'] == ['focus_lines'] and result['notes'] == '保留字段', result
            page.locator('.modal:not(.hidden) [data-close]').click()
            # 正文窗口保存失败保留内容，重试后生成新版本。
            page.locator('.nav [data-tab="novel"]').click()
            page.locator('#nv-segs-body').evaluate("element => element.classList.remove('hidden')")
            page.locator('#nv-segs-body [data-edit]').first.click()
            page.locator('#seg-edit').fill('保存后的正文')
            def fail_save(route):
                route.fulfill(status=503, content_type='application/json', body='{"detail":"模拟保存失败"}')
            prose_route = '**/api/artifacts/*/payload'
            page.route(prose_route, fail_save)
            page.locator('#seg-save').click()
            expect(page.locator('.modal:not(.hidden) .save-feedback')).to_contain_text('模拟保存失败')
            expect(page.locator('#seg-edit')).to_have_value('保存后的正文')
            page.unroute(prose_route, fail_save)
            page.locator('#seg-save').click()
            expect(page.locator('#seg-edit')).to_have_count(0)
            assert browser_context.request.get(origin + '/api/projects/1/novel').json()['segments'][0]['text'] == '保存后的正文'
            # 逐格提示词：零 LoRA 权重保留；关闭取消与网络失败不会清空输入。
            page.locator('.nav [data-tab="prompts"]').click()
            page.locator('[data-predit="panel:1.1"]').click()
            page.locator('#pp-pos').fill('new prompt')
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('.modal:not(.hidden) [data-close]').click()
            expect(page.locator('#pp-pos')).to_have_value('new prompt')
            page.locator('#pp-addlora').click()
            page.locator('.pp-loraname').fill('style.safetensors')
            page.locator('.pp-loraw').fill('0')
            prompt_route = '**/api/projects/1/panel-prompt/**'
            page.route(prompt_route, fail_save)
            page.locator('#pp-savep').click()
            expect(page.locator('.modal:not(.hidden) .save-feedback')).to_contain_text('模拟保存失败')
            expect(page.locator('#pp-pos')).to_have_value('new prompt')
            page.unroute(prompt_route, fail_save)
            page.locator('#pp-savep').click()
            expect(page.locator('#pp-pos')).to_have_count(0)
            prompt_ids = browser_context.request.get(origin + '/api/projects/1/artifacts?kind=panel_prompt').json()
            result = browser_context.request.get(origin + '/api/artifacts/' + str(prompt_ids[0]['id'])).json()['payload']
            assert result['prompt_pos'] == 'new prompt' and result['loras'][0]['weight'] == 0, result
            # 真实浏览器中的保存竞态：保存途中输入、读取途中输入、失败重试。
            page.locator('.nav [data-tab="assets"][data-section="characters"]').click()
            delay_character_save.set()
            page.locator('.ch-trig').first.fill('save-before')
            page.locator('.ch-save').first.click()
            expect(page.locator('[data-char] .save-feedback').first).to_have_text('保存中…')
            page.locator('.ch-trig').first.fill('save-latest')
            expect(page.locator('[data-char] .save-feedback').first).to_have_text('已保存')
            delay_character_save.clear()
            assert browser_context.request.get(origin + '/api/projects/1/characters').json()[0]['trigger_words'] == 'save-latest'
            delay_assets_read.set()
            with page.expect_request(lambda request: request.method == 'GET' and request.url.endswith('/api/projects/1/characters')):
                page.locator('#assets-refresh').click()
            page.locator('.ch-trig').first.fill('read-latest')
            expect(page.locator('[data-char] .save-feedback').first).to_have_text('已保存')
            delay_assets_read.clear()
            expect(page.locator('.ch-trig').first).to_have_value('read-latest')
            assert browser_context.request.get(origin + '/api/projects/1/characters').json()[0]['trigger_words'] == 'read-latest'
            character_route = '**/api/projects/1/characters'
            page.route(character_route, lambda route: fail_save(route) if route.request.method == 'POST' else route.continue_())
            page.locator('.ch-trig').first.fill('retry-draft')
            expect(page.locator('[data-char] .save-feedback').first).to_contain_text('模拟保存失败')
            page.screenshot(path=str(screenshots / 'asset-save-failure.png'))
            page.unroute(character_route)
            page.locator('.ch-save').first.click()
            expect(page.locator('[data-char] .save-feedback').first).to_have_text('已保存')
            assert browser_context.request.get(origin + '/api/projects/1/characters').json()[0]['trigger_words'] == 'retry-draft'
            # 画风手动修改取消切换后保留，保存后允许切换。
            page.locator('.nav [data-tab="assets"][data-section="style"]').click()
            page.locator('.st-w').first.fill('0.55')
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('#project-switch').select_option('2')
            expect(page.locator('#project-switch')).to_have_value('1')
            expect(page.locator('.st-w').first).to_have_value('0.55')
            page.locator('#pr-style-save').click()
            expect(page.locator('#pr-style-status')).to_have_text('已保存')
            assert browser_context.request.get(origin + '/api/projects/1/loras').json()['project'][0]['weight'] == 0.55
            # 删除等待已发出的保存完成，后续计时器不会重新创建旧角色。
            page.locator('.nav [data-tab="assets"][data-section="characters"]').click()
            delay_character_save.set()
            page.locator('.ch-trig').first.fill('before-delete')
            page.locator('.ch-save').first.click()
            expect(page.locator('[data-char] .save-feedback').first).to_have_text('保存中…')
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('.ch-del').first.click()
            expect(page.locator('[data-char]')).to_have_count(0)
            delay_character_save.clear()
            page.wait_for_timeout(800)
            assert browser_context.request.get(origin + '/api/projects/1/characters').json() == []
            page.locator('#project-switch').select_option('2')
            expect(page.locator('#project-switch')).to_have_value('2')
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
                          'export_pdf_cbz_download': 'ok',
                          'mobile_menu_and_project_switch': 'ok',
                          'configuration_assets_persist': 'ok',
                          'project_and_dialog_drafts': 'ok', 'save_failure_and_race': 'ok',
                          'page_errors': errors}, ensure_ascii=False))
        return 0
    finally:
        server.shutdown()
        server.server_close()
        case.doCleanups()


if __name__ == '__main__':
    raise SystemExit(main())
