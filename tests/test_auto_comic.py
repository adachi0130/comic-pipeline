"""自动漫画编排的隔离回归：不调用模型、出图或真实数据库。"""
import atexit
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
_tmp = tempfile.TemporaryDirectory(prefix='auto-import-', dir=Path(__file__).parent)
atexit.register(_tmp.cleanup)
with patch.dict(os.environ, {'COMIC_DATA_DIR': str(Path(_tmp.name) / 'data'), 'COMIC_DB_URL': 'sqlite:///:memory:'}):
    from app import artifacts as A
    from app.models import Base, Job, Project, Template, PromptPreset
    from app.api.routes import pipeline
    from app.comfy import store
    from app.stages import auto_comic
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


class AutoComicTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.session = sessionmaker(bind=self.engine, autoflush=False)()
        self.addCleanup(self.session.close)
        self.session.add(Project(id=1, title='预览', target_pages=1, review_mode='manual'))
        self.job = Job(project_id=1, kind='auto_comic', stage='AUTO', status='running', payload={'text':'故事', 'target_pages':1, 'auto_run':'run'})
        self.session.add(self.job)
        A.create(self.session, project_id=1, kind='prose', ref='seg:1', payload={'text':'故事','auto_run':'run'}, status='approved')
        self.session.commit()

    def test_interrupted_image_resumes_without_repeating_completed_work(self):
        calls = []
        def put(kind, ref, payload, path=''):
            A.create(self.session, project_id=1, kind=kind, ref=ref, payload={'auto_run':'run', **payload}, path=path, status='approved')
            self.session.commit()
        def script(session, job):
            if not A.current(session, 1, 'page_script', 'page:1'):
                calls.append('script')
                put('page_script', 'page:1', {'panels':[{'panel_order':1},{'panel_order':2}]})
        def prompt(session, job):
            calls.append('prompt')
            for i in (1,2): put('panel_prompt', f'panel:1.{i}', {})
        def image(session, job):
            ref = job.payload['panel_ref']
            calls.append(ref)
            if ref == 'panel:1.2' and calls.count(ref) == 1:
                raise RuntimeError('出图中断')
            put('image', ref, {'selected_index':0, 'candidates':[{'path':'candidate'}]})
        def compose(session, job):
            calls.append('compose')
            put('page_image', 'page:1', {}, path='page.png')
        with patch.object(auto_comic.jobs, 'is_cancelled', return_value=False), patch.object(auto_comic, 'available', return_value=True), \
             patch.object(auto_comic.script, 'handle', script), patch.object(auto_comic.prompt, 'handle', prompt), \
             patch.object(auto_comic.image, 'handle', image), patch.object(auto_comic.compose, 'handle', compose):
            with self.assertRaisesRegex(RuntimeError, '出图中断'):
                auto_comic.handle(self.session, self.job)
            result = auto_comic.handle(self.session, self.job)
        self.assertEqual(result['pages'], ['page:1'])
        self.assertEqual(calls, ['script', 'prompt', 'panel:1.1', 'panel:1.2', 'panel:1.2', 'compose'])
        self.assertEqual(self.session.get(Project, 1).review_mode, 'manual')

    def test_outline_is_expanded_once_and_reused_on_resume(self):
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.job.payload = {**self.job.payload, 'source': 'outline', 'checkpoint': {}}
        self.session.commit()
        from app import llm
        provider = SimpleNamespace(id=1)
        with patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(provider, None)), \
             patch.object(llm, 'LLMClient') as client, patch.object(llm, 'LLMLogContext'), \
             patch.object(auto_comic.jobs, 'is_cancelled', return_value=False):
            client.return_value.chat.return_value = SimpleNamespace(text='扩写后的完整故事，人物出门并解决了难题。', usage={})
            auto_comic.expand_story(self.session, self.job, self.session.get(Project, 1), '故事', 'run')
            art = A.current(self.session, 1, 'prose', 'seg:1')
            self.assertEqual(art.payload['source_text'], '故事')
            self.assertNotEqual(art.payload['text'], '故事')
            with patch.object(auto_comic, 'expand_story') as expand, patch.object(auto_comic.script, 'handle', side_effect=RuntimeError('stop after prose')):
                with self.assertRaisesRegex(RuntimeError, 'stop after prose'):
                    auto_comic.handle(self.session, self.job)
                expand.assert_not_called()

    def test_empty_expansion_does_not_publish_outline_as_prose(self):
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.session.commit()
        from app import llm
        with patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(SimpleNamespace(id=1), None)), \
             patch.object(llm, 'LLMClient') as client, patch.object(llm, 'LLMLogContext'), \
             patch.object(auto_comic.jobs, 'is_cancelled', return_value=False):
            for text in ('', '故事'):
                client.return_value.chat.return_value = SimpleNamespace(text=text, usage={})
                with self.assertRaisesRegex(ValueError, '正文扩写未成功'):
                    auto_comic.expand_story(self.session, self.job, self.session.get(Project, 1), '故事', 'run')
                self.assertIsNone(A.current(self.session, 1, 'prose', 'seg:1'))

    def test_resume_uses_saved_request(self):
        self.job.status = 'failed'
        self.job.payload = {**self.job.payload, 'source': 'outline'}
        self.session.commit()
        with patch.object(pipeline, 'auto_comic', return_value={'job_id': 2}) as submit:
            self.assertEqual(pipeline.resume_auto_comic(1, self.session), {'job_id': 2})
            self.assertEqual(submit.call_args.args[1], {'text': '故事', 'target_pages': 1, 'source': 'outline', 'writer':'llm'})

    def test_outline_failure_stops_before_pagination(self):
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.job.payload = {**self.job.payload, 'source': 'outline', 'checkpoint': {}}
        self.session.commit()
        with patch.object(auto_comic.jobs, 'is_cancelled', return_value=False), \
             patch.object(auto_comic, 'expand_story', side_effect=RuntimeError('正文模型连接失败')), \
             patch.object(auto_comic.script, 'handle') as script:
            with self.assertRaisesRegex(RuntimeError, '正文模型连接失败'):
                auto_comic.handle(self.session, self.job)
            script.assert_not_called()
            self.assertIsNone(A.current(self.session, 1, 'prose', 'seg:1'))

    def test_tavern_result_is_tagged_approved_and_idempotent(self):
        from app.api.routes import bridge
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        child = Job(kind='prose', project_id=1, status='running', payload={
            'auto_run':'run', 'auto_parent_job_id':self.job.id, 'source_text':'故事', 'auto_approve':True})
        self.session.add(child); self.session.commit()
        first = bridge.result({'job_id':child.id,'text':'酒馆扩写的完整故事。'}, self.session)
        again = bridge.result({'job_id':child.id,'text':'酒馆扩写的完整故事。'}, self.session)
        self.assertEqual(first['artifact_id'], again['artifact_id'])
        art = A.current(self.session, 1, 'prose', 'seg:1')
        self.assertEqual(art.status, 'approved')
        self.assertEqual(art.payload['auto_run'], 'run')
        self.assertEqual(art.payload['source_text'], '故事')
        self.assertEqual(art.payload['mode'], 'tavern')
        self.assertEqual(len(A.all_current(self.session, 1, 'prose')), 1)
        self.assertEqual(self.session.get(Project,1).review_mode,'manual')

    def test_late_tavern_result_after_parent_cancel_is_not_published(self):
        from app.api.routes import bridge
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.job.cancel_requested = True
        child = Job(kind='prose', project_id=1, status='running', payload={'auto_parent_job_id':self.job.id})
        self.session.add(child); self.session.commit()
        response = bridge.result({'job_id':child.id,'text':'迟到的正文'}, self.session)
        self.assertTrue(response['cancelled'])
        self.assertIsNone(A.current(self.session, 1, 'prose', 'seg:1'))

    def test_auto_tavern_reuses_queued_child_and_cancels_owned_job(self):
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        child=Job(kind='prose', project_id=1, status='queued', payload={'auto_run':'run','auto_parent_job_id':self.job.id})
        self.session.add(child); self.session.commit()
        with patch.object(auto_comic.jobs,'is_cancelled',return_value=True), \
             patch.object(auto_comic.jobs,'request_cancel') as cancel, \
             patch.object(auto_comic.jobs,'enqueue_deferred') as enqueue:
            auto_comic.expand_story_tavern(self.session,self.job,self.session.get(Project,1),'故事','run')
            enqueue.assert_not_called()
            cancel.assert_called_once_with(child.id)

    def test_llm_provider_extra_controls_are_forwarded(self):
        from app.llm import LLMClient, ProviderConfig
        from app.llm import client as module
        from unittest.mock import Mock
        response=Mock(status_code=200)
        response.json.return_value={'choices':[{'message':{'content':'可用'}}]}
        http=Mock();http.post.return_value=response
        with patch.object(module.httpx,'Client') as connection:
            connection.return_value.__enter__.return_value=http
            llm=LLMClient(ProviderConfig(base_url='http://mock.invalid/v1',model='mock',extra={'thinking':{'type':'disabled'},'max_tokens':12000}))
            llm.chat([{'role':'user','content':'test'}])
            body=http.post.call_args.kwargs['json']
            self.assertEqual(body['thinking'],{'type':'disabled'})
            self.assertEqual(body['max_tokens'],12000)
            llm.chat([{'role':'user','content':'test'}],max_tokens=256)
            self.assertEqual(http.post.call_args.kwargs['json']['max_tokens'],256)

    def test_panel_resolution_follows_reading_order_not_svg_index(self):
        geometry={'canvas':[1000,1000],'panels':[
            {'index':1,'order':2,'width_pct':100,'height_pct':25},
            {'index':2,'order':1,'width_pct':25,'height_pct':100}]}
        mapping=auto_comic.prompt._geometry_panels(geometry)
        width,height=auto_comic.prompt._size_from_geometry(mapping['1'],geometry['canvas'])
        self.assertLess(width,height,'右侧首格为竖格，不能误用 SVG 第一项横格的尺寸')
        width,height=auto_comic.prompt._size_from_geometry(mapping['2'],geometry['canvas'])
        self.assertGreater(width,height)
        legacy={'panels':[{'index':1,'width_pct':100,'height_pct':25}]}
        self.assertEqual(auto_comic.prompt._geometry_panels(legacy)['1']['width_pct'],100)

    def test_local_comfy_requests_bypass_external_proxy(self):
        from app.comfy.client import ComfyClient
        from app.comfy import client as module
        with patch.object(module.httpx,'get') as get:
            ComfyClient('http://127.0.0.1:8188')._get('/queue')
            self.assertIs(get.call_args.kwargs['trust_env'],False)
            ComfyClient('https://cloud.example.invalid')._get('/queue')
            self.assertNotIn('trust_env',get.call_args.kwargs)

    def test_local_queue_runs_after_scheduled_time_has_passed(self):
        from app import jobs
        from datetime import datetime, timedelta, timezone
        import threading
        factory=sessionmaker(bind=self.engine,autoflush=False)
        held, release, executed=threading.Event(),threading.Event(),threading.Event()
        def occupy():
            held.set();release.wait(3)
        with patch.object(jobs,'SessionLocal',factory):
            try:
                jobs.start(max_workers=1)
                jobs._scheduler.add_job(occupy)
                self.assertTrue(held.wait(2))
                jobs._scheduler.add_job(executed.set,run_date=datetime.now(timezone.utc)-timedelta(seconds=5))
                release.set()
                self.assertTrue(executed.wait(2),'排队作业不能因等待线程而被当成过期丢弃')
            finally:
                release.set();jobs.shutdown()

    def test_invalid_writer_is_rejected(self):
        with self.assertRaisesRegex(Exception,'正文生成方式'):
            pipeline.auto_comic(1,{'text':'故事','target_pages':1,'writer':'unknown'},self.session)

    def test_changed_prose_stops_run(self):
        art = A.current(self.session, 1, 'prose', 'seg:1')
        art.payload = {'text':'另一个故事', 'auto_run':'run'}
        self.session.commit()
        with patch.object(auto_comic.jobs, 'is_cancelled', return_value=False):
            with self.assertRaisesRegex(ValueError, '正文或目标页数'):
                auto_comic.handle(self.session, self.job)

    def test_selected_presets_are_pinned_across_resume(self):
        self.session.delete(self.job)
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.session.add(Project(id=2, title='预设来源'))
        self.session.add(Template(id='template', dir='vertical', panels_count=1))
        preset = PromptPreset(name='旧项目正向', kind='positive', scope='project', project_id=2,
                              text='masterpiece, detailed', loras=[{'name':'style', 'weight':0}])
        self.session.add(preset); self.session.commit()
        def enqueue(kind, *, project_id, stage, payload):
            job = Job(kind=kind, project_id=project_id, stage=stage, payload=payload, status='queued')
            self.session.add(job); self.session.commit(); return job
        with patch.object(store, 'load_comfy_config', return_value=SimpleNamespace(workflow_name='wf')), \
             patch.object(store, 'workflow_path', return_value=SimpleNamespace(is_file=lambda: True)), \
             patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(None, None)), \
             patch.object(pipeline.jobq, 'enqueue', side_effect=enqueue):
            result = pipeline.auto_comic(1, {'text':'故事','target_pages':1,'preset_ids':{'positive':preset.id,'negative':0}}, self.session)
            job = self.session.get(Job, result['job_id'])
            self.assertEqual(job.payload['prompt_presets']['positive']['loras'][0]['weight'], 0)
            preset.text = '之后的修改'; job.status = 'failed'; self.session.commit()
            result = pipeline.resume_auto_comic(1, self.session)
            resumed = self.session.get(Job, result['job_id'])
            self.assertEqual(resumed.payload['prompt_presets']['positive']['text'], 'masterpiece, detailed')

    def test_presets_are_included_when_model_omits_them(self):
        self.assertEqual(auto_comic.prompt.with_preset('quality, style', 'a girl'), 'quality, style, a girl')
        self.assertEqual(auto_comic.prompt.with_preset('blur', ''), 'blur')
        self.assertEqual(auto_comic.prompt.with_preset('quality', 'quality, city'), 'quality, city')

    def test_invalid_preset_does_not_create_prose(self):
        self.session.delete(self.job)
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.session.add(Template(id='template', dir='vertical', panels_count=1)); self.session.commit()
        with patch.object(store, 'load_comfy_config', return_value=SimpleNamespace(workflow_name='wf')), \
             patch.object(store, 'workflow_path', return_value=SimpleNamespace(is_file=lambda: True)), \
             patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(None, None)), \
             patch.object(pipeline.jobq, 'enqueue') as enqueue:
            with self.assertRaisesRegex(Exception, '预设不存在'):
                pipeline.auto_comic(1, {'text':'故事','target_pages':1,'preset_ids':{'positive':999}}, self.session)
            self.assertIsNone(A.current(self.session, 1, 'prose', 'seg:1'))
            enqueue.assert_not_called()

    def test_existing_unrelated_story_is_rejected(self):
        self.session.add(Template(id='template', dir='vertical', panels_count=1))
        self.session.delete(self.job)
        self.session.commit()
        with patch.object(store, 'load_comfy_config', return_value=SimpleNamespace(workflow_name='wf')), \
             patch.object(store, 'workflow_path', return_value=SimpleNamespace(is_file=lambda: True)), \
             patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(None, None)), \
             patch.object(pipeline.jobq, 'enqueue') as enqueue:
            with self.assertRaisesRegex(Exception, '项目已有其他故事'):
                pipeline.auto_comic(1, {'text':'另一个故事','target_pages':1}, self.session)
            enqueue.assert_not_called()

    def test_submit_creates_story_and_reuses_same_active_request(self):
        self.session.delete(self.job)
        self.session.delete(A.current(self.session, 1, 'prose', 'seg:1'))
        self.session.add(Template(id='template', dir='vertical', panels_count=1))
        self.session.commit()
        def enqueue(kind, *, project_id, stage, payload):
            job = Job(kind=kind, project_id=project_id, stage=stage, payload=payload, status='queued')
            self.session.add(job)
            self.session.commit()
            return job
        with patch.object(store, 'load_comfy_config', return_value=SimpleNamespace(workflow_name='wf')), \
             patch.object(store, 'workflow_path', return_value=SimpleNamespace(is_file=lambda: True)), \
             patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(None, None)), \
             patch.object(pipeline.jobq, 'enqueue', side_effect=enqueue) as submit:
            first = pipeline.auto_comic(1, {'text':'新故事', 'target_pages':2}, self.session)
            second = pipeline.auto_comic(1, {'text':'新故事', 'target_pages':2}, self.session)
            self.assertEqual(first['job_id'], second['job_id'])
            self.assertTrue(second['reused'])
            self.assertEqual(submit.call_count, 1)
            self.assertEqual(A.current(self.session, 1, 'prose', 'seg:1').payload['text'], '新故事')
            with self.assertRaisesRegex(Exception, '已有任务运行'):
                pipeline.auto_comic(1, {'text':'不同的故事', 'target_pages':2}, self.session)

    def test_changed_checkpoint_is_rejected_on_resume(self):
        self.session.add(Template(id='template', dir='vertical', panels_count=1))
        self.job.status = 'failed'
        self.job.payload = {**self.job.payload, 'checkpoint':auto_comic.checkpoint(self.session, 1)}
        art = A.current(self.session, 1, 'prose', 'seg:1')
        art.status = 'review'
        self.session.commit()
        with patch.object(store, 'load_comfy_config', return_value=SimpleNamespace(workflow_name='wf')), \
             patch.object(store, 'workflow_path', return_value=SimpleNamespace(is_file=lambda: True)), \
             patch.object(auto_comic.prompt.promptlib, 'resolve_provider', return_value=(None, None)), \
             patch.object(pipeline.jobq, 'enqueue') as enqueue:
            with self.assertRaisesRegex(Exception, '产物已被修改'):
                pipeline.auto_comic(1, {'text':'故事','target_pages':1}, self.session)
            enqueue.assert_not_called()

if __name__ == '__main__':
    unittest.main()
