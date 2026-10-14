"""配置作用域回归：临时数据目录和内存 SQLite，不请求真实供应商。"""
from __future__ import annotations

import unittest


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        from test_data_safety import DataSafetyTests
        from app.api.routes import assets, providers, prompts
        self.case = DataSafetyTests('test_med_doc_without_preview_remains_editable')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        for module in (assets, providers, prompts):
            self.case.client.app.include_router(module.router, prefix='/api')
        self.client = self.case.client
        self.session = self.case.session

    def provider(self, name='provider', model='model-a'):
        response = self.client.post('/api/providers', json={
            'name': name, 'model': model, 'base_url': 'http://mock.invalid/v1', 'api_key': 'not-a-real-key',
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['id']

    def preset(self, *, scope='global', project_id=None, text='default', default=True):
        response = self.client.post('/api/prompt-presets', json={
            'name': text, 'text': text, 'kind': 'positive', 'scope': scope,
            'project_id': project_id, 'is_default': default,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['id']

    def test_global_stage_models_restore_binding_and_support_reset(self):
        from app.stages.promptlib import resolve_provider
        a, b = self.provider('a'), self.provider('b')
        response = self.client.patch('/api/stage-models', json={'S1': a, 'S2': b, 'S3': b})
        self.assertEqual(response.status_code, 200)
        configuration = self.client.get('/api/stage-models').json()
        self.assertEqual(configuration['scope'], 'global')
        self.assertEqual(configuration['bindings'], {'S1': a, 'S2': b, 'S3': b})
        self.session.expire_all()
        self.assertEqual(resolve_provider(self.session, 'S2')[0].id, b)
        response = self.client.patch('/api/stage-models', json={'S2': None})
        self.assertNotIn('S2', response.json()['bindings'])
        self.session.expire_all()
        self.assertEqual(resolve_provider(self.session, 'S2')[0].id, a)

    def test_invalid_binding_is_atomic_and_disabled_provider_falls_back(self):
        from app.stages.promptlib import resolve_provider
        a, b = self.provider('a'), self.provider('b')
        for values in ({'S1': a, 'S2': 9999}, {'S4': a}, {'S1': False}, {'S1': 1.5}):
            with self.subTest(values=values):
                self.assertEqual(self.client.patch('/api/stage-models', json=values).status_code, 400)
                self.assertEqual(self.client.get('/api/stage-models').json()['bindings'], {})
        self.client.patch('/api/stage-models', json={'S1': b})
        self.client.patch(f'/api/providers/{b}', json={'enabled': False})
        self.assertEqual(self.client.patch('/api/stage-models', json={'S2': b}).status_code, 400)
        self.session.expire_all()
        self.assertEqual(resolve_provider(self.session, 'S1')[0].id, a)

    def test_legacy_stage_binding_path_reports_global_scope(self):
        provider_id = self.provider()
        response = self.client.patch('/api/projects/1/stage-models', json={'S2': provider_id})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['scope'], 'global')
        self.assertEqual(self.client.patch('/api/projects/999/stage-models', json={'S2': provider_id}).status_code, 404)

    def test_default_presets_do_not_clear_other_projects_or_global(self):
        from app.models import PromptPreset
        from app.stages.prompt import _default_presets
        global_id = self.preset(text='global')
        first_id = self.preset(scope='project', project_id=1, text='project-one')
        second_id = self.preset(scope='project', project_id=2, text='project-two')
        newer_id = self.preset(scope='project', project_id=1, text='project-one-new')
        self.session.expire_all()
        for preset_id in (global_id, second_id, newer_id):
            self.assertTrue(self.session.get(PromptPreset, preset_id).is_default)
        self.assertFalse(self.session.get(PromptPreset, first_id).is_default)
        self.assertEqual(_default_presets(self.session, 1)[0], 'project-one-new')
        self.assertEqual(_default_presets(self.session, 2)[0], 'project-two')
        self.assertEqual(_default_presets(self.session, 10)[0], 'global')
        new_global = self.preset(text='global-new')
        self.session.expire_all()
        self.assertTrue(self.session.get(PromptPreset, new_global).is_default)
        self.assertTrue(self.session.get(PromptPreset, second_id).is_default)
        self.assertTrue(self.session.get(PromptPreset, newer_id).is_default)

    def test_assets_validate_scope_and_preserve_zero_character_weight(self):
        from app.models import Character
        response = self.client.post('/api/projects/1/characters', json={'name': '角色', 'lora_name': 'a.safetensors', 'lora_weight': 0})
        self.assertEqual(response.status_code, 200)
        cid = response.json()['id']
        self.assertEqual(response.json()['lora_weight'], 0)
        response = self.client.post('/api/projects/2/characters', json={'id': cid, 'name': '错误项目'})
        self.assertEqual(response.status_code, 404)
        self.session.expire_all()
        self.assertEqual(self.session.get(Character, cid).name, '角色')
        for body in ({'scope': 'bad'}, {'scope': 'project'}, {'scope': 'project', 'project_id': 9999}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post('/api/prompt-presets', json={'kind': 'positive', **body}).status_code, 400)
        self.assertEqual(self.client.put('/api/projects/999/loras', json={'loras': []}).status_code, 404)

    def test_provider_edit_and_prompt_override_persist(self):
        from app.models import LLMProvider
        provider_id = self.provider()
        response = self.client.patch(f'/api/providers/{provider_id}', json={'model': 'model-b'})
        self.assertEqual(response.json()['model'], 'model-b')
        self.assertTrue(response.json()['has_key'])
        self.assertNotIn('api_key', response.json())
        self.session.expire_all()
        self.assertEqual(self.session.get(LLMProvider, provider_id).api_key, 'not-a-real-key')
        response = self.client.put('/api/prompts/s1_prose', json={'system_text': 'test-system', 'user_text': '{{TITLE}} {{OUTLINE}}'})
        self.assertEqual(response.status_code, 200)
        item = next(item for item in self.client.get('/api/prompts').json() if item['name'] == 's1_prose')
        self.assertTrue(item['overridden'])
        self.assertEqual(item['system_text'], 'test-system')
        self.client.delete('/api/prompts/s1_prose')
        item = next(item for item in self.client.get('/api/prompts').json() if item['name'] == 's1_prose')
        self.assertFalse(item['overridden'])


if __name__ == '__main__':
    unittest.main()
