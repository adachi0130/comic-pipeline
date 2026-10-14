export function createConfigurationCenter({ state, api, $, esc, toast, switchTab,
  loadProviders, loadStageBinding, loadCharacterPresetPanel, loadStyleLoras, ensureLoraDatalist }) {
  let assetsProject = undefined;
  let assetsRequest = 0;
  let templatesRequest = 0;
  const validSections = { settings: ['providers', 'comfy', 'models'], assets: ['characters', 'presets', 'style'] };

  function sectionFor(tab, requested) {
    const allowed = validSections[tab];
    if (!allowed) return '';
    let section = requested || state[tab + 'Section'];
    if (!section) {
      try { section = localStorage.getItem('comic.' + tab + 'Section'); } catch { /* 私密浏览 */ }
    }
    if (!allowed.includes(section)) section = allowed[0];
    state[tab + 'Section'] = section;
    try { localStorage.setItem('comic.' + tab + 'Section', section); } catch { /* 私密浏览 */ }
    return section;
  }

  function syncAssets() {
    const section = state.assetsSection || 'characters';
    document.querySelectorAll('[data-assets-card]').forEach((card) => card.classList.toggle('hidden', (card.dataset.assetsCard === 'style') !== (section === 'style')));
    document.querySelectorAll('[data-asset-part]').forEach((part) => part.classList.toggle('hidden', part.dataset.assetPart !== section));
    document.querySelectorAll('[data-character-control]').forEach((control) => {
      control.classList.toggle('hidden', section !== 'characters'); control.disabled = !state.projectId;
    });
    $('#asset-panel-title').textContent = section === 'presets' ? '正负面提示词预设' : '角色资产';
    $('#assets-scope-label').textContent = section === 'presets' ? '项目 / 全局' : '本项目';
    $('#assets-scope').textContent = section === 'presets'
      ? '全局预设可被所有项目使用；本项目默认预设优先，其他项目的默认项保留。'
      : (state.projectId ? `当前项目：${state.project?.title || ''}；角色和画风只用于这部漫画。` : '先选择一个漫画项目，再管理角色和画风。');
    $('#pr-style-save').disabled = !state.projectId; $('#pr-addstyle').disabled = !state.projectId;
    const id = section === 'style' ? 'pr-style-wrap' : 'pr-chars-wrap';
    $('#' + id).classList.remove('hidden');
    document.querySelector(`[data-fold="${id}"]`).classList.remove('closed');
    const hint = $('#pr-chars-wrap .h2sub');
    if (hint) hint.textContent = section === 'presets'
      ? '管理常用正负面词块和预设 LoRA，勾选默认后作为该作用域生成提示词的基础。'
      : '角色名对应分格中的出场角色，触发词与可选角色 LoRA 一起用于生成提示词。';
  }

  async function loadAssets(force = false) {
    const projectId = state.projectId;
    syncAssets();
    if (!force && assetsProject === projectId) return;
    const request = ++assetsRequest;
    if (assetsProject !== projectId) {
      $('#pr-chars').innerHTML = '<div class="empty">正在加载资产…</div>';
      $('#pr-style').innerHTML = '<div class="empty">正在加载画风…</div>';
    }
    await Promise.all([loadCharacterPresetPanel(), loadStyleLoras()]);
    if (request !== assetsRequest || projectId !== state.projectId) return;
    assetsProject = projectId; syncAssets();
  }

  async function refreshTemplates() {
    const request = ++templatesRequest;
    const box = $('#templates-list'); box.innerHTML = '<div class="empty">正在加载实际使用的模板…</div>';
    try {
      const rows = await api('/api/prompts');
      if (request !== templatesRequest) return;
      const descriptions = {
        s1_prose: '调用 LLM 写正文时使用；酒馆写作仍使用酒馆自己的角色卡、世界书与预设。',
        s2_script: '决定故事如何分页分格、选择版式与组织台词。',
        s3_prompt: '决定每格的画面描述、正负面词和角色/画风注入。',
      };
      box.innerHTML = rows.map((row) => `<div class="template-row"><div class="template-info"><b>${esc(row.label)}</b>
        <div class="mut">${esc(descriptions[row.name] || '')}</div><div class="mut">系统 ${row.system_text.length} 字 · 用户模板 ${row.user_text.length} 字</div></div>
        <span class="pill tag">${row.overridden ? '已自定义' : '默认模板'}</span><button class="sm" data-prompt="${esc(row.name)}">编辑模板</button></div>`).join('');
    } catch (e) {
      if (request === templatesRequest) box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}，点击刷新可重试。</div>`;
    }
  }

  async function loadComfyOverview() {
    try {
      const config = await api('/api/comfy/config');
      $('#settings-comfy-overview').innerHTML = `<div class="row"><span class="pill tag">${config.backend === 'local' ? '本机 ComfyUI' : '云端 ComfyUI'}</span>
        <b>${esc(config.workflow_name || '还没有选定工作流')}</b><span class="mut">已保存 ${config.workflows.length} 个工作流</span></div>
        <div class="mut" style="font-size:12px;margin-top:6px">${esc(config.active_url || '尚未配置连接地址')} · 每格默认 ${config.candidates_per_panel} 张</div>`;
      $('#cf-backend').value = config.backend;
    } catch (e) { $('#settings-comfy-overview').textContent = '读取配置失败：' + e.message; }
  }

  async function enter(tab, requested) {
    const section = sectionFor(tab, requested);
    document.querySelectorAll(`#tab-${tab} .subnav button`).forEach((button) => {
      const selected = (button.dataset.settingsSection || button.dataset.assetsSection) === section;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    });
    if (tab === 'settings') {
      document.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== section));
      if (section === 'providers') await loadProviders();
      else if (section === 'models') await loadStageBinding();
      else await loadComfyOverview();
    } else if (tab === 'assets') { await loadAssets(); ensureLoraDatalist(); }
    else if (tab === 'templates') await refreshTemplates();
  }

  $('#tab-settings').querySelectorAll('[data-settings-section]').forEach((button) => button.addEventListener('click', () => switchTab('settings', button.dataset.settingsSection)));
  $('#tab-assets').querySelectorAll('[data-assets-section]').forEach((button) => button.addEventListener('click', () => switchTab('assets', button.dataset.assetsSection)));
  $('#templates-refresh').addEventListener('click', refreshTemplates);
  $('#assets-refresh').addEventListener('click', () => loadAssets(true));
  $('#pr-assets').addEventListener('click', () => switchTab('assets', 'characters'));
  document.addEventListener('comic-assets:rendered', syncAssets);
  return { sectionFor, enter, loadAssets, syncAssets, refreshTemplates, loadComfyOverview };
}
