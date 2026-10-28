"""页格编号归一化：只允许能按唯一格序对应的模型输出。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.schemas import PagePrompts
from app.stages.prompt import normalize_panel_refs


class PageReferenceTests(unittest.TestCase):
    def prompts(self, refs):
        return PagePrompts(page_ref='page:1', panels=[{'panel_ref': ref, 'prompt_pos': ref} for ref in refs])

    def test_wrong_page_with_matching_orders_is_corrected_without_reordering(self):
        value = self.prompts(['panel:1.3', 'panel:1.1', 'panel:1.2'])
        normalize_panel_refs(value, 'page:2', ['panel:2.1', 'panel:2.2', 'panel:2.3'])
        self.assertEqual([p.panel_ref for p in value.panels], ['panel:2.3', 'panel:2.1', 'panel:2.2'])
        self.assertEqual(value.panels[0].prompt_pos, 'panel:1.3')

    def test_mixed_pages_and_duplicate_or_missing_orders_are_rejected(self):
        expected = ['panel:2.1', 'panel:2.2']
        for refs in (['panel:1.1', 'panel:2.2'], ['panel:1.1', 'panel:1.1'], ['panel:1.1', 'panel:1.3']):
            with self.subTest(refs=refs), self.assertRaises(ValueError):
                normalize_panel_refs(self.prompts(refs), 'page:2', expected)


if __name__ == '__main__':
    unittest.main()
