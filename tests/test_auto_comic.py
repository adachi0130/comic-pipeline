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
    from app.models import Base, Job, Project, Template
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

    def test_changed_prose_stops_run(self):
        art = A.current(self.session, 1, 'prose', 'seg:1')
        art.payload = {'text':'另一个故事', 'auto_run':'run'}
        self.session.commit()
        with patch.object(auto_comic.jobs, 'is_cancelled', return_value=False):
            with self.assertRaisesRegex(ValueError, '正文或目标页数'):
                auto_comic.handle(self.session, self.job)

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
