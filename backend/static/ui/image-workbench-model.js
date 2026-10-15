export function flattenPanels(board) {
  return (board.pages || []).flatMap((page) => page.panels.map((panel) => ({ ...panel, page_ref: page.page_ref,
    page_index: page.page_index, template_id: page.template_id, page_status: page.status })))
    .sort((a, b) => a.page_index - b.page_index || a.panel_order - b.panel_order);
}
export function selectedCandidate(panel) {
  const image = panel.image, index = image?.selected_index;
  return Number.isInteger(index) && index >= 0 ? image.candidates.find((candidate) => candidate.index === index && candidate.available) || null : null;
}
export function panelState(panel) {
  if (panel.prompt?.status === 'stale' || panel.image?.status === 'stale') return 'stale';
  if (selectedCandidate(panel) && panel.image.status === 'approved') return 'selected';
  if (!panel.prompt) return 'prompt';
  if (!(panel.image?.candidates || []).some((candidate) => candidate.available)) return 'image';
  return 'selection';
}
export function filterPanels(panels, { page = '', status = '', query = '' }, label = (ref) => ref) {
  const text = query.trim().toLowerCase();
  return panels.filter((panel) => (!page || panel.page_ref === page) && (!status || panelState(panel) === status)
    && (!text || [label(panel.panel_ref), panel.panel_ref, panel.shot, panel.action, panel.dialogue, panel.scene_desc,
      ...(panel.characters || []), panel.prompt?.prompt_pos, panel.prompt?.prompt_neg].join(' ').toLowerCase().includes(text)));
}
export function parsePanelSettings(raw, previous = {}) {
  const number = (value, label, { integer = false, min = -Infinity, max = Infinity } = {}) => {
    if (value === '' || value == null) return null;
    const result = Number(value);
    if (!Number.isFinite(result) || (integer && !Number.isInteger(result)) || result < min || result > max) throw new Error(label + '不是有效数值');
    return result;
  };
  const width = number(raw.width, '宽度', { integer: true, min: 1 });
  const height = number(raw.height, '高度', { integer: true, min: 1 });
  const params = { ...(previous.params || {}) };
  for (const [name, value] of Object.entries({ width, height,
    steps: number(raw.steps, '步数', { integer: true, min: 1 }), cfg: number(raw.cfg, 'CFG', { min: 0 }),
    denoise: number(raw.denoise, '降噪', { min: 0, max: 1 }),
    sampler: raw.sampler.trim() || null, scheduler: raw.scheduler.trim() || null })) {
    if (value == null) delete params[name]; else params[name] = value;
  }
  return { prompt_pos: raw.prompt_pos, prompt_neg: raw.prompt_neg, width, height,
    seed: number(raw.seed, '种子', { integer: true }), params,
    loras: raw.loras.filter((lora) => lora.name.trim()).map((lora) => {
      const result = { ...lora, name: lora.name.trim(), weight: number(lora.weight === '' ? 0.8 : lora.weight, 'LoRA 权重') };
      const clip = number(lora.weight_clip, 'CLIP 权重');
      if (clip == null) delete result.weight_clip; else result.weight_clip = clip;
      return result;
    }) };
}
export function nextPanel(panels, ref, direction) {
  const index = panels.findIndex((panel) => panel.panel_ref === ref);
  if (index < 0) return direction > 0 ? panels[0] : panels.at(-1);
  return panels[index + direction] || null;
}
