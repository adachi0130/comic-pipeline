const STEPS = {
  novel: { id: 'S1', label: '正文', next: 'pages', nextLabel: '分格分页', empty: '先写一段正文，再审核通过作为分格依据。' },
  pages: { id: 'S2', label: '分格分页', next: 'prompts', nextLabel: '提示词', empty: '选择版式或让 AI 分格，完成后审核漫画页。' },
  prompts: { id: 'S3', label: '提示词', next: 'images', nextLabel: '出图', empty: '为每格生成正负面提示词，核对角色、画风和 LoRA。' },
  images: { id: 'S4', label: '出图', next: 'compose', nextLabel: '分页合成', empty: '生成候选图并采用每格满意的画面。' },
  compose: { id: 'S5', label: '分页合成', next: 'exports', nextLabel: '整册导出', empty: '合成整页或在漫画编辑器精修，保存后审核。' },
  editor: { id: 'S5', label: '漫画页编辑', next: 'compose', nextLabel: '整页预览与审核', empty: '选页并编辑；保存后返回预览，审核整页再导出。' },
  exports: { id: 'S6', label: '整册导出', next: 'pipeline', nextLabel: '流水线总览', empty: '确认纳入的漫画页，选择 PDF/CBZ 格式生成成册文件。' },
};

export function createWorkbenchNavigation({ state, $, esc, switchTab, pickProject, toast }) {
  const select = $('#project-switch');
  const currentTab = () => document.querySelector('.nav button[data-tab].active')?.dataset.tab || 'projects';

  function closeMenu() {
    document.body.classList.remove('nav-open');
    $('#mobile-menu').setAttribute('aria-expanded', 'false');
    $('#mobile-menu').textContent = '菜单';
  }

  function update() {
    const tab = currentTab();
    $('#breadcrumb-project').textContent = state.project?.title || '未选择项目';
    $('#breadcrumb-section').textContent = document.querySelector('.nav button[data-tab].active .nav-label')?.textContent || tab;
    if (state.project) {
      $('#cur-proj').innerHTML = `<b>${esc(state.project.title)}</b><span class="mut">${state.project.target_pages} 页 · ${state.project.review_mode === 'auto' ? '自动审核' : '人工审查'}</span>`;
    }
    select.value = state.projectId ? String(state.projectId) : '';
    document.querySelectorAll('[data-stage-badge]').forEach((badge) => {
      const stats = state.projectId ? state._gates?.[badge.dataset.stageBadge] : null;
      badge.className = 'nav-count';
      badge.title = stats ? `共 ${stats.count} 项 · 已通过 ${stats.approved} · 待审 ${stats.review} · 需重跑 ${stats.stale}` : '选择项目后显示阶段状态';
      if (stats?.stale) { badge.textContent = `${stats.stale} 重跑`; badge.classList.add('stale'); }
      else if (stats?.review) { badge.textContent = `${stats.review} 待审`; badge.classList.add('warn'); }
      else badge.textContent = stats?.count ? `${stats.approved}/${stats.count}` : '—';
    });
    const step = STEPS[tab];
    $('#workflow-context').classList.toggle('hidden', !step);
    if (!step) return;
    $('#context-stage').textContent = `${step.id} · ${step.label}`;
    const counts = state._gates?.[step.id];
    $('#context-status').textContent = !state.projectId ? '先选择一个漫画项目，再开始这个阶段。'
      : counts?.count ? `共 ${counts.count} 项 · 已通过 ${counts.approved}${counts.review ? ' · 待审 ' + counts.review : ''}${counts.stale ? ' · 需重跑 ' + counts.stale : ''}`
      : step.empty;
    $('#context-next').textContent = state.projectId ? `${step.id === 'S6' ? '返回' : '下一步'}：${step.nextLabel}` : '选择漫画项目';
  }

  function onNavigate(tab) {
    const active = document.querySelector('.nav button[data-tab].active') || document.querySelector(`.nav button[data-tab="${tab}"]`);
    document.querySelectorAll('.nav button[data-tab]').forEach((button) => {
      if (button === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const group = active?.closest('details');
    if (group) group.open = true;
    closeMenu(); update();
  }

  function setProjects(rows) {
    select.innerHTML = '<option value="">选择漫画项目</option>' + rows.map((project) => `<option value="${project.id}">${esc(project.title)}</option>`).join('');
    update();
  }

  document.querySelectorAll('[data-nav-group]').forEach((group) => {
    try {
      const open = localStorage.getItem('comic.nav.' + group.dataset.navGroup);
      if (open !== null) group.open = open === '1';
    } catch { /* 私密浏览 */ }
    group.addEventListener('toggle', () => {
      try { localStorage.setItem('comic.nav.' + group.dataset.navGroup, group.open ? '1' : '0'); } catch { /* 私密浏览 */ }
    });
  });
  $('#mobile-menu').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('#mobile-menu').setAttribute('aria-expanded', String(open));
    $('#mobile-menu').textContent = open ? '收起' : '菜单';
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  $('#breadcrumb-project').addEventListener('click', () => switchTab('projects'));
  $('#context-next').addEventListener('click', () => {
    const step = STEPS[currentTab()];
    switchTab(state.projectId && step ? step.next : 'projects');
  });
  select.addEventListener('change', async () => {
    const id = Number(select.value);
    if (!id) { select.value = state.projectId ? String(state.projectId) : ''; return; }
    select.disabled = true;
    try { await pickProject(id); } catch (e) { toast('切换项目失败：' + e.message, 'err'); }
    finally { select.disabled = false; update(); }
  });
  return { update, onNavigate, setProjects };
}
