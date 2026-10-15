/* 自研前端逻辑（原生 ES module，无构建）。
 * 新流程：S1 正文（酒馆写/续写/审核）→ S2 分格 → S3 提示词 → S4 出图 → S5 合成 → S6 导出
 * 所有数据按当前项目隔离，切换项目会全量刷新。
 */

import { createEditorWorkbench } from './editor-workbench.js';
import { createExportCenter } from './export-center.js';
import { createWorkbenchNavigation } from './workbench-navigation.js';
import { createConfigurationCenter } from './configuration-center.js';
import { createEditFeedback } from './edit-feedback.js';
import { createProviderManager } from './provider-manager.js';
import { createComfySettings } from './comfy-settings.js';
import { createImageWorkbench } from './image-workbench.js';
import { createPipelineOverview } from './pipeline-overview.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const API = '';

const state = { projectId: null, project: null, meta: null, templates: [], techniques: [] };
const editorWorkbench = createEditorWorkbench({ state, api, $, toast, switchTab, loadCompose, refreshGates, pageLabel });

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg, kind = '') {
  let stack = $('#toast-stack');
  if (!stack) {
    stack = document.createElement('div'); stack.id = 'toast-stack'; stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite'); stack.setAttribute('aria-relevant', 'additions'); document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const text = document.createElement('span'); text.textContent = msg;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close';
  close.textContent = '×'; close.setAttribute('aria-label', '关闭提示'); close.addEventListener('click', () => el.remove());
  el.append(text, close); stack.appendChild(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => el.remove(), 4200);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS = {
  approved: ['ok', '已通过'], review: ['warn', '待审查'], rejected: ['err', '已驳回'],
  stale: ['stale', '需重跑'], running: ['run', '生成中'], pending: ['', '待生成'],
  done: ['ok', '完成'], failed: ['err', '失败'], queued: ['', '排队中'], cancelled: ['', '已取消'],
};
const pill = (s) => { const [c, l] = STATUS[s] || ['', s || '—']; return `<span class="pill ${c}"><i class="dotm"></i>${l}</span>`; };
const exportCenter = createExportCenter({ state, api, $, esc, pill, toast, switchTab, pageLabel });
const navigation = createWorkbenchNavigation({ state, $, esc, switchTab, pickProject, toast });
const editFeedback = createEditFeedback({ toast });
const comfySettings = createComfySettings({ api, $, esc, toast, editFeedback, onSaved: () => { configuration.loadComfyOverview(); imageWorkbench.refreshConnection(); } });
const providerManager = createProviderManager({ api, $, esc, toast, editFeedback, refreshBindings: loadStageBinding });
const configuration = createConfigurationCenter({ state, api, $, esc, toast, switchTab,
  loadProviders, loadStageBinding, loadCharacterPresetPanel, loadStyleLoras, ensureLoraDatalist, editFeedback });
const imageWorkbench = createImageWorkbench({ state, api, $, esc, pill, toast, editFeedback, refreshGates, openComfySettings, switchTab, pageLabel, panelFullLabel, attachLoraCombos, ensureLoraDatalist });
const pipelineOverview = createPipelineOverview({ state, api, $, esc, pill, toast, switchTab, refreshGates,
  pageLabel, panelFullLabel, openPageDetail, openStageArtifacts, openMedPage,
  focusImage: (ref) => { switchTab('images'); imageWorkbench.focus(ref); } });
let projectPickRequest = 0;
let assetCardsRequest = 0, styleRequest = 0, styleEditor = null;
let assetMutationInFlight = false;
let projectDetailRequest = 0, projectDetailId = null;
let projectWriteEpoch = 0;
const assetEditors = new WeakMap();

// ---------- Tab ----------
const TITLES = {
  projects: ['项目管理', '选择或新建一部漫画'],
  novel: ['正文', '用酒馆写小说，逐段审核，然后进入分页'],
  pipeline: ['流水线总览', '从正文到漫画成册，查看当前画面与后台任务'],
  pages: ['分格分页', '每页选模板（或让 AI 选）+ 打分格，并预览正文产物'],
  prompts: ['提示词', 'S3 分镜提示词：每格一句出图词'],
  images: ['出图', '连上后端 → 选工作流 → 出图挑图'],
  compose: ['分页合成', '选好的画面按漫画框拼成整页'],
  editor: ['漫画编辑器', '在当前工作台精修漫画页，保存后继续编辑'],
  exports: ['整册导出', '预览页序，导出 PDF / CBZ，下载历史版本'],
  settings: ['设置', 'LLM 供应商 / ComfyUI / 阶段绑定'],
  assets: ['角色与画风', '管理本项目的角色、预设和画风 LoRA'],
  templates: ['系统提示词', '查看与编辑三个阶段实际使用的系统和用户模板'],
};
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab, b.dataset.section)));

// 可折叠标题：点标题收起/展开它指向的内容块（状态记在 localStorage，刷新后保留）
function getFold(key, defClosed) {
  try { const v = localStorage.getItem('comic.fold.' + key); return v == null ? !!defClosed : v === '1'; }
  catch { return !!defClosed; }
}
function setFold(key, closed) { try { localStorage.setItem('comic.fold.' + key, closed ? '1' : '0'); } catch { /* ignore */ } }
function applyFold(h) {
  const t = document.getElementById(h.dataset.fold);
  if (!t) return;
  const closed = getFold(h.dataset.fold, h.classList.contains('closed'));
  t.classList.toggle('hidden', closed);
  h.classList.toggle('closed', closed);
}
document.addEventListener('click', (e) => {
  const h = e.target.closest && e.target.closest('h2.foldable');
  if (!h || !h.dataset.fold) return;
  const t = document.getElementById(h.dataset.fold);
  if (!t) return;
  const hidden = t.classList.toggle('hidden');
  h.classList.toggle('closed', hidden);
  setFold(h.dataset.fold, hidden);
});
function switchTab(tab, requestedSection) {
  const section = configuration.sectionFor(tab, requestedSection);
  $$('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab && (!x.dataset.section || x.dataset.section === section)));
  Object.keys(TITLES).forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
  $('.main').classList.toggle('editor-active', tab === 'editor');
  if (tab !== 'editor') editorWorkbench.collapse();
  try { localStorage.setItem('comic.tab', tab); } catch { /* ignore */ }   // 记住当前菜单，刷新后回到这里
  $('#view-title').textContent = TITLES[tab][0];
  $('#view-sub').textContent = TITLES[tab][1];
  navigation.onNavigate(tab);
  if (tab === 'novel') { loadNovel(); setNovelMethod(getNovelMethod()); }
  if (tab === 'pipeline') renderFlow();
  if (tab === 'images') loadWorkbench();
  if (tab === 'pages') loadPages();
  if (tab === 'prompts') loadPrompts();
  if (tab === 'compose') loadCompose();
  if (tab === 'editor') editorWorkbench.loadPages();
  if (tab === 'exports') exportCenter.load();
  if (tab === 'images' || tab === 'prompts') ensureLoraDatalist();
  if (['settings', 'assets', 'templates'].includes(tab)) configuration.enter(tab, section).catch((e) => toast(e.message, 'err'));
  if (tab === 'projects') {
    // 已选中项目时停在详情（二级），否则显示列表（一级）
    showProjectView(state.projectId ? 'detail' : 'list');
    if (state.projectId) {
      const projectId = state.projectId, epoch = projectWriteEpoch;
      api('/api/projects/' + projectId).then((project) => {
        if (projectId !== state.projectId || epoch !== projectWriteEpoch) return;
        state.project = project; renderProjectDetail();
      }).catch((error) => toast('项目读取失败：' + error.message, 'err'));
    }
  }
}

// ---------- 健康 ----------
async function checkHealth() {
  try { await api('/api/health'); $('#health').className = 'pill ok'; $('#health').innerHTML = '<i class="dotm"></i>后端在线'; }
  catch { $('#health').className = 'pill err'; $('#health').innerHTML = '<i class="dotm"></i>后端离线'; }
}

// ---------- 项目 ----------
async function loadProjects() {
  const rows = await api('/api/projects');
  navigation.setProjects(rows);
  const box = $('#plist');
  if (!rows.length) { box.innerHTML = '<div class="empty">还没有项目，先在上面创建一个</div>'; return rows; }
  box.innerHTML = rows.map((p) => `
    <div class="pitem ${p.id === state.projectId ? 'sel' : ''}" data-pick="${p.id}" role="button" tabindex="0" aria-label="打开项目 ${esc(p.title)}">
      <div class="av">${esc((p.title || '?').slice(0, 1))}</div>
      <div><b>${esc(p.title)}</b><div class="meta">${p.target_pages} 页 · ${p.review_mode === 'auto' ? '自动审核' : '人工审查'}</div></div>
      <div class="spacer"></div>
      ${p.id === state.projectId ? '<span class="pill ok"><i class="dotm"></i>当前</span>' : '<span class="mut" style="font-size:12.5px">点击打开</span>'}
    </div>`).join('');
  $$('[data-pick]').forEach((el) => {
    el.addEventListener('click', () => pickProject(+el.dataset.pick));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickProject(+el.dataset.pick); }
    });
  });
  return rows;
}

// 返回一级（项目列表）
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#pv-back')) showProjectView('list');
});

/** 显示「项目」标签内的一级列表 / 二级详情。 */
function showProjectView(which) {
  const isDetail = which === 'detail';
  const lv = $('#pv-list'), dv = $('#pv-detail');
  if (lv) lv.classList.toggle('hidden', isDetail);
  if (dv) dv.classList.toggle('hidden', !isDetail);
}

async function pickProject(id) {
  if (id === state.projectId) { showProjectView('detail'); renderProjectDetail(); return; }
  const request = ++projectPickRequest;
  let project;
  try { project = await api('/api/projects/' + id); }
  catch (e) { toast('无法打开项目：' + e.message, 'err'); return; }
  if (request !== projectPickRequest) return;
  if (id !== state.projectId) {
    if (!(await editFeedback.prepare(['asset-cards', 'asset-style', 'project-form', 'project-dialog', 'image-editor'], '切换项目'))) return;
    if (request !== projectPickRequest) return;
    if (state.editor?.dirty && state.editor.projectId !== id && !confirm('当前漫画页有未保存的修改。切换项目会关闭它，确定继续吗？')) return;
    editFeedback.clear(['asset-cards', 'asset-style', 'project-form', 'project-dialog', 'image-editor']); styleEditor = null;
    imageWorkbench.reset();
    pipelineOverview.reset();
    projectDetailId = null; projectDetailRequest++;
    $('#proj-detail').innerHTML = '<div class="empty">正在加载新项目详情…</div>';
    $('#pr-chars').innerHTML = '<div class="empty">正在加载新项目资产…</div>';
    $('#pr-style').innerHTML = '<div class="empty">正在加载新项目画风…</div>'; $('#pr-style-status').textContent = '';
  }
  if (state.editor && state.editor.projectId !== id) editorWorkbench.reset();
  state.projectId = id;
  try { localStorage.setItem('comic.lastProjectId', String(id)); } catch { /* 隐私模式忽略 */ }
  state.project = project;
  state._gates = null; state._composePages = null; state._composeSelected = null;
  state._doneJobs = {}; navigation.update();
  startJobsSSE();
  showProjectView('detail');                       // 进入二级页面
  const h = $('#pd-title-h'); if (h) h.textContent = state.project.title || '项目详情';
  const c = $('#pv-crumb'); if (c) c.textContent = `项目 / ${state.project.title || ''}`;
  $('#cur-proj').innerHTML = `<b>${esc(state.project.title)}</b>
    <span class="mut">${state.project.target_pages} 页 · ${state.project.review_mode === 'auto' ? '自动审核' : '人工审查'}</span>`;
  $('#automode').checked = state.project.review_mode === 'auto';
  // 项目隔离：切项目时全量刷新所有视图
  await loadProjects();
  await ensureMeta();
  if (request !== projectPickRequest || state.projectId !== id) return;
  renderProjectDetail();
  await renderFlow();
  refreshGates();
  const active = document.querySelector('.nav button.active')?.dataset.tab;
  if (active === 'novel') loadNovel();
  if (active === 'images') loadWorkbench();
  if (active === 'prompts') loadPrompts();
  if (active === 'compose') loadCompose();
  if (active === 'pages') loadPages();
  if (active === 'editor') editorWorkbench.loadPages();
  if (active === 'exports') exportCenter.load();
  if (active === 'assets') configuration.loadAssets();
  navigation.update();
}

// 元信息（阶段定义/模板/技法）懒加载 + 自愈：初次失败时下次重试
async function ensureMeta() {
  if (state.meta) return state.meta;
  try {
    state.meta = await api('/api/meta');
    state.templates = state.meta.templates; state.techniques = state.meta.techniques;
  } catch (e) { console.warn('加载 /api/meta 失败，稍后重试', e); }
  return state.meta;
}

// 项目详情卡片
async function renderProjectDetail() {
  const projectId = state.projectId;
  const request = ++projectDetailRequest;
  const box = $('#proj-detail');
  if (!box) return;
  const p = state.project;
  if (!p || !state.projectId) { box.innerHTML = '<div class="empty">未选择项目</div>'; return; }
  if (projectDetailId === projectId && (editFeedback.unsettled('project-form') || _userEditingDetail())) {
    updateProjectStats(); return;
  }
  const g = state._gates || {};

  // 小说状态（全文只看已通过）
  let novel = { chars: 0, total_count: 0, approved_count: 0, text: '' };
  try { novel = await api(`/api/projects/${projectId}/novel`); } catch { /* 忽略 */ }

  // 各阶段产物明细
  let arts = {};
  try { arts = await api(`/api/projects/${projectId}/stage-artifacts`); } catch { /* 忽略 */ }
  if (projectId !== state.projectId || request !== projectDetailRequest) return;
  if (projectDetailId === projectId && (editFeedback.unsettled('project-form') || _userEditingDetail())) {
    updateProjectStats(); return;
  }
  editFeedback.clear('project-form'); projectDetailId = projectId;

  const stageRows = (state.meta?.stages || []).map((s) => {
    const x = g[s.id] || {};
    const blk = arts[s.id] || { items: [], label: s.name };
    const items = blk.items || [];
    const first = items.slice(0, 3).map((it) =>
      `<div class="mut" style="font-size:12px">· ${esc(it.ref)} ${pill(it.status)} ${esc(it.summary || '')}</div>`).join('');
    const more = items.length > 3 ? `<div class="mut" style="font-size:12px">…共 ${items.length} 项</div>` : '';
    return `<div class="pitem" style="display:block">
      <div class="row" style="margin-bottom:4px">
        <span class="pill tag">${s.id}</span><b>${esc(s.name)}</b>
        <div class="spacer"></div>
        <span class="pill tag">${x.count || 0} 项</span>
        ${x.approved ? `<span class="pill ok"><i class="dotm"></i>${x.approved}</span>` : ''}
        ${x.review ? `<span class="pill warn"><i class="dotm"></i>${x.review}</span>` : ''}
        ${x.stale ? `<span class="pill stale"><i class="dotm"></i>${x.stale}</span>` : ''}
        <button class="sm" data-jump="${s.id}">查看/编辑</button>
      </div>
      ${items.length ? first + more : '<div class="mut" style="font-size:12px">（暂无产物）</div>'}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="grid2" style="margin-bottom:10px">
      <div data-project-field="title"><label class="fld">标题</label>
        <div class="row"><input id="pd2-title" value="${esc(p.title)}" style="flex:1">
          <button class="sm" data-save="title">保存</button></div></div>
      <div data-project-field="target_pages"><label class="fld">目标页数（可改）</label>
        <div class="row"><input id="pd2-pages" type="number" min="1" value="${p.target_pages}" style="flex:1">
          <button class="sm" data-save="target_pages">保存</button></div></div>
    </div>
    <div data-project-field="outline" style="margin-bottom:10px"><label class="fld">故事大纲</label>
      <textarea id="pd2-outline" style="min-height:90px">${esc(p.outline || '')}</textarea>
      <div class="row" style="margin-top:6px"><button class="sm" data-save="outline">保存大纲</button>
        <span class="mut" style="font-size:12px">大纲会影响 S2 分格时对剧情的取舍</span></div></div>

    <div class="divider"></div>
    <div class="row" style="margin-bottom:6px">
      <b>小说全文</b>
      <span class="pill ${novel.chars ? 'ok' : ''}">已通过 ${novel.approved_count}/${novel.total_count} 段 · ${novel.chars} 字</span>
      <div class="spacer"></div>
      <button class="sm" data-goto="novel">去「正文」页编辑</button>
    </div>
    <div class="novel" id="pd-novel" style="max-height:260px">
      ${novel.text ? novel.text.split(/\n{2,}/).map((t) => `<p>${esc(t)}</p>`).join('')
                   : '<div class="empty">暂无已通过的正文（在「正文」页写并审核通过后才会计入）</div>'}
    </div>

    <div class="divider"></div>
    <div class="row" style="margin-bottom:8px"><b>各阶段产物</b>
      <span class="mut" style="font-size:12px">点「查看/编辑」进入该阶段</span></div>
    <div class="plist" id="pd-stats">${stageRows}</div>`;

  const fields = { title: '#pd2-title', target_pages: '#pd2-pages', outline: '#pd2-outline' };
  const labels = { title: '标题', target_pages: '目标页数', outline: '故事大纲' };
  for (const [field, selector] of Object.entries(fields)) {
    editFeedback.track({
      element: box.querySelector(`[data-project-field="${field}"]`), group: 'project-form', label: labels[field],
      saveButton: box.querySelector(`[data-save="${field}"]`),
      read: () => ({ [field]: field === 'target_pages' ? Number(box.querySelector(selector).value) : box.querySelector(selector).value }),
      write: async (body) => {
        if (field === 'target_pages' && (!Number.isInteger(body[field]) || body[field] < 1)) throw new Error('目标页数请填写大于 0 的整数');
        if (field === 'title' && !body.title.trim()) throw new Error('标题不能为空');
        projectWriteEpoch++;
        const project = await api('/api/projects/' + projectId, { method: 'PATCH', body: JSON.stringify(body) });
        if (projectId !== state.projectId) return;
        state.project = project; navigation.update();
        $('#pd-title-h').textContent = project.title || '项目详情'; $('#pv-crumb').textContent = '项目 / ' + (project.title || '');
        loadProjects(); refreshGates();
      },
    });
  }
  // 跳阶段
  box.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => openStageArtifacts(b.dataset.jump)));
  box.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
}

/** 用户是否正在项目详情里输入（打字时不要覆盖他的输入）。 */
function _userEditingDetail() {
  const el = document.activeElement;
  if (!el) return false;
  const box = document.getElementById('proj-detail');
  if (!box || !box.contains(el)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

/**
 * 只更新「小说预览 + 各阶段统计」两块，**不动可编辑表单**。
 * 定时刷新/作业事件走这里，避免把用户正在输入的内容冲掉。
 */
async function updateProjectStats() {
  const projectId = state.projectId;
  if (!state.projectId) return;
  if (_userEditingDetail()) return;          // 正在输入 -> 跳过
  const novelBox = document.getElementById('pd-novel');
  const statsBox = document.getElementById('pd-stats');
  if (!novelBox && !statsBox) return;
  const g = state._gates || {};
  try {
    const [novel, arts] = await Promise.all([
      api(`/api/projects/${projectId}/novel`).catch(() => null),
      api(`/api/projects/${projectId}/stage-artifacts`).catch(() => ({})),
    ]);
    if (projectId !== state.projectId) return;
    if (novelBox && novel && !_userEditingDetail()) {
      novelBox.innerHTML = novel.text
        ? novel.text.split(/\n{2,}/).map((t) => `<p>${esc(t)}</p>`).join('')
        : '<div class="empty">暂无已通过的正文（在「正文」页写并审核通过后才会计入）</div>';
    }
    if (statsBox && !_userEditingDetail()) {
      statsBox.innerHTML = (state.meta?.stages || []).map((s) => {
        const x = g[s.id] || {};
        const blk = arts[s.id] || { items: [] };
        const items = blk.items || [];
        const first = items.slice(0, 3).map((it) =>
          `<div class="mut" style="font-size:12px">· ${esc(it.ref)} ${pill(it.status)} ${esc(it.summary || '')}</div>`).join('');
        const more = items.length > 3 ? `<div class="mut" style="font-size:12px">…共 ${items.length} 项</div>` : '';
        return `<div class="pitem" style="display:block">
          <div class="row" style="margin-bottom:4px">
            <span class="pill tag">${s.id}</span><b>${esc(s.name)}</b>
            <div class="spacer"></div>
            <span class="pill tag">${x.count || 0} 项</span>
            ${x.approved ? `<span class="pill ok"><i class="dotm"></i>${x.approved}</span>` : ''}
            ${x.review ? `<span class="pill warn"><i class="dotm"></i>${x.review}</span>` : ''}
            ${x.stale ? `<span class="pill stale"><i class="dotm"></i>${x.stale}</span>` : ''}
            <button class="sm" data-jump="${s.id}">查看/编辑</button>
          </div>
          ${items.length ? first + more : '<div class="mut" style="font-size:12px">（暂无产物）</div>'}
        </div>`;
      }).join('');
      statsBox.querySelectorAll('[data-jump]').forEach((b) =>
        b.addEventListener('click', () => openStageArtifacts(b.dataset.jump)));
    }
  } catch { /* 忽略 */ }
}


function openNewProject() {
  const m = $('#newproj-modal');
  m.classList.remove('hidden');
  $('#np-title').value = ''; $('#np-outline').value = ''; $('#np-pages').value = '16';
  setTimeout(() => $('#np-title').focus(), 50);
}
function closeNewProject() { $('#newproj-modal').classList.add('hidden'); }
$('#btn-new-proj').addEventListener('click', openNewProject);
$('#np-cancel').addEventListener('click', closeNewProject);
$('#newproj-modal').addEventListener('click', (e) => { if (e.target.id === 'newproj-modal') closeNewProject(); });
$('#btn-new').addEventListener('click', async () => {
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({
      title: $('#np-title').value || '未命名漫画', outline: $('#np-outline').value, target_pages: +$('#np-pages').value || 16 }) });
    toast('项目已创建', 'ok');
    closeNewProject();
    await pickProject(p.id);       // 创建后直接进入二级详情页
  } catch (e) { toast('创建失败：' + e.message, 'err'); }
});

$('#automode').addEventListener('change', async () => {
  if (!state.projectId) { toast('先选择项目', 'err'); $('#automode').checked = false; return; }
  try {
    await api(`/api/projects/${state.projectId}/review-mode`, { method: 'PATCH', body: JSON.stringify({ mode: $('#automode').checked ? 'auto' : 'manual' }) });
    state.project.review_mode = $('#automode').checked ? 'auto' : 'manual';
    toast($('#automode').checked ? '已开启自动审核' : '已切到人工审查', 'ok');
    navigation.update();
    renderFlow();
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- 酒馆对话面板 ----------
$('#tv-refresh').addEventListener('click', () => loadTavern({ expand: true }));
$('#tv-chats-refresh').addEventListener('click', () => loadTavern({ expand: true }));
$('#tv-error-close').addEventListener('click', async () => {
  state._errDismissed = $('#tv-error-text').textContent;   // 记住这条，别再弹回
  $('#tv-error').classList.add('hidden');
  try { await api('/api/tavern/live/clear', { method: 'POST' }); } catch { /* 忽略 */ }
});
$('#tv-send').addEventListener('click', sendToTavern);
$('#tv-use-outline').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  try {
    const p = state.project && state.project.id === state.projectId
      ? state.project : await api('/api/projects/' + state.projectId);
    state.project = p;
    const outline = (p.outline || '').trim();
    if (!outline) return toast('这个项目还没有填故事大纲，请到「项目」详情里填写', 'err');
    const box = $('#tv-input');
    box.value = box.value.trim() ? box.value.replace(/\s*$/, '') + '\n\n' + outline : outline;
    box.focus();
    toast('已引用故事大纲到输入框', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
$('#tv-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendToTavern(); }
});

async function sendToTavern() {
  if (!state.projectId) return toast('先选择项目', 'err');
  const text = $('#tv-input').value.trim();
  if (!text) return toast('消息不能为空', 'err');
  try {
    state.chatLenAtSend = state.chatLenNow ?? null;
    $('#tv-error').classList.add('hidden');
    state._errDismissed = null;
    const r = await api(`/api/projects/${state.projectId}/tavern/send`, { method: 'POST', body: JSON.stringify({ text }) });
    $('#tv-input').value = '';
    toast(`已发给酒馆 #${r.job_id}，生成后回传为正文`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/** 判断是否酒馆的无用系统消息/欢迎内容（这些不显示）。 */
function isNoise(m) {
  const name = (m.name || '').trim();
  const mes = m.mes || '';
  if (name === 'SillyTavern System' || name === 'System') return true;
  // 欢迎面板 / 脚本注入的 HTML
  if (/^\s*<div/i.test(mes) || /flex-container|menu_button|mes_text/.test(mes)) return true;
  // 酒馆的系统提示噪声
  if (/already configured the API|尝试发送些什么|Hint:/i.test(mes)) return true;
  return false;
}

/** 渲染酒馆对话列表（Recent Chats），点一下切换。 */
function renderChatList(chats, context, snapshot = {}) {
  const box = $('#tv-chats');
  if (!box) return;
  chats = Array.isArray(chats) ? chats.filter((chat) => chat && typeof chat === 'object' && chat.file_name) : [];
  $('#tv-chats-count').textContent = chats.length + ' 个';
  const status = $('#tv-chats-state');
  const synced = snapshot.chats_updated_at ? new Date(snapshot.chats_updated_at).toLocaleString() : '';
  const bridge = snapshot.bridge_online === false ? '酒馆桥最近未同步；请确认酒馆标签页或常驻桥已打开、comic-bridge 已启用' : '酒馆桥已同步';
  status.dataset.status = snapshot.chats_error ? 'failed' : (!snapshot.available || snapshot.bridge_online === false) ? 'dirty' : 'saved';
  status.textContent = snapshot.chats_error
    ? `列表拉取失败：${snapshot.chats_error}${chats.length ? '；保留上次成功的 ' + chats.length + ' 个会话' : ''}`
    : snapshot.available ? `${bridge}${synced ? ' · 列表更新于 ' + synced : ''}` : '尚未收到酒馆桥推送；应用后端在线不代表酒馆桥已连接';
  const cur = $('#tv-cur');
  if (cur) cur.textContent = context.character_name ? `当前：${context.character_name}` : '未选择会话';
  if (!chats.length) {
    state._listSig = null;
    box.innerHTML = `<div class="empty">${snapshot.chats_error ? '暂时无法获取会话，请恢复酒馆连接后刷新。' : snapshot.available && snapshot.bridge_online !== false ? '酒馆桥本次没有返回会话。请先在酒馆创建或打开已有对话，再点「刷新列表」。' : '等待酒馆桥同步对话列表，可点「刷新列表」重试。'}</div>`;
    return;
  }
  const curAvatar = context.character_avatar || '';
  const curChat = String(context.chat_id || '').replace(/\.jsonl$/i, '');
  const listSig = JSON.stringify([curAvatar, curChat, chats]);
  if (listSig === state._listSig) return;   // 未变则不重绘
  state._listSig = listSig;
  const groups = new Map();
  for (const c of chats) { const name = c.char_name || '(未知角色)'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(c); }
  box.innerHTML = [...groups].map(([name, list]) => {
    const isCurChar = list.some((c) => c.avatar === curAvatar);
    return `
    <div style="margin-bottom:10px">
      <div class="mut" style="font-size:12px;margin-bottom:5px">${esc(name)}
        <span class="pill tag">${list.length}</span>
        ${isCurChar ? '<span class="pill ok"><i class="dotm"></i>当前角色</span>' : ''}</div>
      <div class="plist">
        ${list.map((c) => {
          const nm = String(c.file_name || '').replace(/\.jsonl$/i, '');
          const active = c.avatar === curAvatar && nm === curChat;
          return `<div class="pitem ${active ? 'sel' : ''}" role="button" tabindex="0"
              data-switch="${esc(JSON.stringify({ avatar: c.avatar, file_name: c.file_name, chat_name: nm }))}">
            <div style="flex:1;min-width:0">
              <b style="font-size:13.5px">${esc(nm)}</b>
              <div class="meta">${c.chat_items != null ? c.chat_items + ' 条 · ' : ''}${esc(c.last_mes || '')}${c.is_group ? ' · 群聊' : ''}</div>
            </div>
            ${active ? '<span class="pill ok"><i class="dotm"></i>当前</span>' : '<button class="sm">切换</button>'}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-switch]').forEach((el) => {
    el.addEventListener('click', () => switchChat(JSON.parse(el.dataset.switch)));
    el.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); el.click(); } });
  });
}

async function switchChat(info) {
  try {
    const r = await api('/api/tavern/switch', { method: 'POST', body: JSON.stringify(info) });
    toast(`已请求切换到「${info.chat_name}」#${r.job_id}`, 'ok');
    setTimeout(loadTavern, 2500);
  } catch (e) { toast(e.message, 'err'); }
}

// 对话列表折叠
function toggleChatList() {
  const body = $('#tv-chats-body');
  const arrow = $('#tv-chats-arrow');
  const hidden = body.classList.toggle('hidden');
  if (arrow) arrow.textContent = hidden ? '▸' : '▾';
  $('#tv-chats-toggle').setAttribute('aria-expanded', String(!hidden));
}
$('#tv-chats-toggle').addEventListener('click', toggleChatList);
$('#tv-chats-toggle').addEventListener('keydown', (event) => {
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); toggleChatList(); }
});

// 酒馆镜像 SSE：对话/列表发生变化就刷新（不用手动点刷新）
let _tvSSE = null;
let tavernReadRequest = 0, tavernPushEpoch = 0;
function startTavernSSE() {
  if (_tvSSE) _tvSSE.close();
  _tvSSE = new EventSource(API + '/api/tavern/events');
  _tvSSE.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      tavernPushEpoch++;
      state._tavern = d;
      const tab = document.querySelector('.nav button.active')?.dataset.tab;
      if (tab === 'novel') renderTavern(d);
    } catch { /* keep-alive */ }
  };
}

/** 只渲染酒馆面板部分（SSE 用，避免整页重载）。 */
function renderTavern(d) {
  const ctx = d.context || {};
  const chats = d.chats || [];
  // 最近列表有数量上限，当前会话不在列表里也应正常更新列表与正文。
  renderChatList(chats, ctx, d);
  if (!d.available) {
    $('#tv-meta').textContent = '还没有收到酒馆推送——请打开酒馆并启用 comic-bridge 扩展';
    $('#tv-chat').innerHTML = '<div class="empty">等待酒馆扩展推送…</div>';
    $('#tv-live').classList.add('hidden'); $('#tv-error').classList.add('hidden');
    state._chatSig = null; state._tavernRendered = false;
    return;
  }
  // 酒馆的“欢迎页”状态（没有选中角色）不是用户想要的视图，会被酒馆自身的加载循环
  // 反复推上来；保留已显示的聊天正文，但继续刷新列表、连接和错误状态。
  const keepHistory = !ctx.character_name && state._tavernRendered;
  if (ctx.character_name) state._tavernRendered = true;
  const c = d.context || {};
  $('#tv-meta').innerHTML = `当前角色：<b>${esc(c.character_name || '—')}</b>
    · 对话 ${c.message_count || 0} 条${c.chat_id ? ` · 会话 ${esc(String(c.chat_id).replace(/\.jsonl$/, ''))}` : ''}
    <span class="mut" style="font-size:12px">（更新于 ${(d.updated_at || '').replace('T', ' ').slice(0, 19)}）</span>`;
  if (keepHistory) $('#tv-meta').textContent = '酒馆当前未选中角色，暂保留上次会话记录；可从上方列表切换会话';
  const rc = d.receipt || {};
  const bits = [];
  if (rc.character_name) bits.push(`角色卡 ${esc(rc.character_name)}`);
  if (rc.world_books?.length) bits.push(`世界书 ${esc(rc.world_books.join('、'))}${rc.world_count ? `(${rc.world_count}条)` : ''}`);
  if (rc.preset_name) bits.push(`预设 ${esc(rc.preset_name)}`);
  if (rc.model) bits.push(`模型 ${esc(rc.model)}`);
  $('#tv-receipt').textContent = '生成依据：' + (bits.length ? bits.join(' · ') : '尚未生成');

  // 流式 / 错误展示
  const live = d.live || {};
  const liveBox = $('#tv-live'), errBox = $('#tv-error');
  if (live.text) {
    liveBox.classList.remove('hidden');
    errBox.classList.add('hidden');
    $('#tv-live-text').textContent = live.text;
    $('#tv-live-chars').textContent = `${live.chars || 0} 字`;
    const st = $('#tv-live-state');
    if (live.done) { st.className = 'pill ok'; st.innerHTML = '<i class="dotm"></i>已完成，待审核'; }
    else { st.className = 'pill run'; st.innerHTML = '<i class="dotm"></i>流式接收中…'; }
  } else if (!live.error) {
    liveBox.classList.add('hidden');
  }
  if (live.error) {
    // 用户已关闭过同一条错误就不再弹回
    if (state._errDismissed !== live.error) {
      errBox.classList.remove('hidden');
      $('#tv-error-text').textContent = live.error;
    }
  } else {
    errBox.classList.add('hidden');
    state._errDismissed = null;
  }

  if (keepHistory) return;
  const msgs = (d.messages || []).filter((m) => !isNoise(m));
  state.chatLenNow = msgs.length;
  const lc = $('#tv-lastcount');
  if (lc) lc.textContent = state.chatLenAtSend != null
    ? `发送前 ${state.chatLenAtSend} 条 · 现在 ${msgs.length} 条`
    : `当前会话共 ${msgs.length} 条`;
  const box = $('#tv-chat');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  // 内容签名未变则不重绘，避免整块刷新造成闪烁
  const sig = msgs.map((m) => (m.name || '') + '' + (m.send_date || '') + '' + (m.mes || '')).join('');
  if (sig === state._chatSig) { if (nearBottom) box.scrollTop = box.scrollHeight; return; }
  state._chatSig = sig;
  box.innerHTML = msgs.length ? msgs.map((m) => `
    <div class="seg" style="margin-bottom:8px">
      <div class="segh"><b>${esc(m.name || (m.is_user ? '我' : '角色'))}</b>
        <span class="pill tag">${m.is_user ? '用户' : '角色'}</span>
        <span class="mut" style="font-size:11.5px">${esc(m.send_date || '')}</span></div>
      <div class="txt">${esc(m.mes || '')}</div></div>`).join('') : '<div class="empty">对话为空</div>';
  if (nearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

async function loadTavern({ expand = false } = {}) {
  const request = ++tavernReadRequest, epoch = tavernPushEpoch;
  const controls = [['#tv-chats-refresh', '刷新列表'], ['#tv-refresh', '刷新']];
  if (expand && $('#tv-chats-body').classList.contains('hidden')) toggleChatList();
  for (const [selector] of controls) { $(selector).disabled = true; $(selector).textContent = '刷新中…'; }
  $('#tv-chats-state').dataset.status = 'saving';
  $('#tv-chats-state').textContent = '正在读取最新对话列表…';
  try {
    const d = await api('/api/tavern/live', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (request !== tavernReadRequest || epoch !== tavernPushEpoch) return;
    state._tavern = d;
    renderTavern(d);
  } catch (error) {
    if (request !== tavernReadRequest || epoch !== tavernPushEpoch) return;
    const message = error.name === 'TimeoutError' ? '请求超时，请重试' : error.message;
    $('#tv-chats-state').dataset.status = 'failed';
    $('#tv-chats-state').textContent = '对话列表刷新失败：' + message + '；已有列表和输入已保留，可再次刷新';
    $('#tv-meta').textContent = '读取失败：' + message;
  } finally {
    if (request === tavernReadRequest) for (const [selector, label] of controls) { $(selector).disabled = false; $(selector).textContent = label; }
  }
}

// 通用：点标题折叠（默认收起，不加按钮）
function bindCollapse(toggleId, bodyId, arrowId) {
  const tg = document.getElementById(toggleId);
  if (!tg) return;
  tg.addEventListener('click', () => {
    const body = document.getElementById(bodyId);
    const arrow = document.getElementById(arrowId);
    const hidden = body.classList.toggle('hidden');
    if (arrow) arrow.textContent = hidden ? '▸' : '▾';
  });
}
bindCollapse('nv-segs-toggle', 'nv-segs-body', 'nv-segs-arrow');
bindCollapse('nv-full-toggle', 'nv-full-body', 'nv-full-arrow');

// ---------- 正文（小说） ----------
// 酒馆 pane 不再有「开始写作/续写」——改为在「酒馆对话」里直接发一条（见 sendToTavern）。

// ---------- S1 三种写作方式：先选，再显示对应操作区 ----------
const NV_METHODS = ['tavern', 'llm', 'paste'];
function getNovelMethod() { try { return localStorage.getItem('comic.novelMethod') || ''; } catch { return ''; } }
function setNovelMethod(m) {
  if (m) { try { localStorage.setItem('comic.novelMethod', m); } catch { /* ignore */ } }
  $$('#nv-methods [data-method]').forEach((b) => b.classList.toggle('primary', b.dataset.method === m));
  NV_METHODS.forEach((k) => { const el = $('#nv-pane-' + k); if (el) el.classList.toggle('hidden', k !== m); });
  if (m === 'tavern') loadTavern();
}
$$('#nv-methods [data-method]').forEach((b) => b.addEventListener('click', () => setNovelMethod(b.dataset.method)));

// 方式二：调用 LLM 写（带上项目标题 + 故事大纲）
$('#nv-llm-tpl').addEventListener('click', () => openPromptEditor('s1_prose'));
$('#nv-llm-start').addEventListener('click', () => requestProseLLM('start'));
$('#nv-llm-continue').addEventListener('click', () => requestProseLLM('continue'));
async function requestProseLLM(mode) {
  if (!state.projectId) return toast('先选择项目', 'err');
  const sb = $('#nv-llm-start'), cb = $('#nv-llm-continue');
  const old = sb.textContent;
  sb.disabled = cb.disabled = true;
  sb.textContent = mode === 'continue' ? old : 'LLM 写作中…';
  if (mode === 'continue') cb.textContent = 'LLM 续写中…';
  try {
    const r = await api(`/api/projects/${state.projectId}/prose/llm`, { method: 'POST',
      body: JSON.stringify({ mode, instruction: $('#nv-llm-instr').value }) });
    toast(`LLM 已生成一段正文（${r.chars} 字），见下方「分段审核」`, 'ok');
    $('#nv-llm-instr').value = '';
    loadNovel(); refreshGates();
  } catch (e) { toast('LLM 写作失败：' + e.message, 'err'); }
  finally { sb.disabled = cb.disabled = false; sb.textContent = old; cb.textContent = '续写'; }
}

// 方式三：自己粘贴正文
$('#nv-paste-add').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  const text = $('#nv-paste-text').value.trim();
  if (!text) return toast('请先粘贴正文内容', 'err');
  try {
    const r = await api(`/api/projects/${state.projectId}/prose/paste`, { method: 'POST',
      body: JSON.stringify({ text }) });
    toast(`已追加为一段正文（${r.chars} 字），见下方「分段审核」`, 'ok');
    $('#nv-paste-text').value = '';
    loadNovel(); refreshGates();
  } catch (e) { toast(e.message, 'err'); }
});

async function loadNovel() {
  const projectId = state.projectId;
  if (!state.projectId) { $('#nv-segs').innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  loadTavern();
  try {
    const n = await api(`/api/projects/${projectId}/novel`);
    if (projectId !== state.projectId) return;
    $('#nv-state').className = 'pill ' + (n.total_count === 0 ? '' : n.can_continue ? 'ok' : 'warn');
    $('#nv-state').innerHTML = `<i class="dotm"></i>${n.approved_count}/${n.total_count} 段已通过`;
    const sc = $('#nv-segs-count'); if (sc) sc.textContent = `${n.approved_count}/${n.total_count} 已通过`;
    const fc = $('#nv-full-count'); if (fc) fc.textContent = `${n.chars} 字`;
    const cb = $('#nv-continue'); if (cb) cb.disabled = !(n.can_continue && n.total_count > 0);

    // 分段
    const box = $('#nv-segs');
    if (!n.segments.length) box.innerHTML = '<div class="empty">还没有正文分段，点上面「开始写作」</div>';
    else box.innerHTML = n.segments.map((s) => {
      const rc = s.receipt || {};
      const bits = [];
      if (rc.character_name) bits.push(`角色卡 ${esc(rc.character_name)}`);
      if (rc.world_books?.length) bits.push(`世界书 ${esc(rc.world_books.join('、'))}${rc.world_count ? `(${rc.world_count}条)` : ''}`);
      if (rc.preset_name) bits.push(`预设 ${esc(rc.preset_name)}`);
      if (rc.model) bits.push(`模型 ${esc(rc.model)}`);
      if (rc.prompt_chars) bits.push(`提示词 ${rc.prompt_chars} 字`);
      return `
      <div class="seg" data-id="${s.id}">
        <div class="segh" style="cursor:pointer" data-fold="${s.id}">
          <span class="mut" style="font-size:12px" id="seg-arrow-${s.id}">▸</span>
          <b>第 ${s.index} 段</b> ${pill(s.status)}
          <span class="pill tag">${s.mode === 'continue' ? '续写' : s.mode === 'raw' ? '直发' : '起笔'}</span>
          <span class="mut" style="font-size:12px">${s.chars} 字</span>
          <span class="mut" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px">${esc((s.text || '').slice(0, 40))}</span>
          <div class="spacer"></div>
          <button class="sm" data-edit="${s.id}">编辑</button>
          <button class="sm" data-approve="${s.id}">通过</button>
          <button class="sm" data-reject="${s.id}" title="标记不合格，不会自动重写">驳回</button>
          <button class="sm danger" data-del="${s.id}" title="删除这一段">删除</button>
        </div>
        <div id="seg-body-${s.id}" class="hidden">
          ${bits.length ? `<div class="mut" style="font-size:12px;margin-bottom:6px">生成依据：${bits.join(' · ')}</div>` : ''}
          <div class="txt">${esc(s.text)}</div>
        </div>
      </div>`;
    }).join('');
    bindSegments();

    // 全文
    $('#nv-fullmeta').textContent = `已通过 ${n.approved_count} 段 · ${n.chars} 字（仅统计已通过）`;
    $('#nv-full').innerHTML = n.text ? n.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('') : '<div class="empty">暂无全文</div>';
  } catch (e) { toast(e.message, 'err'); }
}

function bindSegments() {
  // 只绑「分段审核」里的分段头；不要用全局 [data-fold]（那会连静态折叠卡片一起绑，
  // 导致找不到 seg-body-* 而报 null）。静态折叠由全局 h2.foldable 委托处理。
  $$('#nv-segs [data-fold]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;  // 点按钮不触发折叠
    const id = h.dataset.fold;
    const body = document.getElementById('seg-body-' + id);
    const arrow = document.getElementById('seg-arrow-' + id);
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    if (arrow) arrow.textContent = hidden ? '▸' : '▾';
  }));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这一段？')) return;
    await api('/api/artifacts/' + b.dataset.del, { method: 'DELETE' });
    toast('已删除该段', 'ok'); loadNovel(); refreshGates();
  }));
  $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/artifacts/${b.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
    toast('该段已通过', 'ok'); loadNovel(); refreshGates();
  }));
  $$('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const comment = prompt('驳回批注（可留空）：\n\n提示：驳回只是标记不合格，不会自动重写。可编辑后重审，或点删除重来。') || '';
    await api(`/api/artifacts/${b.dataset.reject}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
    toast('已驳回（仅标记，不会自动重写）', 'ok'); loadNovel(); refreshGates();
  }));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openSegEdit(+b.dataset.edit)));
}

async function openSegEdit(id) {
  const projectId = state.projectId;
  let a;
  try { a = await api('/api/artifacts/' + id); } catch (error) { return toast(error.message, 'err'); }
  if (projectId !== state.projectId) return;
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:720px">
    <h3>编辑第 ${(a.payload && a.payload.mode ? a.ref : a.ref)} 段</h3>
    <textarea id="seg-edit" style="min-height:320px">${esc(a.payload.text || '')}</textarea>
    <div class="row" style="margin-top:12px"><span class="mut" style="font-size:12.5px">保存会生成新版本并保留旧版</span>
      <div class="spacer"></div>
      <button class="sm" data-close>取消</button>
      <button class="primary sm" id="seg-save">保存</button></div></div>`;
  document.body.appendChild(box);
  editFeedback.protectDialog({
    box, label: '正文', saveButton: box.querySelector('#seg-save'),
    read: () => ({ text: box.querySelector('#seg-edit').value }),
    write: (body) => api(`/api/artifacts/${id}/payload`, { method: 'PATCH', body: JSON.stringify(body) }),
    afterSave: () => { loadNovel(); refreshGates(); if (!$('#tab-pages').classList.contains('hidden')) loadPages(); },
  });
}

$('#nv-refresh').addEventListener('click', () => { loadNovel(); toast('已刷新'); });
$('#nv-delall').addEventListener('click', async () => {
  if (!state.projectId) return;
  if (!confirm('清空本项目全部正文分段？此操作不可撤销。')) return;
  await api(`/api/projects/${state.projectId}/prose`, { method: 'DELETE' });
  toast('已清空全部正文', 'ok'); loadNovel(); refreshGates();
});

$('#nv-copy').addEventListener('click', async () => {
  if (!state.projectId) return;
  const n = await api(`/api/projects/${state.projectId}/novel`);
  try { await navigator.clipboard.writeText(n.text); toast('全文已复制', 'ok'); }
  catch { toast('复制失败，请手动选择', 'err'); }
});
$('#nv-export').addEventListener('click', () => {
  if (!state.projectId) return;
  window.open(`/api/projects/${state.projectId}/novel/approved`, '_blank');
});


// ---------- S2 页详情（分格 + 手动选模板 + 手改）----------
async function openPageDetail(pageRef) {
  const projectId = state.projectId;
  if (!projectId) return;
  let d, tpls;
  try { [d, tpls] = await Promise.all([
    api(`/api/projects/${projectId}/pages/${encodeURIComponent(pageRef)}`),
    api('/api/templates'),
  ]); } catch (error) { return toast('分格读取失败：' + error.message, 'err'); }
  if (projectId !== state.projectId) return;
  const box = document.createElement('div');
  box.className = 'modal';
  const tplOpts = tpls.map((x) => `<option value="${x.id}" ${x.id === d.template_id ? 'selected' : ''}>
      ${esc(x.id)}（${x.panels_count}格）</option>`).join('');
  box.innerHTML = `<div class="box" style="width:900px">
    <h3>${pageLabel(pageRef)} · 分格详情 <span class="mut" style="font-size:13px;font-weight:400">v${d.version}</span></h3>
    <div class="row" style="margin-bottom:10px">
      <span class="pill tag">当前模板</span>
      <b>${esc(d.template_id)}</b>
      <span class="mut">${esc((d.template || {}).layout_desc || '')} · ${(d.template || {}).panels_count || '?'} 格</span>
      <div class="spacer"></div>
      <button class="sm primary" id="pd-pick">换个版式…</button>
    </div>
    <div class="h2sub">换模板后分格数会自动对齐到新模板的格数（多出的格留空待填）。改完点「保存分格」。</div>
    <div id="pd-panels" style="margin-top:10px"></div>
    <div class="row" style="margin-top:14px">
      <span class="mut" style="font-size:12.5px">共 ${(d.panels || []).length} 格</span>
      <div class="spacer"></div>
      <button class="sm" data-close>关闭</button>
      <button class="sm" data-regen>按此页重跑提示词</button>
      <button class="primary sm" id="pd-save">保存分格</button>
    </div></div>`;
  box.querySelector('#pd-panels').innerHTML = (d.panels || []).map((p, i) => `
    <div class="card" style="padding:12px;margin-bottom:10px" data-i="${i}">
      <div class="row" style="margin-bottom:6px"><b>第${cnNum(p.panel_order)}格</b>
        <span class="pill tag">${esc(p.role || '')} / ${esc(p.shot || '')}</span>
        ${(p.technique || []).length ? `<span class="pill tag">技法 ${esc((p.technique || []).join('、'))}</span>` : ''}</div>
      <div class="grid2">
        <div><label class="fld">动作 / 表情</label><textarea class="pd-action" style="min-height:52px">${esc(p.action || '')}</textarea></div>
        <div><label class="fld">台词</label><textarea class="pd-dialogue" style="min-height:52px">${esc(p.dialogue || '')}</textarea></div>
      </div>
      <div class="grid2" style="margin-top:6px">
        <div><label class="fld">场景</label><input class="pd-scene" value="${esc(p.scene_desc || '')}"></div>
        <div><label class="fld">出场角色（逗号分隔）</label><input class="pd-chars" value="${esc((p.characters || []).join('，'))}"></div>
      </div>
    </div>`).join('');
  document.body.appendChild(box);
  const pickButton = box.querySelector('#pd-pick'), regenButton = box.querySelector('[data-regen]');
  const form = editFeedback.protectDialog({
    box, label: '分格', saveButton: box.querySelector('#pd-save'), closeOnSave: false, extraButtons: [pickButton, regenButton],
    read: () => ({ panels: [...box.querySelectorAll('#pd-panels .card')].map((card, index) => ({
      ...d.panels[index],
      action: card.querySelector('.pd-action').value,
      dialogue: card.querySelector('.pd-dialogue').value,
      scene_desc: card.querySelector('.pd-scene').value,
      characters: card.querySelector('.pd-chars').value.split(/[，,]/).map((value) => value.trim()).filter(Boolean),
    })) }),
    write: async (body) => {
      const result = await api(`/api/projects/${projectId}/pages/${encodeURIComponent(pageRef)}/script`, { method: 'POST', body: JSON.stringify(body) });
      box.querySelector('h3 .mut').textContent = 'v' + result.version;
    },
    afterSave: () => { refreshGates(); if (!$('#tab-pages').classList.contains('hidden')) loadPages(); },
  });
  pickButton.addEventListener('click', async () => {
    if (form.draft.saving || pickButton.disabled) return;
    if (form.draft.dirty() && !(await form.save())) return;
    openTemplatePicker(async (templateId) => {
      if (!confirm('换版式会按新格数重排分格（内容尽力保留），继续？')) return;
      // 选择版式期间也可能继续修改原窗口，先保存这些修改。
      if (form.draft.dirty() && !(await form.save())) return;
      try {
        await form.operation(async () => {
          const result = await api(`/api/projects/${projectId}/pages/${encodeURIComponent(pageRef)}/template`,
            { method: 'POST', body: JSON.stringify({ template_id: templateId }) });
          toast(result.note || '已换版式', 'ok'); form.close(true); openPageDetail(pageRef); refreshGates();
        });
      } catch (error) { toast(error.message, 'err'); }
    }, (d.template || {}).id, '换成哪个版式？');
  });
  regenButton.addEventListener('click', async () => {
    if (form.draft.saving || regenButton.disabled) return;
    if (form.draft.dirty() && !(await form.save())) return;
    regenButton.disabled = true;
    try {
      const result = await api(`/api/projects/${projectId}/run/S3`, { method: 'POST', body: JSON.stringify({ page_ref: pageRef }) });
      toast(`按此页重跑提示词已入队 #${result.job_id}`, 'ok');
    } catch (error) { toast(error.message, 'err'); }
    finally { regenButton.disabled = false; }
  });
}



// ---------- 可视化选模板（缩略图点选）----------
let _tplCache = null;
async function getAllTemplates() {
  if (_tplCache) return _tplCache;
  _tplCache = await api('/api/templates');
  return _tplCache;
}

/**
 * 打开模板选择器：69 个模板以“真实版式缩略图”呈现，点选即可。
 * @param {(id:string)=>void} onPick
 * @param {string} [currentId] 当前模板（高亮）
 * @param {string} [title]
 */
async function openTemplatePicker(onPick, currentId, title, filterFn) {
  let tpls = await getAllTemplates();
  if (typeof filterFn === 'function') tpls = tpls.filter(filterFn);
  const box = document.createElement('div');
  box.className = 'modal';
  const groups = { vertical: [], landscape: [] };
  tpls.forEach((t) => (groups[t.dir] ||= []).push(t));
  const renderGroup = (dirName, list) => `
    <div style="margin-bottom:16px">
      <div class="mut" style="font-size:12.5px;margin-bottom:6px">${dirName === 'vertical' ? '竖版' : '横版'}
        <span class="pill tag">${list.length}</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px">
        ${list.map((t) => `
          <div class="tplcard ${t.id === currentId ? 'sel' : ''}" data-tpl="${esc(t.id)}"
               title="${esc(t.id)} · ${t.panels_count}格 · ${esc(t.layout_desc)}">
            <div class="tplthumb"><img src="/api/templates/${encodeURIComponent(t.id)}/svg" loading="lazy" alt=""></div>
            <div class="tplmeta"><b>${t.panels_count}格</b><span>${esc(t.id.split(':')[1])}</span></div>
          </div>`).join('')}
      </div>
    </div>`;
  box.innerHTML = `<div class="box" style="width:min(1000px,94vw)">
    <h3>${esc(title || '选择版式模板')} <span class="mut" style="font-size:13px;font-weight:400">
      — 缩略图是真实版式；点一下就选中</span></h3>
    <div class="h2sub">格数 = 这一页的镜头数。大格位置（上/下、左/右）决定画面重点怎么放。</div>
    <div style="max-height:64vh;overflow:auto;padding-right:6px">
      ${renderGroup('vertical', groups.vertical || [])}
      ${renderGroup('landscape', groups.landscape || [])}
    </div>
    <div class="row" style="margin-top:12px"><div class="spacer"></div>
      <button class="sm" data-close>取消</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  box.querySelectorAll('[data-tpl]').forEach((el) => el.addEventListener('click', () => {
    box.remove();
    onPick(el.dataset.tpl);
  }));
}

// ---------- 分格工作台（S2）----------
$('#pg-reload').addEventListener('click', loadPages);
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-prompt]');
  if (b) { e.preventDefault(); openPromptEditor(b.dataset.prompt); }
});
$('#pg-add').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  openTemplatePicker(async (tplId) => {
    try {
      const r = await api(`/api/projects/${state.projectId}/pages`, { method: 'POST', body: JSON.stringify({ template_id: tplId }) });
      toast(`已加 ${r.page_ref}（${r.panels_count} 格）`, 'ok');
      loadPages(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  }, null, '新页用哪个版式？');
});

async function loadPages() {
  const projectId = state.projectId;
  if (!state.projectId) { $('#pg-list').innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  try {
    const d = await api(`/api/projects/${projectId}/pages`);
    if (projectId !== state.projectId) return;
    state._tpls = d.templates || [];
    $('#pg-count').textContent = `${d.pages.length} 页`;
    $('#pg-meta').textContent = `已审核正文 ${d.novel_chars} 字 · 目标 ${d.target_pages} 页 · 提示词 ${d.panel_prompt_count} 条`;

    // 正文产物预览（可编辑）：复用 /novel 拿分段，改动走产物编辑接口
    try {
      const nv = await api(`/api/projects/${projectId}/novel`);
      if (projectId !== state.projectId) return;
      renderPagesNovel(nv);
    } catch { /* 预览失败不影响分格主流程 */ }

    const box = $('#pg-list');
    $('#pg-blank').style.display = d.pages.length ? 'none' : 'block';
    if (!d.pages.length) { box.innerHTML = ''; return; }
    box.innerHTML = d.pages.map((p) => `
      <div class="card" style="padding:14px" data-page="${esc(p.page_ref)}">
        <div class="row">
          <div class="tplthumb-sm" title="${esc(p.template_id || '')}">
            ${p.template_id ? `<img src="/api/templates/${encodeURIComponent(p.template_id)}/svg" alt="">` : ''}
          </div>
          <div>
            <div class="row" style="gap:6px"><b>${pageLabel(p.page_ref)}</b> ${pill(p.status)}
              <span class="pill tag">${esc(p.template_id || '?')} · ${p.panels.length} 格</span>
              <span class="pill tag">${p.source === 'ai' ? 'AI 选' : '手动'}</span>
              <span class="mut" style="font-size:12px">v${p.version}</span></div>
            <div class="mut" style="font-size:12px" id="tpl-desc-${esc(p.page_ref)}"></div>
          </div>
          <div class="spacer"></div>
          ${p.status === 'approved' ? '<span class="pill ok"><i class="dotm"></i>已通过</span>'
                                    : `<button class="sm primary" data-ok="${esc(p.page_ref)}">通过</button>`}
          ${p.status === 'rejected' ? '<span class="pill err"><i class="dotm"></i>已驳回</span>'
                                    : `<button class="sm" data-no="${esc(p.page_ref)}">驳回</button>`}
          <button class="sm" data-aigen="${esc(p.page_ref)}">让 AI 选</button>
          <button class="sm" data-edit="${esc(p.page_ref)}">编辑/换模板</button>
          <button class="sm danger" data-del="${esc(p.page_ref)}">删除</button>
        </div>
        <div class="pg-panels" style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
          ${p.panels.map((x) => `<div class="mini-card" style="padding:8px 10px">
            <div class="mut" style="font-size:11.5px">第${cnNum(x.panel_order)}格 · ${esc(x.shot || '')}</div>
            <div style="font-size:12.5px;margin-top:3px">${esc((x.action || '（空）').slice(0, 40))}</div>
            ${x.dialogue ? `<div class="mut" style="font-size:11.5px;margin-top:3px">「${esc(x.dialogue.slice(0, 26))}」</div>` : ''}
            ${(x.technique || []).length ? `<div class="mut" style="font-size:11px;margin-top:3px">技法 ${esc((x.technique || []).join('、'))}</div>` : ''}
          </div>`).join('')}
        </div>
      </div>`).join('');
    // 补齐每页的版式文字描述（如“竖版3格；第1行2格；第2行单格(63%)”）
    for (const p of d.pages) {
      const el = document.getElementById(`tpl-desc-${p.page_ref}`);
      if (!el || !p.template_id) continue;
      const t = (d.templates || []).find((x) => x.id === p.template_id);
      if (t) el.textContent = t.layout_desc || '';
    }
    box.querySelectorAll('[data-aigen]').forEach((b) => b.addEventListener('click', () => aiFillPage(b.dataset.aigen, b)));
    box.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      const art = await api(`/api/projects/${projectId}/pages`).then((d) =>
        (d.pages.find((x) => x.page_ref === b.dataset.ok) || {}).artifact_id);
      if (!art) return toast('找不到该页产物', 'err');
      await api(`/api/artifacts/${art}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
      toast(`${b.dataset.ok} 已通过`, 'ok'); loadPages(); refreshGates();
    }));
    box.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      const comment = prompt('驳回批注（可留空）：') || '';
      const art = await api(`/api/projects/${projectId}/pages`).then((d) =>
        (d.pages.find((x) => x.page_ref === b.dataset.no) || {}).artifact_id);
      if (!art) return toast('找不到该页产物', 'err');
      await api(`/api/artifacts/${art}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
      toast(`${b.dataset.no} 已驳回`, 'ok'); loadPages(); refreshGates();
    }));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openPageDetail(b.dataset.edit)));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`删除 ${b.dataset.del}？`)) return;
      await api(`/api/projects/${projectId}/pages/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      toast('已删除该页', 'ok'); loadPages(); refreshGates();
    }));
  } catch (e) { toast(e.message, 'err'); }
}

/** 「分格分页」页里的正文产物预览：列出作为分格依据的正文分段，可就地编辑。 */
function renderPagesNovel(nv) {
  const box = $('#pg-novel-list');
  if (!box) return;
  const segs = nv.segments || [];
  const c = $('#pg-novel-count');
  if (c) c.textContent = `${nv.approved_count}/${nv.total_count} 段 · ${nv.chars} 字`;
  if (!segs.length) { box.innerHTML = '<div class="empty">还没有正文，请到「正文」页写或粘贴</div>'; return; }
  const modeTag = (m) => m === 'continue' ? '续写' : m === 'raw' ? '直发' : m === 'llm' ? 'LLM' : m === 'paste' ? '粘贴' : '起笔';
  box.innerHTML = segs.map((s) => `
    <div class="seg" style="margin-bottom:8px">
      <div class="segh"><b>第 ${s.index} 段</b> ${pill(s.status)}
        <span class="pill tag">${modeTag(s.mode)}</span>
        <span class="mut" style="font-size:12px">${s.chars} 字</span>
        <div class="spacer"></div>
        <button class="sm" data-pgedit="${s.id}">编辑</button>
      </div>
      <div class="txt" style="max-height:180px;overflow:auto">${esc(s.text)}</div>
    </div>`).join('');
  box.querySelectorAll('[data-pgedit]').forEach((b) => b.addEventListener('click', () => openSegEdit(+b.dataset.pgedit)));
}

async function aiFillPage(pageRef, btn) {
  if (!confirm(`让 AI 为 ${pageRef} 挑模板并写分格？\\n\\n需要：已有已审核通过的正文；会调用一次 LLM。`)) return;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'AI 生成中…'; }
  try {
    const d = await api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(pageRef)}/auto`,
      { method: 'POST', body: JSON.stringify({}) });
    toast(`${pageRef}：AI 选了 ${d.template_id}（${d.panels_count} 格）`, 'ok');
    loadPages(); refreshGates();
  } catch (e) {
    toast('AI 生成失败：' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

// ---------- 提示词（S3 工作台）----------
$('#pr-reload').addEventListener('click', loadPrompts);
$('#pr-addchar').addEventListener('click', () => upsertCharacter({ name: '', trigger_words: '', lora_name: '', lora_weight: 0.8, use_lora: true, prompt_block: '' }));
$('#pr-pull-lora').addEventListener('click', async () => {
  const el = $('#pr-lora-state'); el.textContent = '拉取中…';
  try {
    const r = await api('/api/comfy/assets');
    state._loras = r.loras || [];
    el.textContent = `LoRA ${state._loras.length} 个（角色卡的 LoRA 输入框可下拉联想）`;
    installLoraDatalist(state._loras);
  } catch (e) { el.textContent = '失败：' + e.message; }
});
$('#pr-run-all').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  try {
    const rd = await api(`/api/projects/${state.projectId}/readiness`);
    const info = rd.S3 || {};
    if (!info.ready) return toast('前置未满足：' + info.missing, 'err');
  } catch { /* 交给后端兜底 */ }
  await runStage('S3');
  setTimeout(loadPrompts, 1500);
});
$('#pr-approve-all').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  if (!confirm('把所有“待审查”的分镜提示词一键置为通过？')) return;
  try {
    const r = await api(`/api/projects/${state.projectId}/panel-prompts/approve-all`, { method: 'POST', body: '{}' });
    toast(`已通过 ${r.approved} 条提示词`, 'ok');
    loadPrompts(); refreshGates();
  } catch (e) { toast(e.message, 'err'); }
});

function installLoraDatalist(list) {
  const old = document.getElementById('lora-all'); if (old) old.remove();
  const dl = document.createElement('datalist'); dl.id = 'lora-all';
  dl.innerHTML = (list || []).map((l) => `<option value="${esc(l)}">`).join('');
  document.body.appendChild(dl);
}

// 页面打开时后台拉一次后端 LoRA，填充下拉联想（失败静默）
let _loraDatalistTried = false;
async function ensureLoraDatalist() {
  if (_loraDatalistTried && document.getElementById('lora-all')) return;
  _loraDatalistTried = true;
  try {
    const r = await api('/api/comfy/assets');
    state._loras = r.loras || [];
    installLoraDatalist(state._loras);
  } catch { /* ComfyUI 未启动 */ }
}

// ---- LoRA 即时搜索下拉（输入即过滤，支持路径子串、高亮、键盘上下选）----
let _loraListCache = null;
async function loadLoraList() {
  if (_loraListCache) return _loraListCache;
  try { const r = await api('/api/comfy/assets'); _loraListCache = r.loras || []; }
  catch { _loraListCache = state._loras || []; }
  return _loraListCache;
}
function _hl(text, q) {
  if (!q) return esc(text);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return esc(text).replace(re, '<b>$1</b>');
}
/** 给一个输入框挂上 LoRA 即时搜索：multi=true 表示逗号分隔多个（只搜最后一个 token）。 */
function attachLoraCombo(input, opts = {}) {
  if (!input || input.dataset.loraCombo) return;
  input.dataset.loraCombo = '1';
  const multi = !!opts.multi;
  input.removeAttribute('list');
  const wrap = document.createElement('div');
  wrap.className = 'lora-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  let menu = null, idx = -1, items = [];
  const token = () => multi ? input.value.split(',').slice(-1)[0].trim() : input.value.trim();
  const hide = () => { if (menu) { menu.remove(); menu = null; } idx = -1; items = []; };
  const render = () => {
    if (!items.length) { hide(); return; }
    if (!menu) { menu = document.createElement('div'); menu.className = 'lora-menu'; wrap.appendChild(menu); }
    const q = token();
    menu.innerHTML = items.map((l, i) => `<div class="it ${i === idx ? 'on' : ''}" data-i="${i}">${_hl(l, q)}</div>`).join('');
    menu.querySelectorAll('.it').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(+el.dataset.i); }));
  };
  const query = async () => {
    const list = await loadLoraList();
    const q = token().toLowerCase();
    items = (q ? list.filter((l) => l.toLowerCase().includes(q)) : list).slice(0, 80);
    idx = -1;
    render();
  };
  const pick = (i) => {
    if (i < 0 || i >= items.length) return;
    const val = items[i];
    if (multi) {
      const parts = input.value.split(',');
      parts[parts.length - 1] = ' ' + val;
      input.value = parts.join(',').replace(/^\s+/, '');
    } else { input.value = val; }
    hide();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  input.addEventListener('input', query);
  input.addEventListener('focus', query);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!menu) { query(); return; }
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      if (menu) { e.preventDefault(); pick(idx >= 0 ? idx : 0); }
    } else if (e.key === 'Escape') { hide(); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 180));
}
/** 便捷：给某容器内所有匹配选择器的 LoRA 输入框挂上即时搜索 */
function attachLoraCombos(root, selector, opts) {
  (root || document).querySelectorAll(selector).forEach((el) => attachLoraCombo(el, opts));
}

// ---- 角色卡 + 提示词预设渲染 ----
async function loadCharacterPresetPanel() {
  const projectId = state.projectId;
  const box = $('#pr-chars');
  const request = ++assetCardsRequest;
  if (!(await editFeedback.flush('asset-cards')) || projectId !== state.projectId || request !== assetCardsRequest) return false;
  let chars = [], presets = { positive: [], negative: [] };
  try {
    [chars, presets] = await Promise.all([
      projectId ? api(`/api/projects/${projectId}/characters`) : Promise.resolve([]),
      api('/api/prompt-presets' + (projectId ? `?project_id=${projectId}` : '')),
    ]);
  } catch (e) {
    if (request === assetCardsRequest && projectId === state.projectId) {
      toast('资产加载失败：' + e.message, 'err');
      if (!box.querySelector('[data-char], [data-preset]')) box.innerHTML = '<div class="empty">资产加载失败，点击「刷新资产」重试。</div>';
    }
    return false;
  }

  if (projectId !== state.projectId || request !== assetCardsRequest) return false;
  if (editFeedback.unsettled('asset-cards')) { toast('资产有新修改，已保留当前内容；保存后再刷新。'); return false; }
  editFeedback.clear('asset-cards');
  const presetCard = (kind, list) => `
    <div style="flex:1;min-width:280px">
      <div class="row" style="gap:6px"><b style="font-size:13px">${kind === 'positive' ? '正向预设' : '负向预设'}</b>
        <span class="mut" style="font-size:11.5px">（${kind === 'positive' ? '正向基础提示词：AI 以它为骨架再补每格内容' : '负向基础提示词：AI 以它为基础' }）</span>
        <div class="spacer"></div>
        <button class="sm" data-addpreset="${kind}">＋ 加</button></div>
      ${(list || []).map((p) => `
        <div class="mini-card" style="padding:8px 10px;margin-top:6px" data-preset="${p.id}" data-preset-kind="${kind}" data-preset-scope="${esc(p.scope)}" data-preset-project="${p.project_id || ''}">
          <div class="row" style="gap:6px">
            <input class="pres-name" value="${esc(p.name)}" placeholder="预设名称（随便起）" style="width:150px">
            <label class="mut" style="font-size:11.5px"><input type="checkbox" class="pres-def" ${p.is_default ? 'checked' : ''} style="width:auto"> 默认</label>
            <span class="pill tag">${p.scope === 'project' ? '本项目' : '全局'}</span>
            <div class="spacer"></div>
            <button class="sm pres-save">保存</button>
            <button class="sm danger pres-del">删</button>
          </div>
          <textarea class="pres-text" style="margin-top:6px;min-height:60px;font-size:12px;resize:vertical">${esc(p.text)}</textarea>
          <div class="mut" style="font-size:11px;margin-top:5px">可选：这个预设要挂的 LoRA（生成提示词时合入每格，出图直接套用）</div>
          <input class="pres-loras" list="lora-all" value="${esc(presetLoraStr(p.loras))}"
                 placeholder="多个用逗号分隔，如 画风/A.safetensors:0.8, 效果/B.safetensors:1" style="width:100%;margin-top:3px;font-size:11.5px">
        </div>`).join('') || '<div class="mut" style="font-size:12px;margin-top:6px">还没有预设</div>'}
    </div>`;

  box.innerHTML = `
    <div data-asset-part="presets"><div class="row" style="margin-bottom:10px"><label class="fld" for="asset-preset-scope" style="margin:0">新增预设作用域</label>
      <select id="asset-preset-scope" style="width:160px"><option value="project" ${!projectId ? 'disabled' : 'selected'}>本项目</option><option value="global" ${!projectId ? 'selected' : ''}>全局</option></select></div>
    <div class="row" style="align-items:flex-start;gap:16px">
      ${presetCard('positive', presets.positive)}
      ${presetCard('negative', presets.negative)}
    </div>
    </div><div data-asset-part="characters">
    <b style="font-size:13px">角色（触发词 ↔ 角色 LoRA）</b>
    <div class="mut" style="font-size:12px;margin-top:2px">角色出场时，<b>触发词一定会被写进正向提示词</b>；外观词按画面裁剪（特写看不到的、远景看不清的会被去掉）。</div>
    ${chars.map((c) => `
      <div class="mini-card" style="padding:10px 12px;margin-top:8px" data-char="${c.id}">
        <div class="row" style="gap:8px">
          <input class="ch-name" value="${esc(c.name)}" placeholder="角色名（要和分格里一致）" style="width:160px">
          <input class="ch-trig" value="${esc(c.trigger_words || '')}" placeholder="触发词（角色出场必写），如 trig1, trig2" style="flex:1;min-width:180px">
          <label class="mut" style="font-size:11.5px"><input type="checkbox" class="ch-uselora" ${c.use_lora ? 'checked' : ''} style="width:auto"> 用 LoRA</label>
          <div class="spacer"></div>
          <button class="sm primary ch-save">保存</button>
          <button class="sm danger ch-del">删</button>
        </div>
        <div class="row" style="gap:8px;margin-top:6px">
          <input class="ch-lora" list="lora-all" value="${esc(c.lora_name || '')}" placeholder="角色 LoRA 文件名（可留空=纯提示词）" style="flex:1;min-width:240px">
          <label class="fld" style="margin:0">权重</label>
          <input class="ch-w" type="number" step="0.05" value="${c.lora_weight ?? 0.8}" style="width:80px">
        </div>
        <label class="fld" style="margin:8px 0 3px">外观词块（不依赖 LoRA 时用；可按画面保留/裁剪）</label>
        <textarea class="ch-block" rows="4" placeholder="如 silver hair, mechanical arms, glowing blue eyes, android girl, ..."
          style="width:100%;min-height:88px;resize:vertical;font-size:12px">${esc(c.prompt_block || '')}</textarea>
      </div>`).join('') || '<div class="mut" style="font-size:12px;margin-top:8px">还没有角色。点右上「＋ 加角色」。</div>'}</div>`;

  attachLoraCombos(box, '.ch-lora');
  attachLoraCombos(box, '.pres-loras', { multi: true });

  box.querySelectorAll('[data-preset]').forEach((el) => {
    const id = +el.dataset.preset;
    const editor = editFeedback.track({
      element: el, group: 'asset-cards', label: '预设', auto: true,
      saveButton: el.querySelector('.pres-save'),
      read: () => ({ id, name: el.querySelector('.pres-name').value, text: el.querySelector('.pres-text').value,
        is_default: el.querySelector('.pres-def').checked, loras: parseLoraStr(el.querySelector('.pres-loras').value) }),
      write: (body) => api('/api/prompt-presets', { method: 'POST', body: JSON.stringify(body) }),
      onSaved: (body) => {
        if (!body.is_default || !el.isConnected) return;
        box.querySelectorAll('[data-preset]').forEach((other) => {
          const otherEditor = assetEditors.get(other);
          if (other === el || otherEditor?.dirty() || otherEditor?.saving) return;
          if (other.dataset.presetKind === el.dataset.presetKind && other.dataset.presetScope === el.dataset.presetScope
            && other.dataset.presetProject === el.dataset.presetProject) {
            other.querySelector('.pres-def').checked = false; otherEditor?.accept();
          }
        });
      },
    });
    assetEditors.set(el, editor);
    el.querySelector('.pres-del').addEventListener('click', () => deleteAssetCard(el, editor, `/api/prompt-presets/${id}`, '预设'));
  });
  box.querySelectorAll('[data-addpreset]').forEach((button) => button.addEventListener('click', async () => {
    if (button.disabled || assetMutationInFlight) return;
    assetMutationInFlight = true;
    button.disabled = true;
    try {
      if (!(await editFeedback.flush('asset-cards')) || projectId !== state.projectId) return;
      const scope = $('#asset-preset-scope').value;
      const preset = await api('/api/prompt-presets', { method: 'POST', body: JSON.stringify({
        kind: button.dataset.addpreset, name: '', scope, project_id: scope === 'project' ? projectId : null,
        text: '', is_default: false }) });
      if (projectId !== state.projectId) return;
      toast('预设已新建，停止输入后自动保存', 'ok');
      await loadCharacterPresetPanel();
      box.querySelector(`[data-preset="${preset.id}"] .pres-name`)?.focus();
    } catch (e) { toast(e.message, 'err'); }
    finally { assetMutationInFlight = false; button.disabled = false; }
  }));

  box.querySelectorAll('[data-char]').forEach((el) => {
    const id = +el.dataset.char;
    const editor = editFeedback.track({
      element: el, group: 'asset-cards', label: '角色', auto: true,
      saveButton: el.querySelector('.ch-save'),
      read: () => ({ id, name: el.querySelector('.ch-name').value, trigger_words: el.querySelector('.ch-trig').value,
        lora_name: el.querySelector('.ch-lora').value, lora_weight: el.querySelector('.ch-w').value === '' ? 0.8 : Number(el.querySelector('.ch-w').value),
        use_lora: el.querySelector('.ch-uselora').checked, prompt_block: el.querySelector('.ch-block').value }),
      write: (body) => api(`/api/projects/${projectId}/characters`, { method: 'POST', body: JSON.stringify(body) }),
    });
    assetEditors.set(el, editor);
    el.querySelector('.ch-del').addEventListener('click', () => deleteAssetCard(el, editor, `/api/characters/${id}`, '角色'));
  });
  document.dispatchEvent(new Event('comic-assets:rendered'));
  return true;
}

async function deleteAssetCard(element, editor, path, label) {
  if (assetMutationInFlight) { toast('资产正在更新，请稍候。'); return; }
  if (!confirm('删除这个' + label + '？')) return;
  assetMutationInFlight = true;
  const controls = Array.from(element.querySelectorAll('input, textarea, button'));
  const disabled = controls.map((control) => control.disabled);
  editor.lock(true);
  controls.forEach((control) => { control.disabled = true; });
  const projectId = state.projectId;
  try {
    if (!(await editFeedback.flush('asset-cards')) || projectId !== state.projectId) return;
    await api(path, { method: 'DELETE' });
    editor.dispose(); element.remove(); toast(label + '已删除', 'ok');
  } catch (error) { toast('删除失败：' + error.message, 'err'); }
  finally {
    assetMutationInFlight = false;
    controls.forEach((control, index) => { control.disabled = disabled[index]; }); editor.lock(false);
  }
}

// 防抖：连续输入只在停下后触发一次
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function flashSaved(el) {
  if (!el) return;
  const old = el.style.boxShadow;
  el.style.boxShadow = '0 0 0 2px var(--okbg)';
  setTimeout(() => { el.style.boxShadow = old; }, 500);
}
// 阿拉伯数字 → 中文（1..99），用于「第一格」
const _CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnNum(n) {
  n = +n;
  if (!n || n < 0) return String(n);
  if (n <= 10) return _CN[n];
  if (n < 20) return '十' + (n > 10 ? _CN[n - 10] : '');
  if (n < 100) return _CN[Math.floor(n / 10)] + '十' + (n % 10 ? _CN[n % 10] : '');
  return String(n);
}
// page:1 → 第一页；panel:1.1 → 第一格（只用于显示，内部 ref 不变）
function pageLabel(ref) { const m = String(ref).match(/page:(\d+)/); return m ? `第${cnNum(+m[1])}页` : String(ref); }
function panelLabel(ref) { const m = String(ref).match(/panel:\d+\.(\d+)/); return m ? `第${cnNum(+m[1])}格` : String(ref); }
// 任意 ref → 友好标签
function refLabel(ref) { const s = String(ref); return s.startsWith('panel:') ? panelLabel(s) : s.startsWith('page:') ? pageLabel(s) : s; }
// panel:1.1 → 第一页第一格
function panelFullLabel(ref) {
  const m = String(ref).match(/panel:(\d+)\.(\d+)/);
  return m ? `第${cnNum(+m[1])}页第${cnNum(+m[2])}格` : String(ref);
}

// LoRA 文本 ⇄ 数组：文本形如 "画风/A.safetensors:0.8, 效果/B.safetensors"
function parseLoraStr(s) {
  return String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.lastIndexOf(':');
    if (i > 0 && !isNaN(Number(x.slice(i + 1)))) {
      return { name: x.slice(0, i).trim(), weight: Number(x.slice(i + 1)) };
    }
    return { name: x, weight: 0.8 };
  });
}
function presetLoraStr(loras) {
  return (loras || []).map((l) => `${l.name}:${l.weight ?? 0.8}`).join(', ');
}

async function upsertCharacter(data) {
  if (!state.projectId) return toast('先选择项目', 'err');
  const projectId = state.projectId;
  const button = $('#pr-addchar'); if (button.disabled || assetMutationInFlight) return;
  assetMutationInFlight = true;
  button.disabled = true;
  try {
    if (!(await editFeedback.flush('asset-cards')) || projectId !== state.projectId) return;
    const character = await api(`/api/projects/${projectId}/characters`, { method: 'POST', body: JSON.stringify(data) });
    if (projectId !== state.projectId) return;
    await loadCharacterPresetPanel();
    $('#pr-chars').querySelector(`[data-char="${character.id}"] .ch-name`)?.focus();
  } catch (e) { toast(e.message, 'err'); }
  finally { assetMutationInFlight = false; button.disabled = !state.projectId; }
}

// ---- 项目画风 LoRA（项目级，合入该项目每一格，生成提示词与出图都带上）----
function styleLoraRow(l) {
  return `<div class="row" style="gap:6px;margin-top:5px" data-stylerow>
    <input class="st-name" list="lora-all" value="${esc((l && (l.name || l.lora_name)) || '')}" placeholder="画风 lora 文件名" style="flex:1;min-width:240px">
    <input class="st-w" type="number" step="0.05" value="${(l && (l.weight ?? 1)) ?? 1}" style="width:82px">
    <button class="sm danger st-del" type="button">删</button>
  </div>`;
}
async function loadStyleLoras({ discard = false } = {}) {
  const projectId = state.projectId;
  const box = $('#pr-style');
  if (!box) return false;
  if (!projectId) {
    editFeedback.clear('asset-style'); styleEditor = null; $('#pr-style-status').textContent = '';
    box.innerHTML = '<div class="empty">先选择项目</div>'; return true;
  }
  if (!discard && editFeedback.unsettled('asset-style')) return false;
  const request = ++styleRequest;
  const previous = editFeedback.snapshot('asset-style');
  let rows;
  try {
    const data = await api(`/api/projects/${projectId}/loras`);
    rows = (data.project || data.rows || []).filter((row) => (row.scope || 'project') === 'project');
  } catch (error) {
    if (request === styleRequest && projectId === state.projectId) {
      toast('画风加载失败：' + error.message, 'err');
      if (!styleEditor) box.innerHTML = '<div class="empty">画风加载失败，点击「刷新资产」重试。</div>';
    }
    return false;
  }
  if (projectId !== state.projectId || request !== styleRequest) return false;
  if (previous !== editFeedback.snapshot('asset-style') || styleEditor?.saving) {
    toast('画风有新修改，已保留当前内容；保存后再刷新。'); return false;
  }
  editFeedback.clear('asset-style');
  box.innerHTML = rows.length ? rows.map(styleLoraRow).join('') : '<div class="mut" style="font-size:12px">还没配画风 LoRA</div>';
  // 保存按钮在列表外，绑定一次，后续载入只更新当前控制器。
  styleEditor = editFeedback.track({
    element: box, group: 'asset-style', label: '项目画风', status: $('#pr-style-status'),
    read: () => ({ scope: 'project', loras: Array.from(box.querySelectorAll('[data-stylerow]')).map((row) => ({
      name: row.querySelector('.st-name').value.trim(),
      weight: row.querySelector('.st-w').value === '' ? 1 : Number(row.querySelector('.st-w').value),
    })).filter((lora) => lora.name) }),
    write: (body) => api(`/api/projects/${projectId}/loras`, { method: 'PUT', body: JSON.stringify(body) }),
  });
  bindStyle(); document.dispatchEvent(new Event('comic-assets:rendered')); return true;
}
function bindStyle() {
  const box = $('#pr-style');
  box.querySelectorAll('.st-del').forEach((button) => button.onclick = () => {
    button.closest('[data-stylerow]').remove(); styleEditor?.changed();
  });
  attachLoraCombos(box, '.st-name');
}
$('#pr-addstyle').addEventListener('click', () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  if (!styleEditor) return toast('画风还未加载，请先刷新资产。', 'err');
  const box = $('#pr-style');
  if (box.querySelector('.mut') && !box.querySelector('[data-stylerow]')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', styleLoraRow({}));
  bindStyle(); styleEditor.changed(); box.querySelector('[data-stylerow]:last-child .st-name')?.focus();
});
$('#pr-style-save').addEventListener('click', async () => {
  const editor = styleEditor;
  if (!state.projectId) return toast('先选择项目', 'err');
  if (!editor) return toast('画风还未加载，请先刷新资产。', 'err');
  const button = $('#pr-style-save'); if (button.disabled || editor.saving) return;
  button.disabled = true; button.textContent = '保存中…';
  try { if (await editor.flush()) toast('项目画风已保存（下次生成提示词时带上）', 'ok'); }
  finally { button.disabled = !state.projectId; button.textContent = '保存'; }
});

async function loadPrompts() {
  const projectId = state.projectId;
  if (!state.projectId) {
    $('#pr-list').innerHTML = '';
    $('#pr-blank').style.display = 'block';
    $('#pr-count').textContent = '—';
    $('#pr-meta').textContent = '请先选择项目';
    return;
  }
  try {
    const d = await api(`/api/projects/${projectId}/prompt-board`);
    if (projectId !== state.projectId) return;
    $('#pr-count').textContent = `${d.pages.length} 页`;
    $('#pr-meta').textContent = `提示词 ${d.panel_done}/${d.panel_total} 格${d.has_llm_provider ? '' : ' · ⚠ 还没配 LLM 供应商'}`;
    const box = $('#pr-list');
    $('#pr-blank').style.display = d.pages.length ? 'none' : 'block';
    if (!d.pages.length) { box.innerHTML = ''; return; }

    box.innerHTML = d.pages.map((pg) => `
      <div class="card" style="padding:14px" data-prpage="${esc(pg.page_ref)}">
        <div class="row" style="gap:8px">
          <div class="tplthumb-sm" title="${esc(pg.template_id || '')}">
            ${pg.template_id ? `<img src="/api/templates/${encodeURIComponent(pg.template_id)}/svg" alt="">` : ''}
          </div>
          <div>
            <div class="row" style="gap:6px"><b>${pageLabel(pg.page_ref)}</b> ${pill(pg.status)}
              <span class="pill tag">${pg.panels.length} 格</span>
              <span class="pill tag">${pg.panels.filter((p) => p.prompt).length}/${pg.panels.length} 已生成</span></div>
            <div class="mut" style="font-size:11.5px">${esc(pg.template ? (pg.template.layout_desc || pg.template_id) : (pg.template_id || ''))}</div>
          </div>
          <div class="spacer"></div>
          <button class="sm" data-prpreview="${esc(pg.page_ref)}">预览整页</button>
          <button class="sm" data-prrun="${esc(pg.page_ref)}">生成这页</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;margin-top:10px">
          ${pg.panels.map((p) => `
            <div class="mini-card" style="padding:9px 11px">
              <div class="row" style="gap:6px">
                <b style="font-size:12px">第${cnNum(p.panel_order)}格</b>
                <span class="mut" style="font-size:11px">${esc(p.shot || '')}</span>
                ${p.prompt ? pill(p.prompt.status) : '<span class="pill">未生成</span>'}
                <div class="spacer"></div>
                ${p.prompt ? `<button class="sm" data-prview="${esc(p.panel_ref)}">预览</button>
                  <button class="sm" data-predit="${esc(p.panel_ref)}">改</button>
                  ${p.prompt.status === 'approved' ? '' : `<button class="sm primary" data-prapprove="${esc(p.panel_ref)}" data-aid="${p.prompt.artifact_id}">通过</button>`}
                  ${p.prompt.status === 'rejected' ? '' : `<button class="sm" data-prreject="${esc(p.panel_ref)}" data-aid="${p.prompt.artifact_id}">驳回</button>`}` : ''}
              </div>
              <div class="mut" style="font-size:11px;margin-top:3px">${esc((p.action || p.dialogue || '').slice(0, 60))}</div>
              ${p.prompt ? `<div style="font-size:11.5px;margin-top:5px;line-height:1.45">${esc((p.prompt.prompt_pos || '').slice(0, 200))}</div>
                ${p.prompt.prompt_neg ? `<div class="mut" style="font-size:11px;margin-top:3px">负向：${esc(p.prompt.prompt_neg.slice(0, 90))}</div>` : ''}
                <div class="mut" style="font-size:11px;margin-top:3px">${p.prompt.width || '?'}×${p.prompt.height || '?'}${p.prompt.frame ? ' · ' + esc(p.prompt.frame) : ''}${(p.prompt.loras || []).length ? ' · LoRA ' + esc(p.prompt.loras.map((l) => l.name).join('、')) : ''}</div>`
                : '<div class="mut" style="font-size:11.5px;margin-top:5px">点右上角「生成这页」或顶部「整册生成」</div>'}
            </div>`).join('')}
        </div>
      </div>`).join('');

    box.querySelectorAll('[data-prrun]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '生成中…';
      try {
        await api(`/api/projects/${projectId}/prompt-board/run-page/${encodeURIComponent(b.dataset.prrun)}`, { method: 'POST', body: '{}' });
        toast(`${b.dataset.prrun} 已入队生成`, 'ok');
        setTimeout(loadPrompts, 2500);
      } catch (e) { toast(e.message, 'err'); }
      finally { b.disabled = false; b.textContent = '生成这页'; }
    }));
    box.querySelectorAll('[data-predit]').forEach((b) => b.addEventListener('click', () => openPanelPromptEdit(b.dataset.predit)));
    box.querySelectorAll('[data-prview]').forEach((b) => b.addEventListener('click', () => openPanelPromptPreview([b.dataset.prview])));
    box.querySelectorAll('[data-prapprove]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/artifacts/${b.dataset.aid}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
        toast(`${b.dataset.prapprove} 已通过`, 'ok'); loadPrompts(); refreshGates();
      } catch (e) { toast(e.message, 'err'); }
    }));
    box.querySelectorAll('[data-prreject]').forEach((b) => b.addEventListener('click', async () => {
      const comment = prompt('驳回批注（可留空）：') || '';
      try {
        await api(`/api/artifacts/${b.dataset.aid}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
        toast(`${b.dataset.prreject} 已驳回`, 'ok'); loadPrompts(); refreshGates();
      } catch (e) { toast(e.message, 'err'); }
    }));
    box.querySelectorAll('[data-prpreview]').forEach((b) => b.addEventListener('click', () => {
      const pg = d.pages.find((x) => x.page_ref === b.dataset.prpreview);
      openPanelPromptPreview((pg ? pg.panels : []).filter((p) => p.prompt).map((p) => p.panel_ref), b.dataset.prpreview);
    }));
  } catch (e) { toast(e.message, 'err'); }
}

/** 提示词完整预览（审查用）：一页/一格的全部正向、负向、LoRA、尺寸。 */
async function openPanelPromptPreview(panelRefs, title) {
  if (!panelRefs || !panelRefs.length) return toast('该页还没有已生成的提示词', 'err');
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(1000px,95vw)">
    <h3>提示词预览 <span class="mut" style="font-size:12px;font-weight:400">${esc(title || (panelRefs.length + ' 格'))}</span></h3>
    <div class="h2sub">逐格审查完整提示词；要改点下面的「改这格」。</div>
    <div id="ppv-body"><div class="empty">加载中…</div></div>
    <div class="row" style="margin-top:14px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  const rows = [];
  for (const ref of panelRefs) {
    try {
      const list = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt&ref_prefix=${encodeURIComponent(ref)}`);
      if (list.length) rows.push(await api('/api/artifacts/' + list[0].id));
    } catch { /* 跳过 */ }
  }
  if (!rows.length) { box.querySelector('#ppv-body').innerHTML = '<div class="empty">没有可预览的提示词产物</div>'; return; }
  box.querySelector('#ppv-body').innerHTML = rows.map((a) => {
    const pl = a.payload || {};
    const loras = (pl.loras || []).map((l) => `${esc(l.name)}（${l.weight}）`).join('<br>') || '<span class="mut">无</span>';
    return `<div class="mini-card" style="padding:12px 14px;margin-top:10px">
      <div class="row" style="gap:6px"><b>${panelLabel(a.ref)}</b> ${pill(a.status)}
        <span class="pill tag">${pl.width || '?'}×${pl.height || '?'}${pl.frame ? ' · ' + esc(pl.frame) : ''}</span>
        <div class="spacer"></div>
        <button class="sm" data-ppv-edit="${esc(a.ref)}">改这格</button></div>
      <div style="margin-top:8px"><label class="fld">正向</label>
        <div class="ppv-text">${esc(pl.prompt_pos || '（空）')}</div></div>
      <div style="margin-top:8px"><label class="fld">负向</label>
        <div class="ppv-text">${esc(pl.prompt_neg || '（空）')}</div></div>
      <div style="margin-top:8px"><label class="fld">LoRA</label>
        <div class="mut" style="font-size:12px">${loras}</div></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-ppv-edit]').forEach((b) => b.addEventListener('click', () => {
    box.remove(); openPanelPromptEdit(b.dataset.ppvEdit);
  }));
}


async function openPanelPromptEdit(panelRef) {
  if (!(await editFeedback.flush('image-editor'))) return;
  const projectId = state.projectId;
  if (!projectId) return;
  let art;
  try { art = await api(`/api/projects/${projectId}/artifacts?kind=panel_prompt&ref_prefix=${encodeURIComponent(panelRef)}`); }
  catch (e) { return toast(e.message, 'err'); }
  if (!art.length) return toast('找不到该格提示词（先「准备」或生成）', 'err');
  let full;
  try { full = await api('/api/artifacts/' + art[0].id); } catch (error) { return toast(error.message, 'err'); }
  const pl = full.payload || {};
  await ensureLoraDatalist();

  if (projectId !== state.projectId) return;
  const loraRow = (l) => `
    <div class="row" style="gap:6px;margin-top:5px" data-lorarow>
      <input class="pp-loraname" list="lora-all" value="${esc((l && l.name) || '')}" placeholder="lora 文件名" style="flex:1;min-width:200px">
      <input class="pp-loraw" type="number" step="0.05" value="${(l && l.weight) ?? 0.8}" style="width:82px">
      <button class="sm danger pp-loradel" type="button">删</button>
    </div>`;
  const loraHtml = (pl.loras || []).map(loraRow).join('');

  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(820px,95vw)">
    <h3>${panelLabel(panelRef)} · 分格详情 / 编辑</h3>
    <div class="h2sub">这一格出图会用到的提示词、尺寸、LoRA 都在这。保存会写新版本，该格出图需重跑。</div>

    <div class="row" style="gap:10px;margin-bottom:8px">
      <div><label class="fld">宽 width</label><input id="pp-w" type="number" value="${pl.width ?? ''}" placeholder="如 1216" style="width:110px"></div>
      <div><label class="fld">高 height</label><input id="pp-h" type="number" value="${pl.height ?? ''}" placeholder="如 896" style="width:110px"></div>
      <div><label class="fld">画框</label><input id="pp-frame" value="${esc(pl.frame || '')}" readonly style="width:110px;background:#f2f4f7"></div>
      <div><label class="fld">种子 seed（空=随机）</label><input id="pp-seed" type="number" value="${pl.seed ?? ''}" style="width:120px"></div>
    </div>
    <div class="row" style="gap:10px;margin-bottom:8px">
      ${(() => { const p = pl.params || {}; return `
        <div><label class="fld">步数 steps</label><input id="pp-steps" type="number" value="${p.steps ?? ''}" style="width:92px"></div>
        <div><label class="fld">CFG</label><input id="pp-cfg" type="number" step="0.5" value="${p.cfg ?? ''}" style="width:80px"></div>
        <div><label class="fld">采样器 sampler</label><input id="pp-sampler" value="${esc(p.sampler || '')}" style="width:120px"></div>
        <div><label class="fld">scheduler</label><input id="pp-sched" value="${esc(p.scheduler || '')}" style="width:120px"></div>
        <div><label class="fld">denoise</label><input id="pp-denoise" type="number" step="0.05" value="${p.denoise ?? ''}" style="width:90px"></div>
      `; })()}
    </div>

    <div><label class="fld">正向</label><textarea id="pp-pos" style="min-height:120px">${esc(pl.prompt_pos || '')}</textarea></div>
    <div style="margin-top:8px"><label class="fld">负向</label><textarea id="pp-neg" style="min-height:70px">${esc(pl.prompt_neg || '')}</textarea></div>

    <div style="margin-top:10px"><label class="fld">LoRA（出图直接套用）</label>
      <div id="pp-loras">${loraHtml || '<div class="mut" style="font-size:12px">（无）</div>'}</div>
      <button class="sm" type="button" id="pp-addlora" style="margin-top:6px">＋ 加一条 LoRA</button></div>

    <div class="row" style="margin-top:14px"><div class="spacer"></div>
      <button class="sm" data-close>取消</button>
      <button class="primary sm" id="pp-savep">保存</button></div></div>`;
  document.body.appendChild(box);
  const num = (selector) => { const value = box.querySelector(selector).value.trim(); return value === '' ? null : Number(value); };
  const txt = (selector) => box.querySelector(selector).value.trim() || null;
  const form = editFeedback.protectDialog({
    box, label: '逐格提示词', saveButton: box.querySelector('#pp-savep'),
    read: () => {
      const params = {};
      for (const [name, selector] of [['steps', '#pp-steps'], ['cfg', '#pp-cfg'], ['denoise', '#pp-denoise']]) {
        const value = num(selector); if (value != null) params[name] = value;
      }
      if (txt('#pp-sampler')) params.sampler = txt('#pp-sampler');
      if (txt('#pp-sched')) params.scheduler = txt('#pp-sched');
      return { prompt_pos: box.querySelector('#pp-pos').value, prompt_neg: box.querySelector('#pp-neg').value,
        width: num('#pp-w'), height: num('#pp-h'), seed: num('#pp-seed'), params,
        loras: [...box.querySelectorAll('[data-lorarow]')].map((row) => ({
          name: row.querySelector('.pp-loraname').value.trim(),
          weight: row.querySelector('.pp-loraw').value === '' ? 0.8 : Number(row.querySelector('.pp-loraw').value),
        })).filter((lora) => lora.name),
      };
    },
    write: (body) => api(`/api/projects/${projectId}/panel-prompt/${encodeURIComponent(panelRef)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    afterSave: () => {
      const tab = document.querySelector('.nav button.active')?.dataset.tab;
      if (tab === 'images') imageWorkbench.load({ force: true }); else loadPrompts(); refreshGates();
    },
  });
  const rebindDel = () => box.querySelectorAll('.pp-loradel').forEach((button) => button.onclick = () => {
    button.closest('[data-lorarow]').remove(); form.draft.changed();
  });
  rebindDel(); attachLoraCombos(box, '.pp-loraname');
  box.querySelector('#pp-addlora').addEventListener('click', () => {
    const wrap = box.querySelector('#pp-loras');
    if (wrap.querySelector('.mut')) wrap.innerHTML = '';
    wrap.insertAdjacentHTML('beforeend', loraRow({})); rebindDel(); attachLoraCombos(wrap, '.pp-loraname'); form.draft.changed();
  });
}

// ---------- 流水线 ----------
function renderFlow() { return pipelineOverview.load(); }
function runStage(stage) { return pipelineOverview.submit(stage); }

// 阶段 -> 提示词名（只有走 LLM 的阶段才有）
const PROMPT_OF_STAGE = { S2: 's2_script', S3: 's3_prompt' };

// ---------- 提示词编辑器（前端可改可存，存数据库，重启不丢）----------
async function openPromptEditor(name) {
  let list;
  try { list = await api('/api/prompts'); } catch (e) { return toast(e.message, 'err'); }
  const item = list.find((x) => x.name === name);
  if (!item) return toast('找不到该提示词', 'err');

  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(1040px,95vw)">
    <h3>${esc(item.label)} · 提示词
      ${item.overridden ? '<span class="pill warn"><i class="dotm"></i>已自定义</span>'
                        : '<span class="pill tag">默认</span>'}</h3>
    <div class="h2sub">这里的改动会立即用于该阶段后续的 LLM 调用，并保存在数据库（重启不丢）。
      可随时点「还原默认」恢复仓库里的原始版本。</div>
    <div style="margin-bottom:10px"><label class="fld">系统提示词（角色/规则/输出格式约束）</label>
      <textarea id="pp-sys" style="min-height:240px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${esc(item.system_text)}</textarea></div>
    <div><label class="fld">用户提示词模板（用 {{KEY}} 占位，如 {{NOVEL}} / {{TEMPLATE_MENU}} / {{TECHNIQUES}}）</label>
      <textarea id="pp-user" style="min-height:180px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${esc(item.user_text)}</textarea></div>
    <div class="row" style="margin-top:12px">
      <span class="mut" style="font-size:12px" id="pp-hint">可用占位：${
        name === 's2_script' ? 'NOVEL / START_PAGE / END_PAGE / TOTAL_PAGES / TEMPLATE_MENU / TECHNIQUES'
        : name === 's1_prose' ? 'TITLE / OUTLINE / INSTRUCTION / CONTEXT_TAIL'
                             : 'PAGE_SCRIPT_JSON / CHARACTERS_JSON / TECHNIQUES_JSON / PANEL_GEOMETRY_JSON'}</span>
      <div class="spacer"></div>
      <button class="sm" data-close>取消</button>
      <button class="sm danger" id="pp-reset">还原默认</button>
      <button class="primary sm" id="pp-save">保存</button>
    </div></div>`;
  document.body.appendChild(box);
  const status = document.createElement('div'); status.className = 'save-feedback';
  box.querySelector('.box').appendChild(status);
  let resetting = false;
  const draft = editFeedback.track({
    element: box, group: 'template-dialog', label: '提示词模板', status,
    busyCheck: () => resetting,
    read: () => ({ system_text: box.querySelector('#pp-sys').value, user_text: box.querySelector('#pp-user').value }),
    write: (body) => api(`/api/prompts/${name}`, { method: 'PUT', body: JSON.stringify(body) }),
  });
  const close = (force = false) => {
    if (!force && (draft.saving || resetting)) { toast('正在保存，请稍候。'); return; }
    if (!force && draft.dirty() && !confirm('提示词模板有未保存的修改，关闭会放弃这些修改，确定继续吗？')) return;
    draft.dispose(); box.remove();
  };
  box.querySelector('[data-close]').addEventListener('click', () => close());
  box.addEventListener('click', (event) => { if (event.target === box) close(); });
  const saveButton = box.querySelector('#pp-save'), resetButton = box.querySelector('#pp-reset');
  saveButton.addEventListener('click', async () => {
    if (draft.saving || resetting) return;
    saveButton.disabled = true; resetButton.disabled = true; saveButton.textContent = '保存中…';
    try {
      if (!(await draft.flush())) return;
      toast('提示词已保存（后续调用立即生效）', 'ok'); close(true); configuration.refreshTemplates();
    } finally { saveButton.disabled = false; resetButton.disabled = false; saveButton.textContent = '保存'; }
  });
  resetButton.addEventListener('click', async () => {
    if (draft.saving || resetting) return;
    if (resetButton.dataset.armed !== '1') {
      resetButton.dataset.armed = '1'; resetButton.textContent = '再点一次确认还原';
      toast('再点一次将删除已保存的自定义模板和当前未保存内容。');
      setTimeout(() => {
        if (resetting || !box.isConnected) return;
        resetButton.dataset.armed = '0'; resetButton.textContent = '还原默认';
      }, 6000);
      return;
    }
    resetting = true; saveButton.disabled = true; resetButton.disabled = true;
    const fields = box.querySelectorAll('textarea'); fields.forEach((field) => { field.disabled = true; });
    try {
      await api(`/api/prompts/${name}`, { method: 'DELETE' });
      toast('已还原默认', 'ok'); close(true); configuration.refreshTemplates(); openPromptEditor(name);
    } catch (error) { toast('还原失败：' + error.message, 'err'); }
    finally {
      resetting = false; saveButton.disabled = false; resetButton.disabled = false;
      resetButton.dataset.armed = '0'; resetButton.textContent = '还原默认';
      fields.forEach((field) => { field.disabled = false; });
    }
  });
}

async function openStageArtifacts(stage) {
  if (!state.projectId) return toast('先选择项目', 'err');
  const projectId = state.projectId;
  let d;
  try { d = await api(`/api/projects/${projectId}/stage-artifacts`); }
  catch (error) { toast('产物读取失败：' + error.message, 'err'); return; }
  if (projectId !== state.projectId) return;
  const blk = d[stage] || { label: stage, items: [] };
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:820px">
    <h3>${stage} · ${esc(blk.label)} <span class="mut" style="font-size:13px;font-weight:400">（${blk.items.length} 项）</span></h3>
    ${blk.items.length ? `<table><thead><tr><th>ref</th><th>版本</th><th>状态</th><th>内容</th><th></th></tr></thead><tbody>
      ${blk.items.map((it) => `<tr><td>${refLabel(it.ref)}</td><td>v${it.version}</td><td>${pill(it.status)}</td>
        <td class="mut" style="max-width:320px">${esc(it.summary)}</td>
        <td><button class="sm" data-open="${it.id}">JSON</button>
          ${stage === 'S2' ? `<button class="sm primary" data-page="${esc(it.ref)}">详情/编辑</button>` : ''}
          ${stage === 'S3' || stage === 'S4' ? `<button class="sm" data-rerun="${esc(it.ref)}">${stage === 'S4' ? '去出图' : '重跑本页'}</button>` : ''}
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">该阶段还没有产物</div>'}
    <div class="row" style="margin-top:14px"><div class="spacer"></div><button class="sm" data-close>关闭</button></div>
    <div id="art-detail"></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
    const a = await api('/api/artifacts/' + b.dataset.open);
    box.querySelector('#art-detail').innerHTML = `<div class="divider"></div><pre>${esc(JSON.stringify(a.payload, null, 2))}</pre>`;
  }));
  box.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { box.remove(); openPageDetail(b.dataset.page); }));
  box.querySelectorAll('[data-rerun]').forEach((b) => b.addEventListener('click', async () => {
    if (projectId !== state.projectId) { box.remove(); return; }
    if (stage === 'S4') { box.remove(); switchTab('images'); imageWorkbench.focus(b.dataset.rerun); return; }
    const pageRef = 'page:' + b.dataset.rerun.split(':')[1].split('.')[0];
    if (!confirm(`重新生成${pageLabel(pageRef)}的提示词？原版本会保留，相关下游将标记需更新。`)) return;
    box.remove(); await pipelineOverview.submit('S3', { page_ref: pageRef });
  }));
}

async function refreshGates() {
  if (!state.projectId) return;
  const projectId = state.projectId;
  try {
    const g = await api(`/api/projects/${projectId}/gates`);
    if (projectId !== state.projectId) return;
    state._gates = g.stages;
    navigation.update();
    // 只更新统计块；绝不整块重绘（否则会清空用户正在编辑的输入框）
    updateProjectStats();
    pipelineOverview.onGates(g.stages);
  } catch { /* 忽略 */ }
}

// ---------- 作业 SSE ----------
let _sse = null, jobsStreamEpoch = 0, jobsFallback = null;
function startJobsSSE() {
  if (_sse) _sse.close();
  clearInterval(jobsFallback); jobsFallback = null;
  const projectId = state.projectId, epoch = ++jobsStreamEpoch;
  if (!projectId) { renderJobs([]); return; }
  const valid = () => epoch === jobsStreamEpoch && projectId === state.projectId;
  const read = async () => {
    const version = pipelineOverview.version();
    try {
      const list = await api(`/api/jobs?project_id=${projectId}`);
      if (valid() && version === pipelineOverview.version()) renderJobs(list);
    } catch { if (valid()) pipelineOverview.onConnection('polling'); }
  };
  pipelineOverview.onConnection('connecting'); read();
  _sse = new EventSource(API + `/api/jobs/events?project_id=${projectId}`);
  _sse.onopen = () => {
    if (!valid()) return;
    clearInterval(jobsFallback); jobsFallback = null; pipelineOverview.onConnection('live');
  };
  _sse.onerror = () => {
    if (!valid()) return;
    pipelineOverview.onConnection('polling');
    if (!jobsFallback) { read(); jobsFallback = setInterval(read, 5000); }
  };
  _sse.onmessage = (event) => {
    if (!valid()) return;
    try { renderJobs(JSON.parse(event.data)); } catch { /* keep-alive */ }
  };
}
function renderJobs(list) {
  const jobs = list.filter((job) => job.project_id === state.projectId);
  exportCenter.onJobs(jobs); pipelineOverview.onJobs(jobs);
  refreshGates();
  const nowDone = {};
  jobs.forEach((job) => { if (['done', 'failed', 'cancelled'].includes(job.status)) nowDone[job.id] = job.status; });
  const newlyDone = Object.keys(nowDone).filter((id) => state._doneJobs?.[id] !== nowDone[id]);
  state._doneJobs = nowDone;
  if (!newlyDone.length) return;
  const tab = document.querySelector('.nav button.active')?.dataset.tab;
  if (tab === 'images') loadWorkbench();
  else if (tab === 'novel') loadNovel();
  else if (tab === 'prompts') loadPrompts();
  else if (tab === 'pages') loadPages();
  else if (tab === 'compose') loadCompose();
}

// ---------- 出图工作台 ----------
function loadWorkbench() { return imageWorkbench.load(); }

// ---------- 通用产物列表 ----------
$('#reload-art').addEventListener('click', loadArtifacts);
async function loadArtifacts() {
  const projectId = state.projectId;
  if (!state.projectId) return toast('先选择项目', 'err');
  const kind = $('#art-kind').value;
  const rows = await api(`/api/projects/${projectId}/artifacts?kind=${kind}`);
  if (projectId !== state.projectId) return;
  const box = $('#artbox');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无产物</div>'; return; }
  if (kind === 'image') {
    box.innerHTML = rows.map((r) => `<div style="margin-bottom:16px"><div class="row" style="margin-bottom:8px">
      <b>${esc(r.ref)}</b> v${r.version} ${pill(r.status)}</div>
      <div class="candgrid" id="cand-${r.id}"><div class="empty">加载…</div></div></div>`).join('');
    for (const r of rows) await fillCandidates(r.id);
  } else {
    box.innerHTML = `<table><thead><tr><th>ref</th><th>版本</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${refLabel(r.ref)}</td><td>v${r.version}</td><td>${pill(r.status)}</td>
        <td><button class="sm" data-detail="${r.id}">详情</button>
        <button class="sm" data-approve="${r.id}">通过</button>
        <button class="sm danger" data-reject="${r.id}">驳回</button></td></tr>`).join('')}</tbody></table>
      <div id="detail-box"></div>`;
    $$('[data-detail]').forEach((b) => b.addEventListener('click', async () => {
      const a = await api('/api/artifacts/' + b.dataset.detail);
      $('#detail-box').innerHTML = `<div class="divider"></div><pre>${esc(JSON.stringify(a.payload, null, 2))}</pre>`;
    }));
    $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/artifacts/${b.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
      toast('已通过', 'ok'); loadArtifacts(); refreshGates();
    }));
    $$('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const comment = prompt('驳回批注：') || '';
      await api(`/api/artifacts/${b.dataset.reject}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
      toast('已驳回', 'ok'); loadArtifacts(); refreshGates();
    }));
  }
}
async function fillCandidates(id) {
  const a = await api('/api/artifacts/' + id);
  const cands = (a.payload && a.payload.candidates) || [];
  const sel = a.payload && a.payload.selected_index;
  const box = document.getElementById('cand-' + id);
  if (!box) return;
  if (!cands.length) { box.innerHTML = '<div class="empty">无候选</div>'; return; }
  box.innerHTML = cands.map((c, i) => `
    <div class="cand ${i === sel ? 'sel' : ''}" data-art="${id}" data-idx="${i}">
      <img src="/api/artifacts/${id}/candidate/${i}" loading="lazy">
      <div class="lbl"><span>#${i + 1}</span>${i === sel ? '<span style="color:var(--ok)">已选</span>' : ''}</div></div>`).join('');
  box.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', () => {
    openLightbox(`/api/artifacts/${el.dataset.art}/candidate/${el.dataset.idx}`, async () => {
      await api(`/api/artifacts/${el.dataset.art}/select`, { method: 'POST', body: JSON.stringify({ index: +el.dataset.idx }) });
      toast('已采用', 'ok'); loadArtifacts();
    });
  }));
}

// ---------- 灯箱 ----------
function openLightbox(src, onSelect) {
  const box = document.createElement('div'); box.className = 'modal';
  box.innerHTML = `<div class="box"><h3>候选图</h3><img src="${src}">
    <div class="row" style="margin-top:12px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button><button class="primary sm" data-use>采用这张</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  box.querySelector('[data-use]').addEventListener('click', async () => { box.remove(); await onSelect(); });
}

// ---------- 设置 ----------
function loadProviders() { return providerManager.load(); }

let modelLoadRequest = 0, modelWriteEpoch = 0, modelWrites = 0;
async function loadStageBinding() {
  if (modelWrites) return;
  const request = ++modelLoadRequest, epoch = modelWriteEpoch;
  const box = $('#stagelist');
  try {
    const [providers, configuration] = await Promise.all([api('/api/providers'), api('/api/stage-models')]);
    if (request !== modelLoadRequest || epoch !== modelWriteEpoch || modelWrites) return;
    const enabled = providers.filter((provider) => provider.enabled);
    const opts = enabled.map((provider) => `<option value="${provider.id}">${esc(provider.name)} · ${esc(provider.model)}</option>`).join('');
    box.innerHTML = ['S1', 'S2', 'S3'].map((stage) => {
      const selected = configuration.bindings[stage] || 0;
      const missing = selected && !enabled.some((provider) => provider.id === selected);
      return `<div><label class="fld">${stage} · ${{ S1: 'LLM 正文', S2: '分页分格', S3: '分镜提示词' }[stage]}</label>
        <select data-stage="${stage}" data-saved="${selected}" class="stage-bind"><option value="0">${enabled.length ? '使用默认启用供应商' : '未配置启用供应商'}</option>${opts}
          ${missing ? `<option value="${selected}" disabled>原绑定不可用（已回退默认）</option>` : ''}</select><div class="mut" data-model-state="${stage}" style="font-size:12px;margin-top:5px">全局设置</div></div>`;
    }).join('');
    box.querySelectorAll('.stage-bind').forEach((select) => {
      select.value = select.dataset.saved;
      select.addEventListener('change', async () => {
        const previous = select.dataset.saved;
        const status = box.querySelector(`[data-model-state="${select.dataset.stage}"]`);
        modelWriteEpoch++; modelWrites++;
        select.disabled = true; status.textContent = '保存中…';
        try {
          const result = await api('/api/stage-models', { method: 'PATCH', body: JSON.stringify({ [select.dataset.stage]: Number(select.value) || null }) });
          select.dataset.saved = String(result.bindings[select.dataset.stage] || 0); status.textContent = '已保存 · 影响所有项目';
        } catch (e) { select.value = previous; status.textContent = '保存失败：' + e.message; toast(e.message, 'err'); }
        finally { modelWrites--; select.disabled = false; }
      });
    });
  } catch (e) {
    if (request === modelLoadRequest && epoch === modelWriteEpoch && !modelWrites) box.innerHTML = `<div class="empty">读取阶段模型失败：${esc(e.message)}，重新进入此页可重试。</div>`;
  }
}

$('#cf-assets').addEventListener('click', async () => {
  $('#cf-state').className = 'pill run'; $('#cf-state').innerHTML = '<i class="dotm"></i>拉取中…';
  try {
    const r = await api('/api/comfy/assets?backend=' + $('#cf-backend').value);
    $('#cf-out').classList.remove('hidden');
    $('#cf-out').textContent = JSON.stringify({ url: r.url, loras: r.loras, checkpoints: r.checkpoints }, null, 2);
    $('#cf-state').className = 'pill ok'; $('#cf-state').innerHTML = `<i class="dotm"></i>LoRA ${r.loras.length} · ckpt ${r.checkpoints.length}`;
  } catch (e) { $('#cf-state').className = 'pill err'; $('#cf-state').innerHTML = '<i class="dotm"></i>失败'; toast(e.message, 'err'); }
});
$('#cf-open').addEventListener('click', openComfySettings);

// ---------- 出图设置（仙宫云 + 工作流 + 参数 + LoRA + 试跑）----------
// ---------- 出图设置（第一步：POST 连接 → 拉工作流/LoRA；点工作流看参数；选定即跑）----------
function openComfySettings() { return comfySettings.open(); }

// ---------- 分页合成（S5）----------
$('#cps-reload').addEventListener('click', loadCompose);
$('#cps-compose-all').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  const pages = (state._composePages || []).filter((p) => p.ready);
  if (!pages.length) return toast('没有可合成（就绪）的页', 'err');
  try {
    for (const p of pages) {
      await api(`/api/projects/${state.projectId}/run/S5`, { method: 'POST', body: JSON.stringify({ page_ref: p.page_ref }) });
    }
    toast(`已入队合成 ${pages.length} 页`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
// 一键审核：把所有「待审查」的整页成图（S5 产物）置为通过
$('#cps-approve-all').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  try {
    const r = await api(`/api/projects/${state.projectId}/page-images/approve-all`, { method: 'POST', body: '{}' });
    toast(r.approved ? `已通过 ${r.approved} 页` : '没有待审查的整页成图', r.approved ? 'ok' : '');
    loadCompose(); refreshGates();
  } catch (e) { toast(e.message, 'err'); }
});

async function loadCompose() {
  const projectId = state.projectId;
  const menu = $('#cps-menu');
  if (!state._composePages) {
    $('#cps-detail').innerHTML = '<div class="empty">正在加载当前项目的漫画页…</div>';
    $('#cps-finished').innerHTML = '<div class="empty">正在加载当前项目的合成结果…</div>';
  }
  if (!state.projectId) { menu.innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  try {
    const d = await api(`/api/projects/${projectId}/compose-board`);
    if (projectId !== state.projectId) return;
    state._composePages = d.pages || [];
    const ready = d.pages.filter((p) => p.ready).length;
    $('#cps-info').textContent = `${d.pages.length} 页 · ${ready} 页可合成`;
    if (!d.pages.length) {
      menu.innerHTML = '<div class="empty">还没有分格页（先跑 S2）</div>';
      $('#cps-detail').innerHTML = '<div class="empty">当前项目还没有漫画页，请先到「分格分页」添加一页。</div>';
      $('#cps-finished').innerHTML = '<div class="empty">当前项目还没有合成结果。</div>';
      return;
    }
    menu.innerHTML = d.pages.map((p) => {
      const done = p.panels.filter((x) => x.has_image).length;
      const statusPill = p.result_id ? ` ${pill(p.result_status)}` : '';
      return `<div class="pitem" data-cpspage="${esc(p.page_ref)}" style="cursor:pointer">
        <div class="av" style="width:26px;height:26px">${p.page_index}</div>
        <div><b>${pageLabel(p.page_ref)}</b>${statusPill}
          <div class="meta">${done}/${p.panels.length} 格有图${p.composed ? ' · 已合成' : (p.med_doc_id ? ' · 编辑中' : '')}</div></div>
        <div class="spacer"></div>
        <span class="pill ${p.ready ? 'ok' : 'warn'}"><i class="dotm"></i>${p.ready ? '可合成' : '缺图'}</span>
      </div>`;
    }).join('');
    menu.querySelectorAll('[data-cpspage]').forEach((el) =>
      el.addEventListener('click', () => showComposePage(el.dataset.cpspage)));
    // 已完成 / 编辑中的页
    renderComposeFinished();
    // 记住当前选中的页（换模板/刷新后仍停在这一页），否则选第一页
    const sel = (state._composeSelected && d.pages.find((x) => x.page_ref === state._composeSelected))
      ? state._composeSelected : (d.pages[0] && d.pages[0].page_ref);
    if (sel) showComposePage(sel);
  } catch (e) { menu.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/** 分页合成下方：已完成整页 PNG + 可继续编辑的画布存档。 */
async function renderComposeFinished() {
  const projectId = state.projectId;
  const box = $('#cps-finished');
  if (!box) return;
  let pages = [], pageImgs = [], docs = [];
  try {
    pages = state._composePages || (await api(`/api/projects/${projectId}/compose-board`)).pages || [];
    pageImgs = await api(`/api/projects/${projectId}/artifacts?kind=page_image`);
    docs = await api(`/api/projects/${projectId}/artifacts?kind=med_doc`);
  } catch { /* ignore */ }
  const docByRef = {}; docs.forEach((d) => { docByRef[d.ref] = d; });
  if (projectId !== state.projectId) return;
  const imgByRef = {}; pageImgs.forEach((d) => { imgByRef[d.ref] = d; });
  const allRefs = Array.from(new Set([...pages.map((p) => p.page_ref), ...pageImgs.map((d) => d.ref), ...docs.map((d) => d.ref)]));
  if (!allRefs.length) { box.innerHTML = '<div class="empty">还没有合成结果</div>'; return; }
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">
    ${allRefs.map((ref) => {
      const png = imgByRef[ref];
      const doc = docByRef[ref];
      // 主预览优先显示「编辑中」的 MED 画布（最新编辑），否则显示已合成的整页 PNG
      const main = doc && doc.has_file
        ? { url: `/api/artifacts/${doc.id}/file?v=${doc.version}`, label: '编辑中（MED 画布）', kind: 'warn' }
        : (png ? { url: `/api/artifacts/${png.id}/file?v=${png.version}`, label: '已合成整页', kind: 'ok' } : null);
      // 该页可审核的成品：优先整页成图(PNG)，否则「编辑中」画布(MED 存档，需有预览文件)
      const result = png || (doc && doc.has_file ? doc : null);
      return `<div class="mini-card" style="padding:10px">
        <div class="row" style="gap:6px"><b>${pageLabel(ref)}</b>
          ${png ? '<span class="pill ok"><i class="dotm"></i>已合成</span>' : ''}
          ${doc ? '<span class="pill warn"><i class="dotm"></i>编辑中</span>' : ''}
          ${result ? pill(result.status) : ''}</div>
        <div style="margin-top:8px;border:1px solid var(--line2);border-radius:8px;overflow:hidden;background:#f8fafc">
          ${main ? `<img src="${main.url}" style="width:100%;display:block">`
                 : `<div class="empty" style="font-size:12px;padding:24px 0">还没有结果</div>`}
        </div>
        <div class="mut" style="font-size:11px;margin-top:4px">预览：${main ? main.label : '—'}</div>
        <div class="row" style="margin-top:6px;gap:6px">
          ${result && result.status !== 'approved' ? `<button class="sm primary" data-cps-approve="${result.id}">通过</button>
          <button class="sm" data-cps-reject="${result.id}">驳回</button>` : ''}
          <button class="sm primary" data-cps-edit="${esc(ref)}">${doc ? '继续编辑' : '去编辑'}</button>
          ${png ? `<a class="sm" href="/api/artifacts/${png.id}/file?v=${png.version}" target="_blank">看整页图</a>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
  box.querySelectorAll('[data-cps-edit]').forEach((b) => b.addEventListener('click', () => {
    const ref = b.dataset.cpsEdit;
    openMedPage(ref, 'edit=1');
  }));
  box.querySelectorAll('[data-cps-approve]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/artifacts/${b.dataset.cpsApprove}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
      toast('整页已通过', 'ok'); loadCompose(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  }));
  box.querySelectorAll('[data-cps-reject]').forEach((b) => b.addEventListener('click', async () => {
    const comment = prompt('驳回批注（可留空）：') || '';
    try { await api(`/api/artifacts/${b.dataset.cpsReject}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
      toast('整页已驳回', 'ok'); loadCompose(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// 打开 MED 工作台（每次都带防缓存时间戳，避免旧页面缓存了旧按钮）；back= 保存后跳回前端分页合成
function openMedPage(pageRef, mode) {
  return editorWorkbench.open(pageRef, mode);
}

// 画框按漫画阅读顺序（右→左、上→下）排序，用于分页合成预览
function readingOrderGeom(geomPanels) {
  const arr = (geomPanels || []).map((g) => ({ ...g }));
  arr.sort((a, b) => (a.y_pct ?? 0) - (b.y_pct ?? 0) || (b.x_pct ?? 0) - (a.x_pct ?? 0));
  const rows = [];
  for (const g of arr) {
    const row = rows.find((r) => Math.abs(r.y - (g.y_pct ?? 0)) < Math.max(6, (g.height_pct || 10) * 0.6));
    if (row) row.items.push(g);
    else rows.push({ y: g.y_pct ?? 0, items: [g] });
  }
  const out = [];
  for (const r of rows) { r.items.sort((a, b) => (b.x_pct ?? 0) - (a.x_pct ?? 0)); out.push(...r.items); }
  return out;
}

function showComposePage(pageRef) {
  const p = (state._composePages || []).find((x) => x.page_ref === pageRef);
  if (!p) return;
  state._composeSelected = pageRef;   // 记住当前页，换模板/刷新后仍停在这里
  document.querySelectorAll('[data-cpspage]').forEach((el) => el.classList.toggle('sel', el.dataset.cpspage === pageRef));
  const [cw, ch] = p.canvas || [672, 950];
  // 漫画为右→左阅读：把画框按阅读顺序排好，第 k 个画框放该页第 k 格
  const geomOrdered = readingOrderGeom(p.geometry || []);
  const overlaid = p.panels.map((pn, i) => {
    const g = geomOrdered[i] || {};
    const left = (g.x_pct ?? 0), top = (g.y_pct ?? 0);
    const w = (g.width_pct ?? 100), h = (g.height_pct ?? 100);
    return `<div style="position:absolute;left:${left}%;top:${top}%;width:${w}%;height:${h}%;border:2px solid ${pn.has_image ? '#3ecf8e' : '#ffb454'};border-radius:4px;overflow:hidden;background:${pn.has_image ? '#000' : 'repeating-linear-gradient(45deg,#fff,#fff 8px,#f3f4f6 8px,#f3f4f6 16px)'}">
      ${pn.has_image ? `<img src="${pn.image_url}" style="width:100%;height:100%;object-fit:cover;display:block">` : ''}
      <span style="position:absolute;left:3px;top:3px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:1px 5px;border-radius:8px">${cnNum(pn.panel_order)}</span>
      ${pn.has_image ? '' : `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#b45309;font-size:11px">缺图</span>`}
    </div>`;
  }).join('');
  $('#cps-detail').innerHTML = `
    <div class="row" style="gap:8px"><b>${pageLabel(p.page_ref)}</b>
      <span class="pill tag">${p.template_id || '?'} · ${p.panels_count} 格</span>
      <span class="pill ${p.ready ? 'ok' : 'warn'}"><i class="dotm"></i>${p.ready ? '可合成' : '有格缺图'}</span>
      ${p.result_id ? `${pill(p.result_status)}<span class="mut" style="font-size:11.5px">${p.result_kind === 'med_doc' ? '编辑中画布' : '整页成图'}</span>` : ''}
      <div class="spacer"></div>
      ${p.result_id && p.result_status !== 'approved'
        ? `<button class="sm primary" id="cps-approve">通过</button>
           <button class="sm" id="cps-reject">驳回</button>` : ''}
      <button class="sm" id="cps-changetpl">更换模板</button>
      <button class="sm primary" id="cps-do">${p.med_doc_id ? '继续编辑漫画页' : '编辑漫画页'}</button>
      <button class="sm" id="cps-open" title="打开关联这页的空白画布">空白编辑</button>
      <button class="sm" id="cps-run">后台合成</button>
    </div>
    <div class="mut" style="font-size:12px;margin-top:6px">漫画框 ${Math.round(cw)}×${Math.round(ch)} · ${esc(p.layout_desc || '')}</div>
    <div style="position:relative;aspect-ratio:${cw}/${ch};max-width:460px;margin:10px auto;border:1px solid var(--line2);border-radius:8px;background:#fff;box-shadow:0 6px 20px -10px rgba(0,0,0,.25)">
      ${overlaid}
    </div>
    ${p.composed ? `<div class="row" style="gap:8px;margin-top:6px"><span class="mut" style="font-size:12px">已有一个整页成图：</span>
      <a class="sm" href="${p.composed_url}" target="_blank">打开整页 PNG</a></div>` : ''}`;
  const doBtn = $('#cps-do');
  if (doBtn) doBtn.addEventListener('click', () => medCompose(p, false));
  const ob = $('#cps-open'); if (ob) ob.addEventListener('click', () => medCompose(p, true));
  const apb = $('#cps-approve');
  if (apb) apb.addEventListener('click', async () => {
    try {
      await api(`/api/artifacts/${p.result_id}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
      toast(`${pageLabel(p.page_ref)} 已通过`, 'ok'); loadCompose(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  });
  const rjb = $('#cps-reject');
  if (rjb) rjb.addEventListener('click', async () => {
    const comment = prompt('驳回批注（可留空）：') || '';
    try {
      await api(`/api/artifacts/${p.result_id}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
      toast(`${pageLabel(p.page_ref)} 已驳回`, 'ok'); loadCompose(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  });
  const rb = $('#cps-run');
  if (rb) rb.addEventListener('click', async () => {
    try {
      const r = await api(`/api/projects/${state.projectId}/run/S5`, { method: 'POST', body: JSON.stringify({ page_ref: p.page_ref }) });
      toast(`${pageLabel(p.page_ref)} 后台合成已入队 #${r.job_id}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  const ct = $('#cps-changetpl');
  if (ct) ct.addEventListener('click', () => openTemplatePicker(async (tplId) => {
    try {
      await api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(p.page_ref)}/template`, { method: 'POST', body: JSON.stringify({ template_id: tplId }) });
      toast(`${pageLabel(p.page_ref)} 模板已换成 ${tplId}`, 'ok');
      await loadCompose();
    } catch (e) { toast(e.message, 'err'); }
  }, p.template_id, `给 ${pageLabel(p.page_ref)} 换版式（只列 ${p.panels_count} 格模板）`,
     (t) => t.panels_count === p.panels_count));
}

/** 打开 MED 并自动装模板 + 贴好已选画面；openOnly=true 时只打开不合成。 */
function medCompose(page, openOnly) {
  if (openOnly) { openMedPage(page.page_ref, 'plain=1'); return; }
  openMedPage(page.page_ref, page.med_doc_id ? 'edit=1' : 'auto=1');
}

// ---------- 启动 ----------
(async () => {
  const ve = document.getElementById('ui-version');
  if (ve) {
    const s = [...document.querySelectorAll('script[src*="app.js"]')][0];
    ve.textContent = 'app.js ' + ((s && s.src.split('?')[1]) || '(no ver)');
  }
  await checkHealth();
  await ensureMeta();
  navigation.onNavigate('projects');
  const rows = await loadProjects();
  // 恢复上次选中的项目（刷新后不用再点一下）；没有/已删除则显示列表
  let lastId = 0;
  try { lastId = +(localStorage.getItem('comic.lastProjectId') || 0); } catch { /* ignore */ }
  if (lastId && (rows || []).some((p) => p.id === lastId)) {
    try {
      await pickProject(lastId);
    } catch {
      try { localStorage.removeItem('comic.lastProjectId'); } catch { /* ignore */ }
      showProjectView('list');
    }
  } else {
    try { localStorage.removeItem('comic.lastProjectId'); } catch { /* ignore */ }
    showProjectView('list');
  }
  // 恢复上次所在的菜单（或用 ?tab= 指定），刷新/跳转回来都停在原菜单
  let tab = '';
  try { tab = new URLSearchParams(location.search).get('tab') || localStorage.getItem('comic.tab') || ''; } catch { /* ignore */ }
  if (tab && TITLES[tab]) switchTab(tab);
  startJobsSSE();
  startTavernSSE();
  setInterval(refreshGates, 5000);
})();
