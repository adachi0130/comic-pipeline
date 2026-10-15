"""逐格出图的数据、选择版本及参数快照回归，全部使用临时目录与数据库。"""
import unittest
from unittest.mock import patch
from types import SimpleNamespace


class ImageWorkbenchTests(unittest.TestCase):
    def setUp(self):
        from test_data_safety import DataSafetyTests, A, png
        from app.api.routes import comfy, jobs
        self.case = DataSafetyTests('test_med_doc_without_preview_remains_editable')
        self.case.setUp(); self.addCleanup(self.case.doCleanups)
        for module in (comfy, jobs): self.case.client.app.include_router(module.router, prefix='/api')
        self.client, self.session = self.case.client, self.case.session
        self.A, self.png, self.comfy = A, png, comfy

    def image(self, ref='panel:1.1', selection=0):
        paths = [self.case.file('candidates/red.png', self.png('red')), self.case.file('candidates/blue.png', self.png('blue'))]
        return self.case.artifact('image', ref, payload={'candidates': [self.case.candidate(path) for path in paths], 'selected_index': selection})

    def test_board_scopes_orders_and_hides_filesystem_paths(self):
        for number in (10, 2, 1): self.case.artifact('page_script', f'page:{number}', payload={'panels': [{'panel_order': 1}]})
        prompt = self.case.artifact('panel_prompt', 'panel:1.1', payload={'prompt_pos': 'text', 'seed': 0})
        image = self.image()
        self.case.artifact('image', 'panel:20.1', project_id=2, payload={'candidates': [self.case.candidate(self.case.external)]})
        data = self.client.get('/api/projects/1/image-board').json()
        self.assertEqual([page['page_index'] for page in data['pages']], [1, 2, 10])
        panel = data['pages'][0]['panels'][0]
        self.assertEqual(panel['prompt']['artifact_id'], prompt.id)
        self.assertEqual(panel['prompt']['seed'], 0)
        self.assertEqual(panel['image']['artifact_id'], image.id)
        self.assertTrue(all(row['available'] for row in panel['image']['candidates']))
        self.assertNotIn(str(self.case.root), str(data)); self.assertNotIn('panel:20.1', str(data))
        self.assertEqual(self.client.get('/api/projects/999/image-board').status_code, 404)

    def test_unavailable_candidates_keep_indexes_and_cannot_be_adopted(self):
        self.case.artifact('page_script', 'page:1', payload={'panels': [{'panel_order': 1}]})
        image = self.case.artifact('image', 'panel:1.1', payload={'candidates': [self.case.candidate(self.case.external), self.case.candidate(self.case.root / 'missing.png')], 'selected_index': 0})
        candidates = self.client.get('/api/projects/1/image-board').json()['pages'][0]['panels'][0]['image']['candidates']
        self.assertEqual([row['index'] for row in candidates], [0, 1])
        self.assertTrue(all(not row['available'] and not row['url'] for row in candidates))
        self.assertEqual(self.client.post(f'/api/artifacts/{image.id}/select', json={'index': 0}).status_code, 403)
        self.assertEqual(self.client.post(f'/api/artifacts/{image.id}/select', json={'index': 1}).status_code, 404)

    def test_selection_versions_preserve_old_choice_and_invalidate_downstream(self):
        image = self.image()
        page = self.A.create(self.session, project_id=1, kind='page_image', ref='page:1', payload={}, status='approved', inputs=[image])
        book = self.A.create(self.session, project_id=1, kind='book', ref='book', payload={}, status='approved', inputs=[page])
        self.session.commit(); old_id, page_id, book_id = image.id, page.id, book.id
        result = self.client.post(f'/api/artifacts/{old_id}/select', json={'index': 1})
        self.assertEqual(result.status_code, 200, result.text)
        new = result.json(); self.assertNotEqual(new['id'], old_id); self.assertEqual(new['status'], 'approved')
        self.assertEqual(self.client.get(f'/api/artifacts/{old_id}').json()['payload']['selected_index'], 0)
        self.assertEqual(self.client.get(f'/api/artifacts/{page_id}').json()['status'], 'stale')
        self.assertEqual(self.client.get(f'/api/artifacts/{book_id}').json()['status'], 'stale')
        self.assertEqual(self.client.post(f'/api/artifacts/{old_id}/select', json={'index': 0}).status_code, 409)
        self.assertEqual(self.client.post(f'/api/artifacts/{new["id"]}/select', json={'index': 1}).json()['id'], new['id'])

    def test_candidate_keys_survive_version_changes_and_deleted_selection_needs_review(self):
        self.case.artifact('page_script', 'page:1', payload={'panels': [{'panel_order': 1}]})
        image = self.image()
        before = self.client.get('/api/projects/1/image-board').json()['pages'][0]['panels'][0]['image']
        after = self.client.post(f'/api/artifacts/{image.id}/select', json={'index': 1}).json()
        current = self.client.get('/api/projects/1/image-board').json()['pages'][0]['panels'][0]['image']
        self.assertEqual([row['key'] for row in before['candidates']], [row['key'] for row in current['candidates']])
        removed = self.client.delete(f'/api/artifacts/{after["id"]}/candidate/1').json()
        result = self.client.get(f'/api/artifacts/{removed["artifact_id"]}').json()
        self.assertEqual(result['status'], 'review'); self.assertIsNone(result['payload']['selected_index'])
        self.assertEqual(self.client.get(f'/api/artifacts/{image.id}/candidate/1').status_code, 200)

    def test_new_versions_are_not_invalidated_by_their_predecessor_edge(self):
        old = self.case.artifact('panel_prompt', 'panel:1.1', payload={'prompt_pos': 'old'})
        new = self.A.create(self.session, project_id=1, kind=old.kind, ref=old.ref, payload={'prompt_pos': 'new'}, status='review', inputs=[old])
        self.session.commit(); self.assertEqual(new.status, 'review')

    def test_generation_target_is_defined_by_url_and_jobs_have_ref(self):
        with patch.object(self.comfy.jobq, 'enqueue', return_value=SimpleNamespace(id=90, status='queued')) as enqueue:
            result = self.client.post('/api/projects/1/panels/panel%3A1.1/generate', json={'project_id': 2, 'panel_ref': 'panel:99.9', 'count': 2})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(enqueue.call_args.kwargs['payload']['project_id'], 1)
            self.assertEqual(enqueue.call_args.kwargs['payload']['panel_ref'], 'panel:1.1')
        from app.models import Job
        self.session.add(Job(project_id=1, kind='image', stage='S4', payload={'panel_ref': 'panel:1.1'}, status='queued')); self.session.commit()
        self.assertEqual(self.client.get('/api/projects/1/image-board').json()['jobs'][0]['ref'], 'panel:1.1')

    def test_pinned_generation_uses_requested_version_and_old_result_is_not_auto_approved(self):
        from app.models import Job, Project
        from app.stages import image
        from app.comfy import service
        from app.comfy.client import GeneratedImage
        old = self.case.artifact('panel_prompt', 'panel:1.1', payload={'prompt_pos': 'old', 'seed': 0, 'width': 512, 'height': 768})
        old_id = old.id
        self.case.artifact('panel_prompt', 'panel:1.1', payload={'prompt_pos': 'new', 'seed': 999})
        self.session.get(Project, 1).review_mode = 'auto'
        job = Job(project_id=1, kind='image', status='running', payload={'panel_ref': 'panel:1.1', 'prompt_artifact_id': old_id, 'count': 1})
        self.session.add(job); self.session.commit()
        with patch.object(service, 'generate', return_value=[GeneratedImage('red.png', '', 'output', self.png('red'))]) as generate:
            image.handle(self.session, job)
        self.assertEqual(generate.call_args.args[0].prompt_pos, 'old'); self.assertEqual(generate.call_args.args[0].seed, 0)
        art = self.A.current(self.session, 1, 'image', 'panel:1.1')
        self.assertEqual(art.status, 'stale'); self.assertIsNone(art.payload['selected_index'])
        self.assertEqual(art.payload['prompt_artifact_id'], old_id)
        wrong = self.case.artifact('panel_prompt', 'panel:1.1', project_id=2)
        job.payload = {**job.payload, 'prompt_artifact_id': wrong.id}
        with self.assertRaisesRegex(ValueError, '不属于'): image.handle(self.session, job)


if __name__ == '__main__': unittest.main()
