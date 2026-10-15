import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenPanels, selectedCandidate, panelState, filterPanels, parsePanelSettings, nextPanel } from '../backend/static/ui/image-workbench-model.js';

const raw = () => ({ prompt_pos: 'positive', prompt_neg: 'negative', width: '704', height: '996', seed: '0', steps: '24', cfg: '0', denoise: '0', sampler: ' euler ', scheduler: '', loras: [{ name: ' style ', weight: '0', weight_clip: '0', custom: true }] });
test('numeric page and panel order retains page context', () => {
  const rows = flattenPanels({ pages: [10, 2, 1].map((n) => ({ page_ref: `page:${n}`, page_index: n, template_id: 'tpl', panels: [2, 1].map((order) => ({ panel_order: order, panel_ref: `panel:${n}.${order}` })) })) });
  assert.deepEqual(rows.map((p) => p.panel_ref), ['panel:1.1', 'panel:1.2', 'panel:2.1', 'panel:2.2', 'panel:10.1', 'panel:10.2']);
  assert.equal(rows[0].page_ref, 'page:1'); assert.equal(rows[0].template_id, 'tpl');
});
test('manual uploads can be selected without a generated prompt; missing files cannot', () => {
  const panel = { image: { status: 'approved', selected_index: 0, candidates: [{ index: 0, available: true }] } };
  assert.equal(panelState(panel), 'selected'); assert.equal(selectedCandidate(panel).index, 0);
  panel.image.candidates[0].available = false;
  assert.equal(selectedCandidate(panel), null); assert.equal(panelState(panel), 'prompt');
  panel.prompt = {}; assert.equal(panelState(panel), 'image');
  panel.image.candidates[0].available = true; panel.image.status = 'review'; assert.equal(panelState(panel), 'selection');
  panel.prompt.status = 'stale'; assert.equal(panelState(panel), 'stale');
});
test('page, progress and keyword filters combine and no-match stays empty', () => {
  const rows = [{ panel_ref: 'panel:1.1', page_ref: 'page:1', characters: ['小明'], prompt: { prompt_pos: 'Moonlight' } }, { panel_ref: 'panel:2.1', page_ref: 'page:2' }];
  assert.equal(filterPanels(rows, { page: 'page:1', status: 'image', query: 'moonLIGHT' }).length, 1);
  assert.equal(filterPanels(rows, { query: '小明' }).length, 1);
  assert.deepEqual(filterPanels(rows, { page: 'page:2', query: 'moon' }), []);
  assert.equal(nextPanel(rows, 'panel:1.1', 1).panel_ref, 'panel:2.1');
  assert.equal(nextPanel(rows, 'panel:2.1', 1), null);
});
test('single draft retains seed zero, independent zero strengths and unknown params', () => {
  const result = parsePanelSettings(raw(), { params: { ckpt_name: 'base', custom: { x: 1 }, scheduler: 'old' } });
  assert.equal(result.seed, 0); assert.equal(result.params.cfg, 0); assert.equal(result.params.denoise, 0);
  assert.equal(result.params.sampler, 'euler'); assert.equal(result.params.scheduler, undefined);
  assert.equal(result.params.ckpt_name, 'base'); assert.deepEqual(result.params.custom, { x: 1 });
  assert.deepEqual(result.loras, [{ name: 'style', weight: 0, weight_clip: 0, custom: true }]);
  const changed = raw(); changed.seed = ''; changed.loras[0].weight_clip = '';
  assert.equal(parsePanelSettings(changed).seed, null); assert.equal(parsePanelSettings(changed).loras[0].weight_clip, undefined);
});
test('invalid numeric input blocks save rather than silently replacing it', () => {
  for (const [field, value] of [['width', '0'], ['height', '3.5'], ['seed', 'NaN'], ['steps', '-1'], ['cfg', '-1'], ['denoise', '2']]) {
    assert.throws(() => parsePanelSettings({ ...raw(), [field]: value }), /有效数值/);
  }
});
