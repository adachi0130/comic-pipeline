"""酒馆列表镜像回归：只使用临时数据库，不连接真实酒馆。"""
import unittest
from datetime import datetime, timezone, timedelta


class TavernMirrorTests(unittest.TestCase):
    def setUp(self):
        from test_data_safety import DataSafetyTests
        from app.api.routes import bridge
        self.case = DataSafetyTests('test_med_doc_without_preview_remains_editable')
        self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.case.client.app.include_router(bridge.router, prefix='/api')
        self.client = self.case.client
        self.chat = {'file_name': 'chapter.jsonl', 'avatar': 'hero.png', 'char_name': '主角'}

    def push(self, **fields):
        result = self.client.post('/api/bridge/mirror', json=fields)
        self.assertEqual(result.status_code, 200, result.text)
        return self.client.get('/api/tavern/live').json()

    def test_missing_mirror_does_not_report_bridge_online(self):
        data = self.client.get('/api/tavern/live').json()
        self.assertFalse(data['available']); self.assertFalse(data['bridge_online'])
        self.assertEqual(data['chats'], [])

    def test_fetch_failure_preserves_previous_list_and_live_state(self):
        first = self.push(chats=[self.chat], context={'character_name': '主角'})
        self.client.post('/api/bridge/stream', json={'text': '正在写作', 'done': False})
        failed = self.push(chats_error='HTTP 503', context={'character_name': '主角'})
        self.assertEqual(failed['chats'], [self.chat]); self.assertEqual(failed['chats_error'], 'HTTP 503')
        self.assertEqual(failed['chats_updated_at'], first['chats_updated_at'])
        self.assertEqual(failed['live']['text'], '正在写作'); self.assertTrue(failed['bridge_online'])
        restored = self.push(chats=[self.chat])
        self.assertEqual(restored['chats_error'], '')

    def test_explicit_empty_clears_list_but_omitted_list_does_not(self):
        self.push(chats=[self.chat])
        self.assertEqual(self.push(messages=[])['chats'], [self.chat])
        self.assertEqual(self.push(chats=[])['chats'], [])
        self.assertEqual(self.client.post('/api/bridge/mirror', json={'chats': {}}).status_code, 400)

    def test_old_mirror_reports_bridge_offline_and_keeps_history(self):
        from app.models import TavernMirror
        self.push(chats=[self.chat])
        row = self.case.session.get(TavernMirror, 1)
        row.payload = {**row.payload, 'mirror_updated_at': (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()}
        self.case.session.commit()
        data = self.client.get('/api/tavern/live').json()
        self.assertTrue(data['available']); self.assertFalse(data['bridge_online'])
        self.assertEqual(data['chats'], [self.chat])

    def test_active_headless_bridge_retains_priority(self):
        self.push(source='bridge', chats=[self.chat])
        result = self.client.post('/api/bridge/mirror', json={'source': 'tab', 'chats': []}).json()
        self.assertEqual(result['skipped'], 'bridge-active')
        self.assertEqual(self.client.get('/api/tavern/live').json()['chats'], [self.chat])


if __name__ == '__main__': unittest.main()
