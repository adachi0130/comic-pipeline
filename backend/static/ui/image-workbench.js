import { flattenPanels, selectedCandidate, panelState, filterPanels, parsePanelSettings, nextPanel } from './image-workbench-model.js';

export function createImageWorkbench({ state, api, $, esc, pill, toast, editFeedback, refreshGates,
  openComfySettings, switchTab, pageLabel, panelFullLabel, attachLoraCombos, ensureLoraDatalist }) {
  let projectId = null, board = null, panels = [], config = null, editor = null, editorRef = '', editorPromptId = null;
  let loading = 0, navigating = 0, editEpoch = 0;
  let ui = defaults(), compareBox = null;
  const comparisons = new Map(), jobs = new Map(), operations = new Set();
  const labels = { prompt: '待提示词', image: '待出图', selection: '待选图', selected: '已选定', stale: '需确认' };
  const current = () => panels.find((panel) => panel.panel_ref === ui.ref);
  function defaults() { return { ref: '', filters: { page: '', status: '', query: '' }, counts: {} }; }
  function remember() {
    if (!projectId) return;
    try { localStorage.setItem('comic.images.' + projectId, JSON.stringify({ ref: ui.ref, page: ui.filters.page, status: ui.filters.status, counts: ui.counts })); } catch { /* 私密浏览 */ }
  }
  function restore(id) {
    ui = defaults();
    try {
      const saved = JSON.parse(localStorage.getItem('comic.images.' + id) || '{}');
      if (typeof saved.ref === 'string') ui.ref = saved.ref;
      if (typeof saved.page === 'string') ui.filters.page = saved.page;
      if (Object.hasOwn(labels, saved.status)) ui.filters.status = saved.status;
      if (saved.counts && typeof saved.counts === 'object') ui.counts = saved.counts;
    } catch { /* 丢弃损坏的偏好 */ }
  }
  function reset() {
    loading++; navigating++; editor?.dispose(); editor = null; editorRef = ''; editorPromptId = null;
    projectId = null; board = null; panels = []; ui = defaults(); jobs.clear(); comparisons.clear(); closeCompare();
    $('#iw-current').innerHTML = '<div class="card"><div class="empty">正在加载当前项目的出图工作台…</div></div>';
    $('#iw-panel-list').innerHTML = ''; $('#iw-page-summary').innerHTML = ''; $('#iw-info').textContent = '—';
    $('#iw-orphans').textContent = ''; $('#iw-filter-info').textContent = '加载后显示格列表';
    renderFilters(); renderNavigation();
  }
  const visible = () => filterPanels(panels, ui.filters, panelFullLabel);
  const chosenKeys = () => {
    if (!comparisons.has(ui.ref)) comparisons.set(ui.ref, new Set());
    return comparisons.get(ui.ref);
  };
  function renderFilters() {
    $('#iw-page').innerHTML = '<option value="">全部页面</option>' + (board?.pages || []).map((page) => `<option value="${esc(page.page_ref)}">${esc(pageLabel(page.page_ref))} · ${page.panels.length} 格</option>`).join('');
    $('#iw-page').value = ui.filters.page; $('#iw-status').value = ui.filters.status; $('#iw-search').value = ui.filters.query;
  }
  function renderNavigation() {
    const rows = visible();
    $('#iw-info').textContent = `${board?.pages.length || 0} 页 · ${panels.length} 格 · ${panels.filter((panel) => panelState(panel) === 'selected').length} 已选定`;
    $('#iw-filter-info').textContent = `筛选结果 ${rows.length} 格`;
    $('#iw-panel-list').innerHTML = rows.map((panel) => {
      const selected = selectedCandidate(panel), status = panelState(panel), task = jobs.get(panel.panel_ref);
      return `<button type="button" class="iw-panel-pick ${panel.panel_ref === ui.ref ? 'active' : ''}" data-iw-pick="${esc(panel.panel_ref)}" aria-current="${panel.panel_ref === ui.ref ? 'true' : 'false'}">
        ${selected ? `<img src="${esc(selected.url)}" alt="" loading="lazy">` : '<span class="iw-panel-placeholder">▧</span>'}
        <span class="iw-panel-label"><b>${esc(panelFullLabel(panel.panel_ref))}</b><span>${esc(panel.shot || panel.action || '未填写镜头').slice(0, 28)}</span>
        <span class="pill ${status === 'selected' ? 'ok' : 'warn'}">${labels[status]}</span>${task && ['queued', 'running'].includes(task.status) ? '<span class="pill run">生成中</span>' : ''}</span></button>`;
    }).join('') || '<div class="empty">没有符合筛选条件的格，调整筛选或搜索词。</div>';
    $('#iw-panel-list').querySelectorAll('[data-iw-pick]').forEach((button) => button.addEventListener('click', () => pick(button.dataset.iwPick)));
    const panel = current(), page = board?.pages.find((item) => item.page_ref === panel?.page_ref);
    $('#iw-page-summary').innerHTML = page ? `<div class="iw-page-preview">${page.template_id ? `<img src="/api/templates/${encodeURIComponent(page.template_id)}/svg" alt="当前页版式">` : ''}
      <div><b>${esc(pageLabel(page.page_ref))}</b><div class="mut">${esc(page.template?.layout_desc || '未指定版式')}</div><div class="mut">${page.panels.length} 格 · ${pill(page.status)}</div></div></div>` : '';
    if ($('#iw-prev')) $('#iw-prev').disabled = !nextPanel(rows, ui.ref, -1);
    if ($('#iw-next')) $('#iw-next').disabled = !nextPanel(rows, ui.ref, 1);
    const pages = board?.pages || [], index = pages.findIndex((item) => item.page_ref === panel?.page_ref);
    $('#iw-prev-page').disabled = index <= 0; $('#iw-next-page').disabled = index < 0 || index >= pages.length - 1;
  }
  async function pick(ref, filters = ui.filters) {
    const request = ++navigating, id = projectId;
    const saved = await editFeedback.flush('image-editor');
    if (request !== navigating || id !== state.projectId) return;
    if (!saved) { renderFilters(); return; }
    ui.filters = filters;
    const match = panels.find((panel) => panel.panel_ref === ref);
    ui.ref = match?.panel_ref || visible()[0]?.panel_ref || '';
    remember(); renderFilters(); renderNavigation(); renderCurrent();
  }
  async function changeFilters() {
    const filters = { page: $('#iw-page').value, status: $('#iw-status').value, query: $('#iw-search').value };
    const first = filterPanels(panels, filters, panelFullLabel)[0];
    await pick(first?.panel_ref || '', filters);
  }
  async function load({ force = false } = {}) {
    const id = state.projectId, request = ++loading, epoch = editEpoch;
    if (!id) { reset(); $('#iw-current').innerHTML = '<div class="card"><div class="empty">先选择一个漫画项目，再逐格出图。</div></div>'; return; }
    if (projectId !== id) { reset(); projectId = id; restore(id); loading = request; }
    if (force && !(await editFeedback.flush('image-editor'))) return;
    try {
      const [data, connection] = await Promise.all([api(`/api/projects/${id}/image-board`), api('/api/comfy/config').catch(() => null)]);
      if (id !== state.projectId || request !== loading) return;
      const old = current(); board = data; config = connection; panels = flattenPanels(data);
      const updated = current();
      if (old?.prompt && updated?.prompt && old.prompt.version > updated.prompt.version) updated.prompt = old.prompt;
      for (const task of data.jobs || []) {
        const prior = jobs.get(task.ref);
        if (prior && task.id < prior.id) continue;
        if (prior?.id === task.id) {
          if (['done', 'failed', 'cancelled'].includes(prior.status) && ['queued', 'running'].includes(task.status)) continue;
          task.cancel_requested ||= prior.cancel_requested;
        }
        jobs.set(task.ref, task);
      }
      if (ui.filters.page && !data.pages.some((page) => page.page_ref === ui.filters.page)) ui.filters.page = '';
      if (!current()) ui.ref = visible()[0]?.panel_ref || '';
      $('#iw-connection').textContent = config ? `${config.backend === 'local' ? '本机' : '云端'} · ${config.workflow_name || '未选择工作流'}` : '出图配置读取失败';
      renderFilters(); renderNavigation();
      const focused = $('#iw-editor')?.contains(document.activeElement);
      if (force || editorRef !== ui.ref || (!editFeedback.unsettled('image-editor') && !focused && epoch === editEpoch && editorPromptId !== current()?.prompt?.artifact_id)) renderCurrent();
      else { renderCandidates(); renderTask(); }
      $('#iw-orphans').textContent = data.orphan_image_count ? `另有 ${data.orphan_image_count} 个其他格的图片记录，可在高级产物查看。` : '';
      remember();
    } catch (error) {
      if (id !== state.projectId || request !== loading) return;
      toast('出图工作台加载失败：' + error.message, 'err');
      if (!board) $('#iw-current').innerHTML = '<div class="card"><div class="empty">加载失败，点击上方刷新重试。</div></div>';
    }
  }
  function loraRow(lora = {}) {
    return `<div class="iw-lora-row" data-iw-lora data-extra="${esc(JSON.stringify(lora))}"><input class="iw-lora-name" list="lora-all" value="${esc(lora.name || '')}" placeholder="LoRA 文件名" aria-label="LoRA 文件名">
      <label class="iw-weight"><span>模型权重</span><input class="iw-lora-weight" type="number" step="any" value="${lora.weight ?? 0.8}" aria-label="LoRA 模型权重"></label>
      <label class="iw-weight"><span>CLIP 权重</span><input class="iw-lora-clip" type="number" step="any" value="${lora.weight_clip ?? ''}" placeholder="跟随" aria-label="LoRA CLIP 权重"></label><button class="sm danger" data-iw-lora-delete type="button">删除</button></div>`;
  }
  function renderCurrent() {
    editor?.dispose(); editor = null; editorRef = ui.ref; editorPromptId = current()?.prompt?.artifact_id;
    const panel = current();
    if (!panel) { $('#iw-current').innerHTML = '<div class="card"><div class="empty">没有分格或没有匹配项。先到分格分页创建漫画页，或清空筛选。</div></div>'; return; }
    const prompt = panel.prompt, params = prompt?.params || {};
    $('#iw-current').innerHTML = `<div class="card iw-current-card"><div class="row"><div><h2>${esc(panelFullLabel(panel.panel_ref))} <span class="pill tag">${esc(panel.shot || '未填镜别')}</span></h2>
      <div class="mut">${esc((panel.characters || []).join('、') || '未指定角色')} · ${prompt ? pill(prompt.status) : '待生成提示词'}</div></div><span class="spacer"></span>
      <button class="sm" id="iw-prev">上一格</button><button class="sm" id="iw-next">下一格</button></div>
      <details class="iw-script"><summary>镜头内容 ${esc((panel.action || panel.scene_desc || panel.dialogue || '').slice(0, 60))}</summary>
        <dl><dt>场景</dt><dd>${esc(panel.scene_desc || '—')}</dd><dt>动作</dt><dd>${esc(panel.action || '—')}</dd><dt>台词</dt><dd>${esc(panel.dialogue || '—')}</dd><dt>技法</dt><dd>${esc((panel.technique || []).join('、') || '—')}</dd></dl></details>
      <div id="iw-task" class="iw-task" aria-live="polite"></div></div>
      <div class="card"><div class="row"><h2>候选图 <span class="pill" id="iw-candidate-count">—</span></h2><span class="spacer"></span>
        <button class="sm" id="iw-upload">上传图片</button><input id="iw-upload-file" type="file" accept="image/*" hidden><button class="sm" id="iw-compare">比较两张</button></div>
        <div class="h2sub">点击图片放大；勾选两张比较，采用后用于这一格的分页合成。</div><div id="iw-candidates" class="iw-candidate-grid"></div></div>
      <div class="card" id="iw-editor"><div class="row"><h2>本格提示词与参数</h2><span class="spacer"></span>${prompt ? '<button class="sm" id="iw-save">保存修改</button>' : '<button class="sm primary" id="iw-prepare">生成提示词</button>'}</div>
        ${prompt ? `<div class="h2sub">停止输入后自动保存，出图前会等待保存；本次出图固定使用提交时的词与参数。</div>
          <div class="iw-inputs"><div class="grid2"><div><label class="fld" for="iw-positive">正向</label><textarea id="iw-positive">${esc(prompt.prompt_pos)}</textarea></div>
          <div><label class="fld" for="iw-negative">负向</label><textarea id="iw-negative">${esc(prompt.prompt_neg)}</textarea></div></div>
          <details class="iw-settings"><summary>尺寸与采样参数 <span class="mut">${prompt.width || '?'} × ${prompt.height || '?'}</span></summary><div class="iw-parameter-grid">
            ${[['width','宽度',prompt.width], ['height','高度',prompt.height], ['seed','种子（空为随机）',prompt.seed], ['steps','步数',params.steps], ['cfg','CFG',params.cfg], ['denoise','降噪',params.denoise]].map(([key,label,value]) => `<div><label class="fld" for="iw-${key}">${label}</label><input id="iw-${key}" type="number" step="${['cfg','denoise'].includes(key) ? 'any' : '1'}" value="${value ?? ''}"></div>`).join('')}
            <div><label class="fld" for="iw-sampler">采样器</label><input id="iw-sampler" value="${esc(params.sampler || '')}" placeholder="默认"></div><div><label class="fld" for="iw-scheduler">调度器</label><input id="iw-scheduler" value="${esc(params.scheduler || '')}" placeholder="默认"></div></div></details>
          <div class="row" style="margin-top:12px"><b>本格 LoRA</b><span class="spacer"></span><button class="sm" id="iw-add-lora" type="button">＋ LoRA</button></div>
          <div class="iw-lora-head"><span>文件名</span><span>模型权重</span><span>CLIP</span><span></span></div><div id="iw-loras">${(prompt.loras || []).map(loraRow).join('')}</div><div id="iw-save-state" class="save-feedback"></div></div>`
          : '<div class="empty">还没有这一格的提示词，可先生成提示词，也可以上传候选图直接选图。</div>'}
        <div class="iw-generate-bar"><label class="fld" for="iw-count">张数</label><input id="iw-count" type="number" min="1" max="8" value="${Math.min(8, Math.max(1, Number(ui.counts[panel.panel_ref] || state.project?.candidates_per_panel || config?.candidates_per_panel || 4)))}">
          <button class="primary" id="iw-generate">生成候选图</button><span class="mut">${config?.workflow_name ? '使用已选工作流' : '先在出图设置选择工作流'}</span></div></div>`;
    $('#iw-prev').addEventListener('click', () => { const next = nextPanel(visible(), ui.ref, -1); if (next) pick(next.panel_ref); });
    $('#iw-next').addEventListener('click', () => { const next = nextPanel(visible(), ui.ref, 1); if (next) pick(next.panel_ref); });
    $('#iw-count').addEventListener('change', () => { ui.counts[panel.panel_ref] = $('#iw-count').value; remember(); });
    if (prompt) bindEditor(panel);
    else $('#iw-prepare').addEventListener('click', () => prepare(panel));
    $('#iw-generate').addEventListener('click', () => generate(panel));
    $('#iw-generate').disabled = !config?.workflow_name;
    $('#iw-upload').addEventListener('click', () => $('#iw-upload-file').click());
    $('#iw-upload-file').addEventListener('change', (event) => upload(panel, event.target.files[0]));
    $('#iw-compare').addEventListener('click', () => openCompare(panel, [...chosenKeys()]));
    renderNavigation(); renderCandidates(); renderTask();
  }

  function bindEditor(panel) {
    const root = $('#iw-editor .iw-inputs'), id = projectId, ref = panel.panel_ref;
    let prompt = panel.prompt;
    const read = () => ({ prompt_pos: root.querySelector('#iw-positive').value, prompt_neg: root.querySelector('#iw-negative').value,
      ...Object.fromEntries(['width','height','seed','steps','cfg','denoise','sampler','scheduler'].map((key) => [key, root.querySelector('#iw-' + key).value])),
      loras: [...root.querySelectorAll('[data-iw-lora]')].map((row) => ({ ...JSON.parse(row.dataset.extra), name: row.querySelector('.iw-lora-name').value,
        weight: row.querySelector('.iw-lora-weight').value, weight_clip: row.querySelector('.iw-lora-clip').value })) });
    const draft = editFeedback.track({ element: root, group: 'image-editor', label: '本格参数', auto: true,
      status: root.querySelector('#iw-save-state'), read,
      write: async (raw) => {
        const body = parsePanelSettings(raw, prompt); editEpoch++;
        const result = await api(`/api/projects/${id}/panel-prompt/${encodeURIComponent(ref)}`, { method: 'PATCH', body: JSON.stringify(body) });
        prompt = { ...prompt, ...body, artifact_id: result.artifact_id, version: result.version, status: 'review' };
        if (projectId !== id || state.projectId !== id) return;
        const updated = panels.find((item) => item.panel_ref === ref); if (updated) updated.prompt = prompt;
        if (editorRef === ref) editorPromptId = result.artifact_id;
        refreshGates(); load();
      } });
    draft.read = read; draft.prompt = () => prompt; editor = draft;
    $('#iw-save').addEventListener('click', async () => { if (await draft.flush()) toast('本格参数已保存', 'ok'); });
    const bindLoras = () => {
      root.querySelectorAll('[data-iw-lora-delete]').forEach((button) => button.onclick = () => { button.closest('[data-iw-lora]').remove(); draft.changed(); });
      attachLoraCombos(root, '.iw-lora-name');
    };
    $('#iw-add-lora').addEventListener('click', () => { $('#iw-loras').insertAdjacentHTML('beforeend', loraRow()); bindLoras(); draft.changed(); });
    bindLoras(); ensureLoraDatalist();
  }
  function renderCandidates() {
    const box = $('#iw-candidates'), panel = current(); if (!box || !panel) return;
    const candidates = panel.image?.candidates || [], selected = selectedCandidate(panel), keys = chosenKeys();
    for (const key of keys) if (!candidates.some((candidate) => candidate.key === key && candidate.available)) keys.delete(key);
    $('#iw-candidate-count').textContent = `${candidates.length} 张${selected ? ' · 已选 #' + (selected.index + 1) : ''}`;
    $('#iw-compare').disabled = keys.size !== 2;
    box.innerHTML = candidates.map((candidate) => `<div class="iw-candidate ${selected?.key === candidate.key ? 'selected' : ''}" data-iw-key="${esc(candidate.key)}">
      ${candidate.available ? `<button class="iw-image-open" type="button" data-iw-open="${esc(candidate.key)}"><img src="${esc(candidate.url)}" alt="候选 ${candidate.index + 1}" loading="lazy"></button>` : '<div class="iw-image-missing">图片文件不可用</div>'}
      <div class="row"><b>#${candidate.index + 1}</b><span class="mut">${candidate.uploaded ? '上传' : '生成'}${candidate.seed != null ? ' · 记录种子 ' + esc(candidate.seed) : ''}</span><span class="spacer"></span>
        <label class="iw-compare-check"><input type="checkbox" data-iw-compare-key="${esc(candidate.key)}" ${keys.has(candidate.key) ? 'checked' : ''} ${!candidate.available ? 'disabled' : ''}>比较</label></div>
      <div class="row iw-candidate-actions"><button class="sm ${selected?.key === candidate.key ? '' : 'primary'}" data-iw-use="${esc(candidate.key)}" ${!candidate.available ? 'disabled' : ''}>${selected?.key === candidate.key && panel.image.status === 'approved' ? '已采用' : '采用'}</button>
      ${candidate.available ? `<a class="sm" href="${esc(candidate.url)}" download="${esc(panel.panel_ref.replace(':','_'))}_${candidate.index + 1}.png">下载</a>` : ''}
      <button class="sm danger" data-iw-delete="${esc(candidate.key)}">移除</button></div></div>`).join('') || '<div class="empty">还没有候选图，可以生成一批或上传图片。</div>';
    box.querySelectorAll('[data-iw-open]').forEach((button) => button.addEventListener('click', () => openCompare(panel, [button.dataset.iwOpen])));
    box.querySelectorAll('[data-iw-use]').forEach((button) => button.addEventListener('click', () => useCandidate(panel, button.dataset.iwUse)));
    box.querySelectorAll('[data-iw-delete]').forEach((button) => button.addEventListener('click', () => removeCandidate(panel, button.dataset.iwDelete)));
    box.querySelectorAll('[data-iw-compare-key]').forEach((checkbox) => checkbox.addEventListener('change', () => {
      if (checkbox.checked && keys.size >= 2) { checkbox.checked = false; toast('一次比较两张，先取消一张再选择。'); return; }
      if (checkbox.checked) keys.add(checkbox.dataset.iwCompareKey); else keys.delete(checkbox.dataset.iwCompareKey);
      $('#iw-compare').disabled = keys.size !== 2;
    }));
  }
  function closeCompare() { compareBox?.remove(); compareBox = null; }
  function openCompare(panel, keys) {
    const candidates = (panel.image?.candidates || []).filter((candidate) => keys.includes(candidate.key) && candidate.available); if (!candidates.length) return;
    closeCompare(); compareBox = document.createElement('div'); compareBox.className = 'modal iw-compare-modal';
    compareBox.innerHTML = `<div class="box"><div class="row"><h3>${esc(panelFullLabel(panel.panel_ref))} · ${candidates.length === 2 ? '候选比较' : '候选预览'}</h3><span class="spacer"></span><button class="sm" data-close>关闭</button></div>
      <div class="iw-compare-grid ${candidates.length === 1 ? 'single' : ''}">${candidates.map((candidate) => `<div><img src="${esc(candidate.url)}" alt="候选 ${candidate.index + 1}"><div class="row"><b>候选 #${candidate.index + 1}</b><span class="mut">${candidate.uploaded ? '上传' : '生成'} · ${candidate.seed ?? '未记录种子'}</span><span class="spacer"></span><button class="primary sm" data-iw-adopt="${esc(candidate.key)}">采用这张</button></div></div>`).join('')}</div></div>`;
    document.body.appendChild(compareBox);
    compareBox.querySelector('[data-close]').addEventListener('click', closeCompare);
    compareBox.addEventListener('click', (event) => { if (event.target === compareBox) closeCompare(); });
    compareBox.querySelectorAll('[data-iw-adopt]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true; if (await useCandidate(panel, button.dataset.iwAdopt)) closeCompare(); else button.disabled = false;
    }));
  }

  async function mutate(panel, kind, action) {
    const id = projectId, key = id + ':' + panel.panel_ref + ':' + kind;
    if (operations.has(key)) return false;
    if (!(await editFeedback.flush('image-editor')) || id !== state.projectId || operations.has(key)) return false;
    operations.add(key); renderTask();
    try {
      await action(id); toast(panelFullLabel(panel.panel_ref) + '已更新', 'ok'); refreshGates();
      if (state.projectId === id) await load();
      return true;
    } catch (error) { toast('操作失败：' + error.message, 'err'); return false; }
    finally { operations.delete(key); if (state.projectId === id) renderTask(); }
  }
  async function useCandidate(panel, key) {
    const candidate = panel.image?.candidates.find((item) => item.key === key); if (!candidate?.available) return false;
    return mutate(panel, 'select', () => api(`/api/artifacts/${panel.image.artifact_id}/select`, { method: 'POST', body: JSON.stringify({ index: candidate.index }) }));
  }
  async function removeCandidate(panel, key) {
    const candidate = panel.image?.candidates.find((item) => item.key === key); if (!candidate) return;
    if (!confirm('从当前候选列表移除这张图？历史版本和文件仍保留。')) return;
    await mutate(panel, 'delete', () => api(`/api/artifacts/${panel.image.artifact_id}/candidate/${candidate.index}`, { method: 'DELETE' }));
  }
  async function upload(panel, file) {
    if (!file) return;
    await mutate(panel, 'upload', async (id) => {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
      await api(`/api/projects/${id}/panels/${encodeURIComponent(panel.panel_ref)}/candidates`, { method: 'POST', body: JSON.stringify({ data_url: data }) });
    });
  }
  async function prepare(panel) {
    if (!board?.has_llm_provider) { toast('生成提示词需要启用 LLM 供应商，可在设置中配置。', 'err'); return false; }
    return mutate(panel, 'prepare', async (id) => {
      await api(`/api/projects/${id}/panels/${encodeURIComponent(panel.panel_ref)}/prepare`, { method: 'POST', body: '{}' });
      if (state.projectId === id && ui.ref === panel.panel_ref) await load({ force: true });
    });
  }
  function promptRaw(prompt) {
    return { ...prompt, ...Object.fromEntries(['steps','cfg','denoise','sampler','scheduler'].map((key) => [key, prompt.params?.[key] ?? ''])),
      width: prompt.width ?? '', height: prompt.height ?? '', seed: prompt.seed ?? '', sampler: prompt.params?.sampler || '', scheduler: prompt.params?.scheduler || '', loras: prompt.loras || [] };
  }
  async function generate(panel) {
    const id = projectId, ref = panel.panel_ref, key = id + ':' + ref + ':generate', activeEditor = editorRef === ref ? editor : null;
    if (operations.has(key) || ['queued','running'].includes(jobs.get(ref)?.status)) return;
    const count = Number($('#iw-count').value);
    if (!Number.isInteger(count) || count < 1 || count > 8) { toast('张数请填写 1 到 8 的整数', 'err'); return; }
    if (!config?.workflow_name) { openComfySettings(); return; }
    operations.add(key); renderTask();
    try {
      if (activeEditor && !(await activeEditor.flush())) return;
      if (!panel.prompt && !(await prepare(panel))) return;
      if (id !== state.projectId) return;
      const prompt = activeEditor?.prompt() || panels.find((item) => item.panel_ref === ref)?.prompt;
      if (!prompt) throw new Error('没有该格提示词，请先生成或在提示词页补充');
      const settings = parsePanelSettings(activeEditor ? activeEditor.read() : promptRaw(prompt), prompt);
      const result = await api(`/api/projects/${id}/panels/${encodeURIComponent(ref)}/generate`, { method: 'POST', body: JSON.stringify({ ...settings, count, prompt_artifact_id: prompt.artifact_id }) });
      if (state.projectId === id) {
        const prior = jobs.get(ref);
        if (!(prior?.id === result.job_id && ['done','failed','cancelled'].includes(prior.status))) jobs.set(ref, { id: result.job_id, ref, project_id: id, status: result.status, message: `生成 ${count} 张候选图` });
        renderNavigation(); renderTask();
      }
      toast(panelFullLabel(ref) + '出图已入队 #' + result.job_id, 'ok');
    } catch (error) { toast('出图提交失败：' + error.message, 'err'); }
    finally { operations.delete(key); if (state.projectId === id) renderTask(); }
  }
  function renderTask() {
    const box = $('#iw-task'), panel = current(); if (!box || !panel) return;
    const task = jobs.get(panel.panel_ref), running = task && ['queued','running'].includes(task.status);
    const submitting = operations.has(projectId + ':' + panel.panel_ref + ':generate');
    box.innerHTML = submitting ? '正在提交本格出图…' : task ? `<div class="row"><b>本格任务 #${task.id}</b> ${pill(task.status)}<span>${esc(task.message || '')} ${task.total ? `${task.progress}/${task.total}` : ''}</span><span class="spacer"></span>${running ? `<button class="sm danger" id="iw-cancel" ${task.cancel_requested ? 'disabled' : ''}>${task.cancel_requested ? '取消中…' : '取消任务'}</button>` : ''}</div>${task.error ? `<div class="save-feedback" data-status="failed">${esc(task.error)}</div>` : ''}` : '';
    if ($('#iw-generate')) $('#iw-generate').disabled = submitting || running || !config?.workflow_name;
    const mutating = [...operations].some((key) => key.startsWith(projectId + ':' + panel.panel_ref + ':') && !key.endsWith(':generate'));
    if ($('#iw-upload')) $('#iw-upload').disabled = mutating;
    $('#iw-candidates')?.querySelectorAll('button[data-iw-use],button[data-iw-delete]').forEach((button) => {
      const key = button.dataset.iwUse || button.dataset.iwDelete;
      button.disabled = mutating || (!!button.dataset.iwUse && !panel.image?.candidates.find((item) => item.key === key)?.available);
    });
    const cancel = $('#iw-cancel');
    if (cancel) cancel.addEventListener('click', async () => {
      const id = projectId; cancel.disabled = true;
      try {
        const result = await api(`/api/jobs/${task.id}/cancel`, { method: 'POST' });
        if (!result.ok) throw new Error('任务已结束或暂不能取消，请刷新');
        task.cancel_requested = true; if (state.projectId === id) { renderTask(); load(); }
      } catch (error) { toast(error.message, 'err'); cancel.disabled = false; }
    });
  }
  async function refreshConnection() {
    try {
      config = await api('/api/comfy/config');
      $('#iw-connection').textContent = `${config.backend === 'local' ? '本机' : '云端'} · ${config.workflow_name || '未选择工作流'}`;
      renderTask();
    } catch { /* 设置中心保留读取错误 */ }
  }
  $('#iw-refresh').addEventListener('click', async () => {
    const button = $('#iw-refresh'); if (button.disabled) return; button.disabled = true;
    try { await load({ force: true }); } finally { button.disabled = false; }
  });
  $('#iw-comfy').addEventListener('click', openComfySettings); $('#iw-compose').addEventListener('click', () => switchTab('compose'));
  ['iw-page','iw-status'].forEach((id) => $('#' + id).addEventListener('change', changeFilters));
  let searchTimer;
  $('#iw-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(changeFilters, 250); });
  $('#iw-clear-filter').addEventListener('click', () => pick(ui.ref, { page: '', status: '', query: '' }));
  const stepPage = (direction) => {
    const index = board?.pages.findIndex((page) => page.page_ref === current()?.page_ref), page = board?.pages[index + direction];
    if (page) pick(page.panels[0]?.panel_ref || '', { page: page.page_ref, status: '', query: '' });
  };
  $('#iw-prev-page').addEventListener('click', () => stepPage(-1)); $('#iw-next-page').addEventListener('click', () => stepPage(1));
  const compact = matchMedia('(max-width:900px)');
  function foldFilters(closed) { $('#iw-filters').classList.toggle('hidden', closed); $('#iw-filter-toggle').setAttribute('aria-expanded', String(!closed)); }
  foldFilters(compact.matches); compact.addEventListener('change', () => foldFilters(compact.matches));
  $('#iw-filter-toggle').addEventListener('click', () => foldFilters(!$('#iw-filters').classList.contains('hidden')));
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && compareBox && [...document.querySelectorAll('.modal:not(.hidden)')].at(-1) === compareBox) closeCompare(); });

  async function focus(ref) {
    const id = state.projectId;
    await load();
    if (id !== state.projectId || projectId !== id) return;
    if (!panels.some((panel) => panel.panel_ref === ref)) { toast('这个格已不存在，请刷新漫画分格。', 'err'); return; }
    await pick(ref, { page: '', status: '', query: '' });
  }
  return { load, reset, refreshConnection, focus };
}
