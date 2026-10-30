"""页格编号归一化：只允许能按唯一格序对应的模型输出。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.schemas import PagePrompts
from app.stages.prompt import cjk_panels, normalize_panel_refs


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


    def prompts(self, refs, pos=None):
        rows = []
        for index, ref in enumerate(refs):
            rows.append({'panel_ref': ref, 'prompt_pos': (pos or [None] * len(refs))[index] or ref, 'prompt_neg': ''})
        return PagePrompts(page_ref='page:1', panels=rows)

    def test_cjk_panels_reports_only_chinese_panels(self):
        """出图模型不认中文：提示词里的汉字/中文标点/全角符号都要拦下来。"""
        value = self.prompts(
            ['panel:1.1', 'panel:1.2', 'panel:1.3'],
            pos=['masterpiece, best quality, wide shot', '女孩站在桥上，夜晚', 'closeup（脸）'],
        )
        self.assertEqual(cjk_panels(value), ['panel:1.2', 'panel:1.3'])

    def test_cjk_panels_passes_english_natural_language(self):
        """自然语言英文是允许的：不能误伤含常见英文短语的提示词。"""
        value = self.prompts(
            ['panel:1.1', 'panel:1.2'],
            pos=['a girl blocking a laser beam with her arm, sparks flying, wide shot',
                 '1 girl, solo, long dark blue hair, (close-up:1.2)'],
        )
        self.assertEqual(cjk_panels(value), [])


if __name__ == '__main__':
    unittest.main()
