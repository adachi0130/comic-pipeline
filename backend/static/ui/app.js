/* 自研前端逻辑（原生 ES module，无构建）。
 * 新流程：S1 正文（酒馆写/续写/审核）→ S2 分格 → S3 提示词 → S4 出图 → S5 合成 → S6 导出
 * 所有数据按当前项目隔离，切换项目会全量刷新。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const API = '';

const state = { projectId: null, project: null, meta: null, templates: [], techniques: [] };

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
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 4200);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS = {
  approved: ['ok', '已通过'], review: ['warn', '待审查'], rejected: ['err', '已驳回'],
  stale: ['stale', '需重跑'], running: ['run', '生成中'], pending: ['', '待生成'],
  done: ['ok', '完成'], failed: ['err', '失败'], queued: ['', '排队中'], cancelled: ['', '已取消'],
};
const pill = (s) => { const [c, l] = STATUS[s] || ['', s || '—']; return `<span class="pill ${c}"><i class="dotm"></i>${l}</span>`; };

// ---------- Tab ----------
const TITLES = {
  projects: ['项目', '选择或新建一部漫画'],
  novel: ['正文', '用酒馆写小说，逐段审核，然后进入分页'],
  pipeline: ['流水线', '各阶段与中间产物'],
  pages: ['分格', '每页选模板（或让 AI 选）+ 打分格'],
  prompts: ['提示词', 'S3 分镜提示词：每格一句出图词'],
  images: ['出图', '连上后端 → 选工作流 → 出图挑图'],
  compose: ['分页合成', '选好的画面按漫画框拼成整页'],
  settings: ['设置', 'LLM 供应商 / ComfyUI / 阶段绑定'],
};
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

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
function switchTab(tab) {
  $$('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['projects', 'novel', 'pipeline', 'pages', 'prompts', 'images', 'compose', 'settings'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
  $('#view-title').textContent = TITLES[tab][0];
  $('#view-sub').textContent = TITLES[tab][1];
  if (tab === 'novel') loadNovel();
  if (tab === 'pipeline') renderFlow().then(refreshGates);
  if (tab === 'images') loadWorkbench();
  if (tab === 'pages') loadPages();
  if (tab === 'prompts') loadPrompts();
  if (tab === 'compose') loadCompose();
  if (tab === 'images' || tab === 'prompts') ensureLoraDatalist();
  if (tab === 'settings') { loadProviders(); loadStageBinding(); }
  if (tab === 'projects') {
    // 已选中项目时停在详情（二级），否则显示列表（一级）
    showProjectView(state.projectId ? 'detail' : 'list');
    if (state.projectId) api('/api/projects/' + state.projectId).then((p) => { state.project = p; renderProjectDetail(); });
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
  const box = $('#plist');
  if (!rows.length) { box.innerHTML = '<div class="empty">还没有项目，先在上面创建一个</div>'; return rows; }
  box.innerHTML = rows.map((p) => `
    <div class="pitem ${p.id === state.projectId ? 'sel' : ''}" data-pick="${p.id}">
      <div class="av">${esc((p.title || '?').slice(0, 1))}</div>
      <div><b>${esc(p.title)}</b><div class="meta">${p.target_pages} 页 · ${p.review_mode === 'auto' ? '全自动' : '人工审查'}</div></div>
      <div class="spacer"></div>
      ${p.id === state.projectId ? '<span class="pill ok"><i class="dotm"></i>当前</span>' : '<span class="mut" style="font-size:12.5px">点击打开</span>'}
    </div>`).join('');
  $$('[data-pick]').forEach((el) => el.addEventListener('click', () => pickProject(+el.dataset.pick)));
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
  state.projectId = id;
  try { localStorage.setItem('comic.lastProjectId', String(id)); } catch { /* 隐私模式忽略 */ }
  state.project = await api('/api/projects/' + id);
  showProjectView('detail');                       // 进入二级页面
  const h = $('#pd-title-h'); if (h) h.textContent = state.project.title || '项目详情';
  const c = $('#pv-crumb'); if (c) c.textContent = `项目 / ${state.project.title || ''}`;
  $('#cur-proj').innerHTML = `<b>${esc(state.project.title)}</b>
    <span class="mut">${state.project.target_pages} 页 · ${state.project.review_mode === 'auto' ? '全自动' : '人工审查'}</span>`;
  $('#automode').checked = state.project.review_mode === 'auto';
  // 项目隔离：切项目时全量刷新所有视图
  await loadProjects();
  await ensureMeta();
  renderProjectDetail();
  await renderFlow();
  refreshGates();
  const active = document.querySelector('.nav button.active')?.dataset.tab;
  if (active === 'novel') loadNovel();
  if (active === 'images') loadWorkbench();
  if (active === 'prompts') loadPrompts();
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
  const box = $('#proj-detail');
  if (!box) return;
  const p = state.project;
  if (!p || !state.projectId) { box.innerHTML = '<div class="empty">未选择项目</div>'; return; }
  const g = state._gates || {};

  // 小说状态（全文只看已通过）
  let novel = { chars: 0, total_count: 0, approved_count: 0, text: '' };
  try { novel = await api(`/api/projects/${state.projectId}/novel`); } catch { /* 忽略 */ }

  // 各阶段产物明细
  let arts = {};
  try { arts = await api(`/api/projects/${state.projectId}/stage-artifacts`); } catch { /* 忽略 */ }

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
      <div><label class="fld">标题</label>
        <div class="row"><input id="pd2-title" value="${esc(p.title)}" style="flex:1">
          <button class="sm" data-save="title">保存</button></div></div>
      <div><label class="fld">目标页数（可改）</label>
        <div class="row"><input id="pd2-pages" type="number" min="1" value="${p.target_pages}" style="flex:1">
          <button class="sm" data-save="target_pages">保存</button></div></div>
    </div>
    <div style="margin-bottom:10px"><label class="fld">故事大纲</label>
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

  // 保存（标题 / 目标页数 / 大纲）
  box.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    const field = b.dataset.save;
    const map = { title: '#pd2-title', target_pages: '#pd2-pages', outline: '#pd2-outline' };
    let v = box.querySelector(map[field]).value;
    if (field === 'target_pages') v = +v || 1;
    try {
      await api('/api/projects/' + state.projectId, { method: 'PATCH', body: JSON.stringify({ [field]: v }) });
      state.project = await api('/api/projects/' + state.projectId);
      toast('已保存', 'ok');
      // 同步侧栏当前项目信息
      $('#cur-proj').innerHTML = `<b>${esc(state.project.title)}</b>
        <span class="mut">${state.project.target_pages} 页 · ${state.project.review_mode === 'auto' ? '全自动' : '人工审查'}</span>`;
      loadProjects();
      refreshGates();
      // 注意：这里**不能**整块重绘 renderProjectDetail()，
      // 否则会把用户正在编辑的其它输入框清空（曾导致“编辑后跳回原样”）。
    } catch (e) { toast(e.message, 'err'); }
  }));
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
  if (!state.projectId) return;
  if (_userEditingDetail()) return;          // 正在输入 -> 跳过
  const novelBox = document.getElementById('pd-novel');
  const statsBox = document.getElementById('pd-stats');
  if (!novelBox && !statsBox) return;
  const g = state._gates || {};
  try {
    const [novel, arts] = await Promise.all([
      api(`/api/projects/${state.projectId}/novel`).catch(() => null),
      api(`/api/projects/${state.projectId}/stage-artifacts`).catch(() => ({})),
    ]);
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
    toast($('#automode').checked ? '已切到全自动' : '已切到人工审查', 'ok');
    renderFlow();
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- 酒馆对话面板 ----------
$('#tv-refresh').addEventListener('click', loadTavern);
$('#tv-error-close').addEventListener('click', async () => {
  state._errDismissed = $('#tv-error-text').textContent;   // 记住这条，别再弹回
  $('#tv-error').classList.add('hidden');
  try { await api('/api/tavern/live/clear', { method: 'POST' }); } catch { /* 忽略 */ }
});
$('#tv-send').addEventListener('click', sendToTavern);
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
function renderChatList(chats, context) {
  const box = $('#tv-chats');
  if (!box) return;
  const cur = $('#tv-cur');
  if (cur) cur.textContent = context.character_name ? `当前：${context.character_name}` : '未选择会话';
  if (!chats.length) {
    box.innerHTML = '<div class="empty">还没有读到酒馆对话列表——确认酒馆已打开且扩展已启用</div>';
    return;
  }
  const curAvatar = context.character_avatar || '';
  const curChat = (context.chat_id || '').replace(/\.jsonl$/, '');
  const listSig = curAvatar + '|' + curChat + '|' + chats.map((c) => c.file_name + ':' + c.chat_items).join(',');
  if (listSig === state._listSig) return;   // 未变则不重绘
  state._listSig = listSig;
  const groups = {};
  for (const c of chats) (groups[c.char_name || '(未知角色)'] ||= []).push(c);
  box.innerHTML = Object.entries(groups).map(([name, list]) => {
    const isCurChar = list.some((c) => c.avatar === curAvatar);
    return `
    <div style="margin-bottom:10px">
      <div class="mut" style="font-size:12px;margin-bottom:5px">${esc(name)}
        <span class="pill tag">${list.length}</span>
        ${isCurChar ? '<span class="pill ok"><i class="dotm"></i>当前角色</span>' : ''}</div>
      <div class="plist">
        ${list.map((c) => {
          const nm = (c.file_name || '').replace('\.jsonl', '');
          const active = c.avatar === curAvatar && nm === curChat;
          return `<div class="pitem ${active ? 'sel' : ''}"
              data-switch='${esc(JSON.stringify({ avatar: c.avatar, file_name: c.file_name, chat_name: nm }))}'>
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
  box.querySelectorAll('[data-switch]').forEach((el) => el.addEventListener('click', () => {
    switchChat(JSON.parse(el.dataset.switch));
  }));
}

async function switchChat(info) {
  try {
    const r = await api('/api/tavern/switch', { method: 'POST', body: JSON.stringify(info) });
    toast(`已请求切换到「${info.chat_name}」#${r.job_id}`, 'ok');
    setTimeout(loadTavern, 2500);
  } catch (e) { toast(e.message, 'err'); }
}

// 对话列表折叠
document.addEventListener('click', (e) => {
  if (e.target.closest('#tv-chats-toggle')) {
    const body = $('#tv-chats-body');
    const arrow = $('#tv-chats-arrow');
    const hidden = body.classList.toggle('hidden');
    if (arrow) arrow.textContent = hidden ? '▸' : '▾';
  }
});

// 酒馆镜像 SSE：对话/列表发生变化就刷新（不用手动点刷新）
let _tvSSE = null;
function startTavernSSE() {
  if (_tvSSE) _tvSSE.close();
  _tvSSE = new EventSource(API + '/api/tavern/events');
  _tvSSE.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (!d.available) return;
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
  // 自洽性校验：镜像偶尔会给出“当前会话不在对话列表里”的过渡状态（酒馆页面内部抖动），
  // 这类状态直接忽略，保持上一次的显示，避免聊天记录一闪一闪。
  const curId = String(ctx.chat_id || '').replace(/\.jsonl$/, '');
  if (curId && chats.length && !chats.some((c) => String(c.file_name || '').replace(/\.jsonl$/, '') === curId)) {
    return;   // 当前会话不在列表里 -> 过渡态，忽略
  }
  // 酒馆的“欢迎页”状态（没有选中角色）不是用户想要的视图，会被酒馆自身的加载循环
  // 反复推上来，导致聊天记录一闪一闪。已经渲染过真实会话时，直接忽略这种状态。
  if (!ctx.character_name && state._tavernRendered) {
    return;
  }
  if (ctx.character_name) state._tavernRendered = true;
  renderChatList(chats, ctx);
  const c = d.context || {};
  $('#tv-meta').innerHTML = `当前角色：<b>${esc(c.character_name || '—')}</b>
    · 对话 ${c.message_count || 0} 条${c.chat_id ? ` · 会话 ${esc(String(c.chat_id).replace(/\.jsonl$/, ''))}` : ''}
    <span class="mut" style="font-size:12px">（更新于 ${(d.updated_at || '').replace('T', ' ').slice(0, 19)}）</span>`;
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

async function loadTavern() {
  try {
    const d = await api('/api/tavern/live');
    renderChatList(d.chats || [], d.context || {});
    if (!d.available) {
      $('#tv-meta').textContent = '还没有收到酒馆推送——请打开酒馆并启用 comic-bridge 扩展';
      $('#tv-chat').innerHTML = '<div class="empty">等待酒馆扩展推送…</div>';
      return;
    }
    const c = d.context || {};
    $('#tv-meta').innerHTML = `当前角色：<b>${esc(c.character_name || '—')}</b>
      · 对话 ${c.message_count || 0} 条${c.chat_id ? ` · 会话 ${esc(c.chat_id)}` : ''}
      <span class="mut" style="font-size:12px">（更新于 ${(d.updated_at || '').replace('T', ' ').slice(0, 19)}）</span>`;

    // 生成依据（简单版：角色卡 / 世界书 / 预设）
    const rc = d.receipt || {};
    const bits = [];
    if (rc.character_name) bits.push(`角色卡 ${rc.character_name}`);
    if (rc.world_books?.length) bits.push(`世界书 ${rc.world_books.join('、')}${rc.world_count ? `(${rc.world_count}条)` : ''}`);
    if (rc.preset_name) bits.push(`预设 ${rc.preset_name}`);
    if (rc.model) bits.push(`模型 ${rc.model}`);
    $('#tv-receipt').textContent = '生成依据：' + (bits.length ? bits.join(' · ') : '尚未生成');

    const all = d.messages || [];
    const msgs = all.filter((m) => !isNoise(m));
    state.chatLenNow = msgs.length;
    const lc = $('#tv-lastcount');
    if (lc) lc.textContent = state.chatLenAtSend != null
      ? `发送前 ${state.chatLenAtSend} 条 · 现在 ${msgs.length} 条`
      : `当前会话共 ${msgs.length} 条`;
    const box2 = $('#tv-chat');
    const nearBottom = box2.scrollHeight - box2.scrollTop - box2.clientHeight < 80;
    box2.innerHTML = msgs.length ? msgs.map((m) => `
      <div class="seg" style="margin-bottom:8px">
        <div class="segh"><b>${esc(m.name || (m.is_user ? '我' : '角色'))}</b>
          <span class="pill tag">${m.is_user ? '用户' : m.is_system ? '系统' : '角色'}</span>
          <span class="mut" style="font-size:11.5px">${esc(m.send_date || '')}</span></div>
        <div class="txt">${esc(m.mes || '')}</div></div>`).join('') : '<div class="empty">对话为空</div>';
    if (nearBottom) requestAnimationFrame(() => { box2.scrollTop = box2.scrollHeight; });
  } catch (e) { $('#tv-meta').textContent = '读取失败：' + e.message; }
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
$('#nv-start').addEventListener('click', () => requestProse('start'));
$('#nv-continue').addEventListener('click', () => requestProse('continue'));

async function requestProse(mode) {
  if (!state.projectId) return toast('先选择项目', 'err');
  try {
    const r = await api(`/api/projects/${state.projectId}/prose/request`, { method: 'POST',
      body: JSON.stringify({ mode, instruction: $('#nv-instr').value }) });
    toast(`已请求酒馆${mode === 'continue' ? '续写' : '开始写作'} #${r.job_id}（需酒馆标签页打开）`);
  } catch (e) { toast(e.message, 'err'); }
}

async function loadNovel() {
  if (!state.projectId) { $('#nv-segs').innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  loadTavern();
  try {
    const n = await api(`/api/projects/${state.projectId}/novel`);
    $('#nv-state').className = 'pill ' + (n.total_count === 0 ? '' : n.can_continue ? 'ok' : 'warn');
    $('#nv-state').innerHTML = `<i class="dotm"></i>${n.approved_count}/${n.total_count} 段已通过`;
    const sc = $('#nv-segs-count'); if (sc) sc.textContent = `${n.approved_count}/${n.total_count} 已通过`;
    const fc = $('#nv-full-count'); if (fc) fc.textContent = `${n.chars} 字`;
    $('#nv-continue').disabled = !(n.can_continue && n.total_count > 0);

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
  $$('[data-fold]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;  // 点按钮不触发折叠
    const id = h.dataset.fold;
    const body = document.getElementById('seg-body-' + id);
    const arrow = document.getElementById('seg-arrow-' + id);
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
  const a = await api('/api/artifacts/' + id);
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
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  box.querySelector('#seg-save').addEventListener('click', async () => {
    const text = box.querySelector('#seg-edit').value;
    await api(`/api/artifacts/${id}/payload`, { method: 'PATCH', body: JSON.stringify({ text }) });
    box.remove(); toast('已保存（下游标记需重跑）', 'ok'); loadNovel(); refreshGates();
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
  if (!state.projectId) return;
  const [d, tpls] = await Promise.all([
    api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(pageRef)}`),
    api('/api/templates'),
  ]);
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
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  box.querySelector('#pd-pick').addEventListener('click', () => {
    openTemplatePicker(async (tplId) => {
      if (!confirm('换版式会按新格数重排分格（内容尽力保留），继续？')) return;
      try {
        const r = await api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(pageRef)}/template`,
          { method: 'POST', body: JSON.stringify({ template_id: tplId }) });
        toast(r.note || '已换版式', 'ok'); box.remove(); openPageDetail(pageRef); refreshGates();
      } catch (e) { toast(e.message, 'err'); }
    }, (d.template || {}).id, '换成哪个版式？');
  });
  box.querySelector('#pd-save').addEventListener('click', async () => {
    const panels = [...box.querySelectorAll('#pd-panels .card')].map((c, i) => ({
      panel_order: i + 1,
      action: c.querySelector('.pd-action').value,
      dialogue: c.querySelector('.pd-dialogue').value,
      scene_desc: c.querySelector('.pd-scene').value,
      characters: c.querySelector('.pd-chars').value.split(/[，,]/).map((s) => s.trim()).filter(Boolean),
    }));
    try {
      await api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(pageRef)}/script`,
        { method: 'POST', body: JSON.stringify({ panels: mergePanels(panels) }) });
      toast('已保存（下游标记需重跑）', 'ok'); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  });
  box.querySelector('[data-regen]').addEventListener('click', async () => {
    const r = await api(`/api/projects/${state.projectId}/run/S3`, { method: 'POST', body: JSON.stringify({ page_ref: pageRef }) });
    toast(`按此页重跑提示词已入队 #${r.job_id}`, 'ok');
  });
}
function mergePanels(edited) {
  const m = new Map(edited.map((p) => [p.panel_order, p]));
  return edited;   // 简化：直接以编辑后的面板数组覆盖
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
async function openTemplatePicker(onPick, currentId, title) {
  const tpls = await getAllTemplates();
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
  if (!state.projectId) { $('#pg-list').innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  try {
    const d = await api(`/api/projects/${state.projectId}/pages`);
    state._tpls = d.templates || [];
    $('#pg-count').textContent = `${d.pages.length} 页`;
    $('#pg-meta').textContent = `已审核正文 ${d.novel_chars} 字 · 目标 ${d.target_pages} 页 · 提示词 ${d.panel_prompt_count} 条`;

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
      const art = await api(`/api/projects/${state.projectId}/pages`).then((d) =>
        (d.pages.find((x) => x.page_ref === b.dataset.ok) || {}).artifact_id);
      if (!art) return toast('找不到该页产物', 'err');
      await api(`/api/artifacts/${art}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
      toast(`${b.dataset.ok} 已通过`, 'ok'); loadPages(); refreshGates();
    }));
    box.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      const comment = prompt('驳回批注（可留空）：') || '';
      const art = await api(`/api/projects/${state.projectId}/pages`).then((d) =>
        (d.pages.find((x) => x.page_ref === b.dataset.no) || {}).artifact_id);
      if (!art) return toast('找不到该页产物', 'err');
      await api(`/api/artifacts/${art}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
      toast(`${b.dataset.no} 已驳回`, 'ok'); loadPages(); refreshGates();
    }));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openPageDetail(b.dataset.edit)));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`删除 ${b.dataset.del}？`)) return;
      await api(`/api/projects/${state.projectId}/pages/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      toast('已删除该页', 'ok'); loadPages(); refreshGates();
    }));
  } catch (e) { toast(e.message, 'err'); }
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
  const box = $('#pr-chars');
  if (!state.projectId) { box.innerHTML = '<div class="empty">先选择项目</div>'; return; }
  let chars = [], presets = { positive: [], negative: [] };
  try {
    [chars, presets] = await Promise.all([
      api(`/api/projects/${state.projectId}/characters`),
      api(`/api/prompt-presets?project_id=${state.projectId}`),
    ]);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const presetCard = (kind, list) => `
    <div style="flex:1;min-width:280px">
      <div class="row" style="gap:6px"><b style="font-size:13px">${kind === 'positive' ? '正向预设' : '负向预设'}</b>
        <span class="mut" style="font-size:11.5px">（${kind === 'positive' ? '正向基础提示词：AI 以它为骨架再补每格内容' : '负向基础提示词：AI 以它为基础' }）</span>
        <div class="spacer"></div>
        <button class="sm" data-addpreset="${kind}">＋ 加</button></div>
      ${(list || []).map((p) => `
        <div class="mini-card" style="padding:8px 10px;margin-top:6px" data-preset="${p.id}">
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
    <div class="row" style="align-items:flex-start;gap:16px">
      ${presetCard('positive', presets.positive)}
      ${presetCard('negative', presets.negative)}
    </div>
    <div class="divider"></div>
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
      </div>`).join('') || '<div class="mut" style="font-size:12px;margin-top:8px">还没有角色。点右上「＋ 加角色」。</div>'}`;

  // 预设：保存 + 自动保存（边填边存，避免忘点保存 / 面板重绘冲掉）
  // LoRA 输入框：即时搜索
  attachLoraCombos(box, '.ch-lora');
  attachLoraCombos(box, '.pres-loras', { multi: true });

  box.querySelectorAll('[data-preset]').forEach((el) => {
    const id = +el.dataset.preset;
    const payload = () => ({
      id, name: el.querySelector('.pres-name').value, text: el.querySelector('.pres-text').value,
      is_default: el.querySelector('.pres-def').checked,
      loras: parseLoraStr(el.querySelector('.pres-loras').value),
    });
    const save = async (silent) => {
      try {
        await api('/api/prompt-presets', { method: 'POST', body: JSON.stringify(payload()) });
        if (!silent) toast('预设已保存', 'ok');
        else flashSaved(el);
      } catch (e) { toast(e.message, 'err'); }
    };
    el.querySelector('.pres-save').addEventListener('click', () => save(false));
    el.querySelector('.pres-del').addEventListener('click', async () => {
      if (!confirm('删除这条预设？')) return;
      try {
        await api(`/api/prompt-presets/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        loadCharacterPresetPanel();
      } catch (e) { toast(e.message, 'err'); }
    });
    // 自动保存：输入停下 700ms 后落库（只存本卡，不重绘，避免光标丢失）
    ['input', 'change'].forEach((ev) => {
      el.querySelectorAll('.pres-name, .pres-text, .pres-def, .pres-loras').forEach((inp) =>
        inp.addEventListener(ev, debounce(() => save(true), 700)));
    });
  });
  box.querySelectorAll('[data-addpreset]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const p = await api('/api/prompt-presets', { method: 'POST', body: JSON.stringify({
        kind: b.dataset.addpreset, name: '',
        scope: 'project', project_id: state.projectId, text: '', is_default: false }) });
      toast(`已新建${b.dataset.addpreset === 'positive' ? '正向' : '负向'}预设，填完自动保存`, 'ok');
      // 局部插入，不整块重绘（避免已填内容被冲掉）
      await loadCharacterPresetPanel();
      const card = box.querySelector(`[data-preset="${p.id}"] .pres-name`);
      if (card) card.focus();
    } catch (e) { toast(e.message, 'err'); }
  }));

  // 角色：保存 + 自动保存
  box.querySelectorAll('[data-char]').forEach((el) => {
    const id = +el.dataset.char;
    const payload = () => ({
      id, name: el.querySelector('.ch-name').value, trigger_words: el.querySelector('.ch-trig').value,
      lora_name: el.querySelector('.ch-lora').value, lora_weight: +el.querySelector('.ch-w').value || 0.8,
      use_lora: el.querySelector('.ch-uselora').checked, prompt_block: el.querySelector('.ch-block').value,
    });
    const save = async (silent) => {
      try {
        await api(`/api/projects/${state.projectId}/characters`, { method: 'POST', body: JSON.stringify(payload()) });
        if (!silent) toast('角色已保存', 'ok');
        else flashSaved(el);
      } catch (e) { toast(e.message, 'err'); }
    };
    el.querySelector('.ch-save').addEventListener('click', () => save(false));
    ['input', 'change'].forEach((ev) => {
      el.querySelectorAll('.ch-name, .ch-trig, .ch-lora, .ch-w, .ch-uselora, .ch-block').forEach((inp) =>
        inp.addEventListener(ev, debounce(() => save(true), 700)));
    });
    el.querySelector('.ch-del').addEventListener('click', async () => {
      try { await api(`/api/characters/${id}`, { method: 'DELETE' }); toast('已删除', 'ok'); loadCharacterPresetPanel(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });
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
  try {
    await api(`/api/projects/${state.projectId}/characters`, { method: 'POST', body: JSON.stringify(data) });
    loadCharacterPresetPanel();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- 项目画风 LoRA（项目级，合入该项目每一格，生成提示词与出图都带上）----
function styleLoraRow(l) {
  return `<div class="row" style="gap:6px;margin-top:5px" data-stylerow>
    <input class="st-name" list="lora-all" value="${esc((l && (l.name || l.lora_name)) || '')}" placeholder="画风 lora 文件名" style="flex:1;min-width:240px">
    <input class="st-w" type="number" step="0.05" value="${(l && (l.weight ?? 1)) ?? 1}" style="width:82px">
    <button class="sm danger st-del" type="button">删</button>
  </div>`;
}
async function loadStyleLoras() {
  const box = $('#pr-style');
  if (!box) return;
  if (!state.projectId) { box.innerHTML = '<div class="empty">先选择项目</div>'; return; }
  let rows = [];
  try {
    const d = await api(`/api/projects/${state.projectId}/loras`);
    rows = (d.project || d.rows || []).filter((r) => (r.scope || 'project') === 'project');
  } catch { /* ignore */ }
  box.innerHTML = (rows.length ? rows.map(styleLoraRow).join('') : '<div class="mut" style="font-size:12px">还没配画风 LoRA</div>');
  bindStyle();
}
function bindStyle() {
  const box = $('#pr-style');
  box.querySelectorAll('.st-del').forEach((b) => b.onclick = () => { b.closest('[data-stylerow]').remove(); });
  attachLoraCombos(box, '.st-name');
}
$('#pr-addstyle').addEventListener('click', () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  const box = $('#pr-style');
  if (box.querySelector('.mut') && !box.querySelector('[data-stylerow]')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', styleLoraRow({}));
  bindStyle();
});
$('#pr-style-save').addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  const loras = Array.from($('#pr-style').querySelectorAll('[data-stylerow]')).map((r) => ({
    name: r.querySelector('.st-name').value.trim(),
    weight: +r.querySelector('.st-w').value || 1,
  })).filter((l) => l.name);
  try {
    await api(`/api/projects/${state.projectId}/loras`, { method: 'PUT', body: JSON.stringify({ scope: 'project', loras }) });
    toast(`已保存 ${loras.length} 个画风 LoRA（下次生成提示词时带上）`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

async function loadPrompts() {
  loadCharacterPresetPanel();
  loadStyleLoras();
  ensureLoraDatalist();
  if (!state.projectId) {
    $('#pr-list').innerHTML = '';
    $('#pr-blank').style.display = 'block';
    $('#pr-count').textContent = '—';
    $('#pr-meta').textContent = '请先选择项目';
    return;
  }
  try {
    const d = await api(`/api/projects/${state.projectId}/prompt-board`);
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
        await api(`/api/projects/${state.projectId}/prompt-board/run-page/${encodeURIComponent(b.dataset.prrun)}`, { method: 'POST', body: '{}' });
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
  let art;
  try { art = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt&ref_prefix=${encodeURIComponent(panelRef)}`); }
  catch (e) { return toast(e.message, 'err'); }
  if (!art.length) return toast('找不到该格提示词（先「准备」或生成）', 'err');
  const full = await api('/api/artifacts/' + art[0].id);
  const pl = full.payload || {};
  await ensureLoraDatalist();

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
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  const rebindDel = () => box.querySelectorAll('.pp-loradel').forEach((b) =>
    b.onclick = () => { b.closest('[data-lorarow]').remove(); });
  rebindDel();
  attachLoraCombos(box, '.pp-loraname');
  box.querySelector('#pp-addlora').addEventListener('click', () => {
    const wrap = box.querySelector('#pp-loras');
    if (wrap.querySelector('.mut')) wrap.innerHTML = '';
    wrap.insertAdjacentHTML('beforeend', loraRow({}));
    rebindDel();
    attachLoraCombos(wrap, '.pp-loraname');
  });

  box.querySelector('#pp-savep').addEventListener('click', async () => {
    const loras = Array.from(box.querySelectorAll('[data-lorarow]')).map((row) => ({
      name: row.querySelector('.pp-loraname').value.trim(),
      weight: +row.querySelector('.pp-loraw').value || 0.8,
    })).filter((l) => l.name);
    const num = (sel) => { const v = box.querySelector(sel).value.trim(); return v === '' ? null : +v; };
    const txt = (sel) => { const v = box.querySelector(sel).value.trim(); return v === '' ? null : v; };
    const params = {};
    const si = num('#pp-steps'), cf = num('#pp-cfg'), sa = txt('#pp-sampler'), sc = txt('#pp-sched'), dn = num('#pp-denoise');
    if (si != null) params.steps = si;
    if (cf != null) params.cfg = cf;
    if (sa) params.sampler = sa;
    if (sc) params.scheduler = sc;
    if (dn != null) params.denoise = dn;
    try {
      await api(`/api/projects/${state.projectId}/panel-prompt/${encodeURIComponent(panelRef)}`, {
        method: 'PATCH', body: JSON.stringify({
          prompt_pos: box.querySelector('#pp-pos').value,
          prompt_neg: box.querySelector('#pp-neg').value,
          width: num('#pp-w'), height: num('#pp-h'), seed: num('#pp-seed'),
          loras, params,
        }) });
      toast('已保存', 'ok'); box.remove();
      const t = document.querySelector('.nav button.active')?.dataset.tab;
      if (t === 'images') loadWorkbench(); else loadPrompts();
      refreshGates();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------- 流水线 ----------
async function renderFlow() {
  const box = $('#flow');
  if (!state.projectId) {
    box.innerHTML = `<div class="empty" style="text-align:left">
      还没有选中项目，所以看不到流水线。<br><br>
      · 去「项目」页点一个项目卡片（或新建一个），选中后这里会显示 S1–S6 六个阶段；<br>
      · 每个走 LLM 的阶段（<b>S2 分页分格</b>、<b>S3 分镜提示词</b>）右上角会有「<b>提示词</b>」按钮，可编辑该阶段的提示词模板。
      <div class="row" style="margin-top:10px"><button class="sm primary" data-go-projects>去选择/新建项目</button></div>
    </div>`;
    const gb = box.querySelector('[data-go-projects]');
    if (gb) gb.addEventListener('click', () => switchTab('projects'));
    return;
  }
  const meta = await ensureMeta();
  if (!meta) { box.innerHTML = '<div class="empty">元信息加载失败，请稍后重试或刷新页面</div>'; return; }
  if (!state._gates) await refreshGates();
  const stages = meta.stages || [];
  const gates = state._gates || {};
  box.innerHTML = stages.map((s) => {
    const g = gates[s.id] || { count: 0, approved: 0, review: 0, stale: 0 };
    const total = g.count || 0;
    const pct = total ? Math.round(100 * (g.approved || 0) / total) : 0;
    const isS1 = s.id === 'S1';
    return `<div class="stage" data-stage="${s.id}">
      <div class="idx">${s.id}</div>
      <div><div class="nm">${esc(s.name)}</div><div class="ds">${esc(s.desc)}</div>
        <div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="stat">
        <span class="pill tag">${total} 项</span>
        ${g.approved ? `<span class="pill ok"><i class="dotm"></i>${g.approved} 通过</span>` : ''}
        ${g.review ? `<span class="pill warn"><i class="dotm"></i>${g.review} 待审</span>` : ''}
        ${g.stale ? `<span class="pill stale"><i class="dotm"></i>${g.stale} 需重跑</span>` : ''}
        <button class="sm" data-view="${s.id}">查看</button>
        ${isS1 ? '<button class="sm primary" data-go="novel">去写正文</button>' : `<button class="sm" data-run="${s.id}">运行</button>`}
        ${PROMPT_OF_STAGE[s.id] ? `<button class="sm" data-prompt="${PROMPT_OF_STAGE[s.id]}">提示词</button>` : ''}
      </div></div>`;
  }).join('');
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => openStageArtifacts(b.dataset.view)));
  $$('[data-run]').forEach((b) => b.addEventListener('click', () => runStage(b.dataset.run)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.go)));
  // 提示词按钮统一由全局 document 委托处理（见 loadPages 附近），避免重复弹窗
}

async function runStage(stage) {
  if (!state.projectId) return toast('先选择项目', 'err');
  // 前端先查前置条件，缺什么就明确提示并给跳转
  try {
    const rd = await api(`/api/projects/${state.projectId}/readiness`);
    const info = rd[stage] || {};
    if (!info.ready) {
      if (info.goto && confirm(`前置条件未满足：\n\n${info.missing}\n\n要现在去处理吗？`)) switchTab(info.goto);
      else toast('前置未满足：' + info.missing, 'err');
      return;
    }
  } catch { /* 检查失败就交给后端兜底 */ }
  try {
    const r = await api(`/api/projects/${state.projectId}/run/${stage}`, { method: 'POST', body: '{}' });
    toast(`${stage} 已入队 #${r.job_id}`);
  } catch (e) { toast(e.message, 'err'); }
}

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
                             : 'PAGE_SCRIPT_JSON / CHARACTERS_JSON / TECHNIQUES_JSON / PANEL_GEOMETRY_JSON'}</span>
      <div class="spacer"></div>
      <button class="sm" data-close>取消</button>
      <button class="sm danger" id="pp-reset">还原默认</button>
      <button class="primary sm" id="pp-save">保存</button>
    </div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  box.querySelector('#pp-save').addEventListener('click', async () => {
    try {
      await api(`/api/prompts/${name}`, { method: 'PUT', body: JSON.stringify({
        system_text: box.querySelector('#pp-sys').value,
        user_text: box.querySelector('#pp-user').value }) });
      toast('提示词已保存（后续调用立即生效）', 'ok');
      box.remove();
    } catch (e) { toast(e.message, 'err'); }
  });
  box.querySelector('#pp-reset').addEventListener('click', async () => {
    // 不用浏览器原生 confirm（部分环境会被拦截/阻断），改用二次点击确认
    const btn = box.querySelector('#pp-reset');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = '再点一次确认还原';
      toast('再点一次「再点一次确认还原」即恢复默认（你的自定义将被删除）');
      setTimeout(() => { if (btn) { btn.dataset.armed = '0'; btn.textContent = '还原默认'; } }, 6000);
      return;
    }
    try {
      await api(`/api/prompts/${name}`, { method: 'DELETE' });
      toast('已还原默认', 'ok');
      box.remove(); openPromptEditor(name);
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function openStageArtifacts(stage) {
  if (!state.projectId) return toast('先选择项目', 'err');
  const d = await api(`/api/projects/${state.projectId}/stage-artifacts`);
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
          ${stage === 'S3' || stage === 'S4' ? `<button class="sm" data-rerun="${esc(it.ref)}">重跑</button>` : ''}
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
    try {
      const r = await api(`/api/projects/${state.projectId}/run/S3`, { method: 'POST', body: JSON.stringify({ page_ref: b.dataset.rerun }) });
      toast(`提示词重跑已入队 #${r.job_id}（按该页格数重新生成）`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

async function refreshGates() {
  if (!state.projectId) return;
  try {
    const g = await api(`/api/projects/${state.projectId}/gates`);
    state._gates = g.stages;
    // 只更新统计块；绝不整块重绘（否则会清空用户正在编辑的输入框）
    updateProjectStats();
    if (document.querySelector('.nav button.active')?.dataset.tab === 'pipeline') renderFlow();
  } catch { /* 忽略 */ }
}

// ---------- 作业 SSE ----------
let _sse = null;
function startJobsSSE() {
  if (_sse) _sse.close();
  _sse = new EventSource(API + '/api/jobs/events' + (state.projectId ? `?project_id=${state.projectId}` : ''));
  _sse.onmessage = (ev) => { try { renderJobs(JSON.parse(ev.data)); } catch { /* keep-alive */ } };
}
function renderJobs(jobs) {
  const box = $('#jobs');
  if (!box) return;
  if (!jobs.length) { box.innerHTML = '<div class="empty">暂无作业</div>'; }
  else {
    box.innerHTML = jobs.slice(0, 12).map((j) => {
      const active = j.status === 'running' || j.status === 'queued';
      return `<div class="job"><span class="pill tag">${j.stage || j.kind}</span>
        <span class="mut" style="min-width:52px">#${j.id}</span>${pill(j.status)}
        <div class="bar"><i style="width:${j.total ? Math.round(100 * j.progress / j.total) : (j.status === 'done' ? 100 : 6)}%"></i></div>
        <span class="mut" style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.message || '')}</span>
        ${active ? `<button class="sm danger" data-cancel="${j.id}" title="取消该作业">✕</button>` : ''}</div>`;
    }).join('');
    box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST', body: '{}' });
        toast(`已请求取消作业 #${b.dataset.cancel}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }));
  }
  refreshGates();

  // 作业完成/失败时，自动刷新当前标签页（否则出图完成后前端不更新，要手动刷新才看到）
  const nowDone = {};
  jobs.forEach((j) => { if (j.status === 'done' || j.status === 'failed') nowDone[j.id] = j.status; });
  const newlyDone = Object.keys(nowDone).filter((id) => !state._doneJobs?.[id]);
  state._doneJobs = nowDone;
  if (newlyDone.length) {
    // 失败的作业弹个提示，说明原因（如 LoRA 名不存在、工作流校验失败）
    jobs.filter((j) => newlyDone.includes(String(j.id)) && j.status === 'failed')
      .forEach((j) => toast(`作业 #${j.id} 失败：${(j.error || '').slice(0, 160)}`, 'err'));
    const t = document.querySelector('.nav button.active')?.dataset.tab;
    if (t === 'images') loadWorkbench();
    else if (t === 'novel') loadNovel();
    else if (t === 'prompts') loadPrompts();
    else if (t === 'pages') loadPages();
  } else {
    const t = document.querySelector('.nav button.active')?.dataset.tab;
    if (t === 'novel') loadNovel();
  }
}

// ---------- 出图工作台 ----------
$('#wb-reload').addEventListener('click', loadWorkbench);
$('#wb-comfy').addEventListener('click', openComfySettings);

async function loadWorkbench() {
  if (!state.projectId) {
    $('#wb-list').innerHTML = '<div class="card"><div class="empty">请先选择项目</div></div>';
    $('#wb-pages').innerHTML = '<div class="empty">请先选择项目</div>';
    $('#wb-info').textContent = '—';
    return;
  }
  const box = $('#wb-list');
  try {
    // 0) 顶部：候选图库（所有已生成的候选图，攒成列表方便挑）
    await loadCandidateGallery();

    // 1) 顶部：分格产物（每页卡 + 「详情」看该页所有镜头）
    await renderWorkbenchPages();

    // 2) 逐格出图：列出**所有格**（含还没生成提示词的），未生成的给「自动填写」
    let board = { pages: [] };
    try { board = await api(`/api/projects/${state.projectId}/prompt-board`); } catch { /* ignore */ }
    const panels = [];
    for (const pg of (board.pages || [])) for (const pn of pg.panels) panels.push({ ...pn, page_ref: pg.page_ref });
    if (!panels.length) {
      box.innerHTML = '<div class="card"><div class="empty">还没有分格（先跑 S2 分页分格）</div></div>';
      $('#wb-info').textContent = '0 格';
      return;
    }
    let loraOpts = [];
    try { const r = await api('/api/comfy/assets'); loraOpts = r.loras || []; } catch { /* ComfyUI 未启动 */ }
    // 项目画风 LoRA：自动填写时额外带上
    let styleLoras = [];
    try {
      const d = await api(`/api/projects/${state.projectId}/loras`);
      styleLoras = (d.project || d.rows || []).filter((r) => (r.scope || 'project') === 'project')
        .map((r) => ({ name: r.lora_name || r.name, weight: r.weight ?? 1 }));
    } catch { /* ignore */ }
    const filled = panels.filter((p) => p.prompt).length;
    $('#wb-info').textContent = `${filled}/${panels.length} 格已生成提示词`;

    // 按“页”分组，每页一张卡（默认收起，点标题展开）
    const pageGroups = (board.pages || []).map((pg) => ({
      page_ref: pg.page_ref,
      template: pg.template,
      panels: pg.panels.map((pn) => ({ ...pn, page_ref: pg.page_ref })),
    }));
    box.innerHTML = pageGroups.map((g) => {
      const done = g.panels.filter((x) => x.prompt).length;
      return `<div class="card" style="padding:12px 16px;margin-bottom:10px">
        <div class="row" style="cursor:pointer" data-wb-toggle="${esc(g.page_ref)}">
          <b>${pageLabel(g.page_ref)}</b>
          <span class="pill tag">${g.panels.length} 格</span>
          <span class="pill tag">${done}/${g.panels.length} 已生成</span>
          <span class="mut" style="font-size:12px">${esc(g.template ? (g.template.layout_desc || '') : '')}</span>
          <div class="spacer"></div>
          <span class="mut" style="font-size:12px">点击展开/收起</span>
        </div>
        <div class="wb-page-body" data-wb-body="${esc(g.page_ref)}" style="margin-top:10px">
          ${g.panels.map((p) => {
            const pr = p.prompt;
            if (!pr) {
              return `<div class="mini-card" data-ref="${esc(p.panel_ref)}" style="padding:10px;margin-top:8px">
                <div class="row"><b>${panelFullLabel(p.panel_ref)}</b> <span class="pill warn">未生成提示词</span>
                  <span class="mut" style="font-size:12px">第${cnNum(p.panel_order)}格 · ${esc(p.shot || '')}</span>
                  <div class="spacer"></div>
                  <label class="fld" style="margin:0">张数</label>
                  <input class="wb-count" type="number" value="1" min="1" max="8" style="width:60px">
                  <button class="sm wb-gen-prompt">生成提示词</button>
                  <button class="primary sm wb-gen">出图</button></div>
                <div class="wb-cands" style="margin-top:8px"></div></div>`;
            }
            const loraAll = (pr.loras || []).map((l) => `${esc(l.name)}(${l.weight})`).join('、');
            const pp = pr.params || {};
            const pStr = ['steps', 'cfg', 'sampler', 'scheduler', 'denoise'].filter((k) => pp[k] != null).map((k) => `${k} ${pp[k]}`).join(' · ');
            return `<div class="mini-card" data-ref="${esc(p.panel_ref)}" style="padding:10px;margin-top:8px">
              <div class="row"><b>${panelFullLabel(p.panel_ref)}</b> ${pill(pr.status)}
                <span class="mut" style="font-size:12px">${esc(p.shot || '')}</span>
                <div class="spacer"></div>
                <label class="fld" style="margin:0">张数</label>
                <input class="wb-count" type="number" value="1" min="1" max="8" style="width:60px">
                <button class="sm wb-autofill">自动填写</button>
                <button class="primary sm wb-gen">出图</button></div>
              <div class="mut" style="font-size:11.5px;margin-top:2px">出图参数：${pr.width || '?'}×${pr.height || '?'}${pStr ? ' · ' + esc(pStr) : ''}${loraAll ? ' · LoRA ' + loraAll : ' · 无 LoRA'}</div>
              <div class="pn-row row" data-pn-toggle style="cursor:pointer;gap:8px;margin-top:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:#fafbfc">
                <b style="min-width:64px">详细信息</b>
                <span class="pill ${pr.prompt_pos ? 'ok' : 'tag'}">正 ${pr.prompt_pos ? esc(pr.prompt_pos.slice(0, 16)) + (pr.prompt_pos.length > 16 ? '…' : '') : '（空）'}</span>
                <span class="pill ${pr.prompt_neg ? 'ok' : 'tag'}">负 ${pr.prompt_neg ? esc(pr.prompt_neg.slice(0, 16)) + (pr.prompt_neg.length > 16 ? '…' : '') : '（空）'}</span>
                <div class="spacer"></div>
                <span class="fold-ic">▸</span>
              </div>
              <div class="pn-body hidden">
                <div class="grid2" style="margin-top:8px">
                  <div><label class="fld">正向</label><textarea class="wb-pos">${esc(pr.prompt_pos || '')}</textarea></div>
                  <div><label class="fld">负向</label><textarea class="wb-neg">${esc(pr.prompt_neg || '')}</textarea></div>
                </div>
                <div style="margin-top:8px">
                  <div class="row"><label class="fld" style="margin:0">LoRA（出图套用；含角色/画风）</label>
                    <div class="spacer"></div>
                    <button class="sm" type="button" data-wb-addlora>＋ 加 LoRA</button>
                    <span class="mut" style="font-size:11px" data-wb-lora-msg></span></div>
                  <div class="wb-loras">${(pr.loras || []).map(wbLoraRow).join('') || '<div class="mut" style="font-size:12px">（无）</div>'}</div>
                </div>
                <div class="mut" style="font-size:11px" data-wb-pn-msg></div>
              </div>
              <div class="pn-view" style="margin-top:8px;background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;max-height:300px;overflow:auto">
                <div class="mut" style="font-size:12px">
                  <b>镜别</b> ${esc(p.shot || '—')}　<b>出场</b> ${esc((p.characters || []).join('、') || '—')}${(p.technique || []).length ? '　<b>技法</b> ' + esc((p.technique || []).join('、')) : ''}
                </div>
                ${p.scene_desc ? `<div style="margin-top:5px"><b class="mut">场景</b> ${esc(p.scene_desc)}</div>` : ''}
                ${p.action ? `<div style="margin-top:5px"><b class="mut">动作</b> ${esc(p.action)}</div>` : ''}
                ${p.dialogue ? `<div style="margin-top:5px"><b class="mut">台词</b> ${esc(p.dialogue)}</div>` : ''}
              </div>
              <div class="wb-cands" style="margin-top:10px"></div></div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    // 每页卡：展开/收起（状态记忆）
    const applyPageFolds = () => box.querySelectorAll('[data-wb-toggle]').forEach((h) => {
      const body = box.querySelector(`[data-wb-body="${CSS.escape(h.dataset.wbToggle)}"]`);
      if (!body) return;
      const closed = getFold('wbpage.' + h.dataset.wbToggle, true);   // 默认收起
      body.classList.toggle('hidden', closed);
      h.classList.toggle('closed', closed);
    });
    applyPageFolds();
    box.querySelectorAll('[data-wb-toggle]').forEach((h) => h.addEventListener('click', () => {
      const body = box.querySelector(`[data-wb-body="${CSS.escape(h.dataset.wbToggle)}"]`);
      const hidden = body.classList.toggle('hidden');
      h.classList.toggle('closed', hidden);
      setFold('wbpage.' + h.dataset.wbToggle, hidden);
    }));

    const old = document.getElementById('lora-list'); if (old) old.remove();
    const dl = document.createElement('datalist'); dl.id = 'lora-list';
    dl.innerHTML = loraOpts.map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);
    state.styleLoras = styleLoras;
    bindWorkbench(panels);
    for (const p of panels) if (p.prompt) await renderWbCands({ ref: p.panel_ref });
  } catch (e) { toast(e.message, 'err'); }
}


/** 候选图库：把该项目所有已生成的候选图攒成列表（按格分组），点击挑选。 */
async function loadCandidateGallery() {
  const box = $('#wb-gallery');
  if (!box) return;
  if (!state.projectId) { box.innerHTML = '<div class="empty">先选择项目</div>'; return; }
  let rows = [];
  try { rows = await api(`/api/projects/${state.projectId}/artifacts?kind=image`); } catch { /* ignore */ }
  if (!rows.length) { $('#wb-gallery-info').textContent = '0 张'; box.innerHTML = '<div class="empty">还没有候选图，去下面逐格点「出图」</div>'; return; }
  const full = [];
  for (const r of rows) { try { full.push(await api('/api/artifacts/' + r.id)); } catch { /* skip */ } }
  const total = full.reduce((s, a) => s + (((a.payload && a.payload.candidates) || []).length), 0);
  $('#wb-gallery-info').textContent = `${full.length} 格 · ${total} 张`;
  box.innerHTML = full.map((a) => {
    const cands = (a.payload && a.payload.candidates) || [];
    const sel = a.payload && a.payload.selected_index;
    return `<div style="margin-bottom:14px" data-gallery="${esc(a.ref)}">
      <div class="row" style="gap:6px"><b>${panelFullLabel(a.ref)}</b> ${pill(a.status)}
        <span class="mut" style="font-size:12px">${cands.length} 张</span>
        <div class="spacer"></div>
        <button class="sm" data-g-up="${esc(a.ref)}">＋ 上传图片</button>
        <input type="file" accept="image/*" class="g-file" data-g-ref="${esc(a.ref)}" style="display:none"></div>
      <div class="candgrid" style="margin-top:6px">${cands.map((c, i) => `
        <div class="cand ${i === sel ? 'sel' : ''}" data-art="${a.id}" data-idx="${i}">
          <img src="/api/artifacts/${a.id}/candidate/${i}" loading="lazy">
          <div class="lbl"><span>#${i + 1}${c.uploaded ? ' 上传' : ''}</span>${i === sel ? '<span style="color:var(--ok)">已选</span>' : ''}</div>
          <div class="cand-ops">
            <button class="sm" type="button" data-op="dl" title="下载这张">下载</button>
            <button class="sm danger" type="button" data-op="del" title="删除这张">删</button>
          </div></div>`).join('') || '<div class="empty" style="font-size:12px">还没有图，点「＋ 上传图片」</div>'}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.cand img').forEach((img) => img.addEventListener('click', () => {
    const el = img.closest('.cand');
    openLightbox(`/api/artifacts/${el.dataset.art}/candidate/${el.dataset.idx}`, async () => {
      await api(`/api/artifacts/${el.dataset.art}/select`, { method: 'POST', body: JSON.stringify({ index: +el.dataset.idx }) });
      toast('已采用', 'ok'); loadCandidateGallery(); refreshGates();
    });
  }));
  box.querySelectorAll('.cand-ops button').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const el = b.closest('.cand');
    const art = +el.dataset.art, idx = +el.dataset.idx;
    const op = b.dataset.op;
    if (op === 'dl') {
      const a = document.createElement('a');
      a.href = `/api/artifacts/${art}/candidate/${idx}`; a.download = `cand_${art}_${idx + 1}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    } else if (op === 'del') {
      if (!confirm('删除这张候选图？')) return;
      try {
        await api(`/api/artifacts/${art}/candidate/${idx}`, { method: 'DELETE' });
        toast('已删除', 'ok'); loadCandidateGallery(); refreshGates();
      } catch (err) { toast(err.message, 'err'); }
    }
  }));
  // 上传图片
  box.querySelectorAll('[data-g-up]').forEach((b) => b.addEventListener('click', () => {
    const fi = box.querySelector(`.g-file[data-g-ref="${CSS.escape(b.dataset.gUp)}"]`);
    if (fi) fi.click();
  }));
  box.querySelectorAll('.g-file').forEach((fi) => fi.addEventListener('change', async () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
    try {
      await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(fi.dataset.gRef)}/candidates`, { method: 'POST', body: JSON.stringify({ data_url: dataUrl }) });
      toast('已上传为该格候选图', 'ok'); loadCandidateGallery(); refreshGates();
    } catch (e) { toast('上传失败：' + e.message, 'err'); }
    fi.value = '';
  }));
}

/** 渲染 S2 分格产物：每页一张卡（真版式缩略图 + 每格摘要 + 出图进度）。 */
async function renderWorkbenchPages() {
  const box = $('#wb-pages');
  // 预览来源 = S3 提示词产物（每格的正/负向提示词），不是 S2 分格
  let board = { pages: [], panel_done: 0, panel_total: 0 };
  try { board = await api(`/api/projects/${state.projectId}/prompt-board`); } catch { /* ignore */ }
  const pages = board.pages || [];
  $('#wb-pages-info').textContent = `${pages.length} 页 · 提示词 ${board.panel_done}/${board.panel_total} 格`;
  if (!pages.length) {
    box.innerHTML = '<div class="empty">还没有分好的页。去「分格」页加一页或让 AI 选版式。</div>';
    return;
  }
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px">
    ${pages.map((p) => `
      <div class="mini-card" style="padding:12px" data-wbpage="${esc(p.page_ref)}">
        <div class="row" style="gap:8px">
          <div class="tplthumb-sm" title="${esc(p.template_id || '')}">
            ${p.template_id ? `<img src="/api/templates/${encodeURIComponent(p.template_id)}/svg" alt="">` : ''}
          </div>
          <div>
            <div class="row" style="gap:6px"><b>${pageLabel(p.page_ref)}</b>
              <span class="pill tag">${p.panels.length} 格</span>
              <span class="pill tag">${p.panels.filter((x) => x.prompt).length}/${p.panels.length} 已生成</span></div>
            <div class="mut" style="font-size:11.5px">${esc(p.template ? (p.template.layout_desc || p.template_id) : (p.template_id || ''))}</div>
          </div>
          <div class="spacer"></div>
          <button class="sm primary" data-wbdetail="${esc(p.page_ref)}">详情</button>
          <button class="sm" data-wbpick="${esc(p.page_ref)}">看这页候选图</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px;margin-top:10px">
          ${p.panels.map((x) => {
            const pr = x.prompt;
            const sizeStr = (pr && pr.width) ? `${pr.width}×${pr.height}` : '';
            return `<div class="mini-card" style="padding:8px 10px" data-wbpanel="${esc(x.panel_ref)}">
              <div class="row" style="gap:5px">
                <b style="font-size:11.5px">${panelFullLabel(x.panel_ref)}</b>
                <span class="mut" style="font-size:11px">${esc(x.shot || '')}</span>
              </div>
              <div style="font-size:11.5px;margin-top:3px">${esc((x.action || x.dialogue || '（空）').slice(0, 30))}</div>
              <div class="mut" style="font-size:11px;margin-top:2px">${pr ? (sizeStr + ' · ' + (pr.loras || []).length + ' LoRA') : '未生成提示词'}</div>
              <div class="row" style="margin-top:6px">
                ${pr ? `<button class="sm" data-wbedit="${esc(x.panel_ref)}">详情</button>`
                     : `<button class="sm" data-wbprep="${esc(x.panel_ref)}">准备</button>`}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('')}
  </div>`;
  box.querySelectorAll('[data-wbpick]').forEach((b) => b.addEventListener('click', () => {
    const pageRef = b.dataset.wbpick;
    // 先把「逐格出图」里对应的页展开，再滚到那一格
    const body = document.querySelector(`[data-wb-body="${CSS.escape(pageRef)}"]`);
    const panelPrefix = pageRef.replace('page:', 'panel:');
    if (body) {
      body.classList.remove('hidden');
      const h = document.querySelector(`[data-wb-toggle="${CSS.escape(pageRef)}"]`);
      if (h) h.classList.remove('closed');
      setFold('wbpage.' + pageRef, false);
    }
    const el = document.querySelector(`#wb-list [data-ref^="${CSS.escape(panelPrefix)}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.boxShadow = '0 0 0 3px var(--accent)'; setTimeout(() => { el.style.boxShadow = ''; }, 1400); }
    else toast('这页还没有对应的提示词产物（可在「提示词」页生成，或在下面点「出图」自动准备）');
  }));
  box.querySelectorAll('[data-wbdetail]').forEach((b) => b.addEventListener('click', () => {
    const pg = pages.find((x) => x.page_ref === b.dataset.wbdetail);
    openPagePanelsDetail(b.dataset.wbdetail, pg);
  }));
  box.querySelectorAll('[data-wbedit]').forEach((b) => b.addEventListener('click', () => openPanelPromptEdit(b.dataset.wbedit)));
  box.querySelectorAll('[data-wbprep]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '准备中…';
    try {
      await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(b.dataset.wbprep)}/prepare`, { method: 'POST', body: '{}' });
      toast('已按预设+角色生成该格提示词', 'ok'); loadWorkbench(); refreshGates();
    } catch (e) { toast(e.message, 'err'); }
    finally { b.disabled = false; b.textContent = '准备'; }
  }));
}


/** 出图卡片里的一行 LoRA（可加/删） */
function wbLoraRow(l) {
  return `<div class="row" style="gap:6px;margin-top:5px" data-wblorarow>
    <input class="wb-lora-name" list="lora-all" value="${esc((l && l.name) || '')}" placeholder="lora 文件名" style="flex:1;min-width:220px">
    <input class="wb-lora-w" type="number" step="0.05" value="${(l && l.weight) ?? 0.8}" style="width:76px">
    <button class="sm danger" type="button" data-wb-loradel>删</button>
  </div>`;
}

/** 某一页所有镜头的详情（只读审查）：逐格看 尺寸/参数/LoRA/正负向，可跳去编辑。 */
async function openPagePanelsDetail(pageRef, page) {
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(1000px,95vw)">
    <h3>${pageLabel(pageRef)} · 这一页所有镜头
      <span class="mut" style="font-size:12px;font-weight:400">${esc(page && page.template ? (page.template.layout_desc || '') : '')}</span></h3>
    <div class="h2sub">只读审查；要改点每格的「改这格」。</div>
    <div id="wpd-body"><div class="empty">加载中…</div></div>
    <div class="row" style="margin-top:14px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  const panels = (page && page.panels) || [];
  const rows = [];
  for (const pn of panels) {
    let pr = null;
    if (pn.prompt) {
      try {
        const list = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt&ref_prefix=${encodeURIComponent(pn.panel_ref)}`);
        if (list.length) pr = await api('/api/artifacts/' + list[0].id);
      } catch { /* ignore */ }
    }
    rows.push({ pn, pr });
  }
  box.querySelector('#wpd-body').innerHTML = rows.map(({ pn, pr }) => {
    const pl = (pr && pr.payload) || {};
    const loras = (pl.loras || []).map((l) => `${esc(l.name)}（${l.weight}）`).join('<br>') || '<span class="mut">无</span>';
    const size = pl.width ? `${pl.width}×${pl.height}${pl.frame ? ' · ' + esc(pl.frame) : ''}` : '未生成（按画框自动算）';
    const pp = pl.params || {};
    const pStr = ['steps', 'cfg', 'sampler', 'scheduler', 'denoise'].filter((k) => pp[k] != null).map((k) => `${k} ${pp[k]}`).join(' · ');
    return `<div class="mini-card" style="padding:12px 14px;margin-top:10px">
      <div class="row" style="gap:6px">
        <b>第${cnNum(pn.panel_order)}格</b>
        <span class="mut" style="font-size:12px">${esc(pn.shot || '')}</span>
        ${pr ? pill(pr.status) : '<span class="pill warn">未生成提示词</span>'}
        <span class="pill tag">${size}</span>
        <div class="spacer"></div>
        ${pr ? `<button class="sm" data-wpd-edit="${esc(pn.panel_ref)}">改这格</button>` : `<button class="sm" data-wpd-prep="${esc(pn.panel_ref)}">自动填写</button>`}
      </div>
      <div class="mut" style="font-size:11.5px;margin-top:4px">动作：${esc(pn.action || '（空）')}${pn.dialogue ? '　台词：「' + esc(pn.dialogue) + '」' : ''}</div>
      ${pStr ? `<div class="mut" style="font-size:11.5px;margin-top:2px">出图参数：${esc(pStr)}</div>` : ''}
      ${pr ? `<div style="margin-top:8px"><label class="fld">正向</label><div class="ppv-text">${esc(pl.prompt_pos || '（空）')}</div></div>
        <div style="margin-top:8px"><label class="fld">负向</label><div class="ppv-text">${esc(pl.prompt_neg || '（空）')}</div></div>
        <div style="margin-top:8px"><label class="fld">LoRA</label><div class="mut" style="font-size:12px">${loras}</div></div>`
        : '<div class="mut" style="font-size:12px;margin-top:6px">这格还没生成提示词，点右上「自动填写」。</div>'}
    </div>`;
  }).join('') || '<div class="empty">这一页没有格子</div>';

  box.querySelectorAll('[data-wpd-edit]').forEach((b) => b.addEventListener('click', () => { box.remove(); openPanelPromptEdit(b.dataset.wpdEdit); }));
  box.querySelectorAll('[data-wpd-prep]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '生成中…';
    try {
      await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(b.dataset.wpdPrep)}/prepare`, { method: 'POST', body: '{}' });
      toast('已自动生成该格提示词', 'ok'); box.remove(); loadWorkbench(); refreshGates();
    } catch (e) { toast('自动填写失败：' + e.message, 'err'); b.disabled = false; b.textContent = '自动填写'; }
  }));
}


async function regeneratePanel(ref) {
  if (!confirm(`重新生成 ${ref} 的提示词？（会覆盖这一格）`)) return;
  try {
    const r = await api(`/api/projects/${state.projectId}/run/S3`, { method: 'POST', body: JSON.stringify({ panel_ref: ref }) });
    toast(`${ref} 重新生成已入队 #${r.job_id}`, 'ok');
    setTimeout(loadWorkbench, 2500);
  } catch (e) { toast(e.message, 'err'); }
}


function bindWorkbench(panels) {
  const byRef = {};
  panels.forEach((p) => { byRef[p.panel_ref] = p; });
  const styleLoras = state.styleLoras || [];

  const readLoras = (card) => Array.from(card.querySelectorAll('[data-wblorarow]')).map((row) => ({
    name: row.querySelector('.wb-lora-name').value.trim(),
    weight: +row.querySelector('.wb-lora-w').value || 0.8,
  })).filter((l) => l.name);

  const wbBindLoraRows = (card) => {
    const wrap = card.querySelector('.wb-loras');
    if (!wrap) return;
    wrap.querySelectorAll('[data-wb-loradel]').forEach((b) =>
      b.onclick = () => { b.closest('[data-wblorarow]').remove(); autoSaveLoras(card); });
    attachLoraCombos(wrap, '.wb-lora-name');
  };

  // LoRA 自动保存（只在真正变化时写一次新版本；不覆盖提示词文本）
  const lastLora = {};
  const autoSaveLoras = debounce(async (card) => {
    const art = byRef[card.dataset.ref]?.prompt;
    if (!art) return;
    const cur = readLoras(card);
    const key = card.dataset.ref, json = JSON.stringify(cur);
    if (lastLora[key] === json) return;
    lastLora[key] = json;
    try {
      await api(`/api/artifacts/${art.artifact_id}/payload`, { method: 'PATCH', body: JSON.stringify({ loras: cur }) });
      const msg = card.querySelector('[data-wb-lora-msg]');
      if (msg) { msg.textContent = 'LoRA 已自动保存'; setTimeout(() => { if (msg.textContent === 'LoRA 已自动保存') msg.textContent = ''; }, 1500); }
      refreshGates();
    } catch (e) { lastLora[key] = null; toast('LoRA 保存失败：' + e.message, 'err'); }
  }, 500);

  // 正/负向自动保存（只在真正变化时写一次新版本）
  const lastPN = {};
  const autoSavePN = debounce(async (card) => {
    const art = byRef[card.dataset.ref]?.prompt;
    if (!art) return;
    const pos = card.querySelector('.wb-pos')?.value || '';
    const neg = card.querySelector('.wb-neg')?.value || '';
    const key = card.dataset.ref, json = JSON.stringify([pos, neg]);
    if (lastPN[key] === json) return;
    lastPN[key] = json;
    try {
      await api(`/api/artifacts/${art.artifact_id}/payload`, { method: 'PATCH', body: JSON.stringify({ prompt_pos: pos, prompt_neg: neg }) });
      // 同步左行摘要
      const row = card.querySelector('.pn-row');
      if (row) {
        const pills = row.querySelectorAll('.pill');
        if (pills[0]) { pills[0].className = 'pill ' + (pos ? 'ok' : 'tag'); pills[0].textContent = '正 ' + (pos ? pos.slice(0, 16) + (pos.length > 16 ? '…' : '') : '（空）'); }
        if (pills[1]) { pills[1].className = 'pill ' + (neg ? 'ok' : 'tag'); pills[1].textContent = '负 ' + (neg ? neg.slice(0, 16) + (neg.length > 16 ? '…' : '') : '（空）'); }
      }
      const msg = card.querySelector('[data-wb-pn-msg]');
      if (msg) { msg.textContent = '已自动保存'; setTimeout(() => { if (msg.textContent === '已自动保存') msg.textContent = ''; }, 1500); }
      refreshGates();
    } catch (e) { lastPN[key] = null; toast('保存失败：' + e.message, 'err'); }
  }, 700);

  $$('#wb-list [data-ref]').forEach((card) => {
    const ref = card.dataset.ref;
    const pn = byRef[ref] || {};
    const art = pn.prompt;
    wbBindLoraRows(card);
    // 初始化 lastLora / lastPN 基线
    lastLora[ref] = JSON.stringify(readLoras(card));
    lastPN[ref] = JSON.stringify([card.querySelector('.wb-pos')?.value || '', card.querySelector('.wb-neg')?.value || '']);
    // LoRA 名字/权重变化即自动保存
    const lwrap = card.querySelector('.wb-loras');
    if (lwrap) ['change', 'blur'].forEach((ev) =>
      lwrap.addEventListener(ev, () => autoSaveLoras(card), true));

    // 正/负向：点这行（左边写着「详细信息」）展开/收起；输入自动保存
    const pnRow = card.querySelector('[data-pn-toggle]');
    const pnBody = card.querySelector('.pn-body');
    if (pnRow && pnBody) pnRow.addEventListener('click', () => {
      const hidden = pnBody.classList.toggle('hidden');
      const ic = pnRow.querySelector('.fold-ic'); if (ic) ic.style.transform = hidden ? '' : 'rotate(90deg)';
    });
    ['input', 'change'].forEach((ev) => {
      card.querySelector('.wb-pos')?.addEventListener(ev, () => autoSavePN(card));
      card.querySelector('.wb-neg')?.addEventListener(ev, () => autoSavePN(card));
    });

    // 加 LoRA 行
    const addl = card.querySelector('[data-wb-addlora]');
    if (addl) addl.addEventListener('click', () => {
      const wrap = card.querySelector('.wb-loras');
      if (wrap.querySelector('.mut')) wrap.innerHTML = '';
      wrap.insertAdjacentHTML('beforeend', wbLoraRow({}));
      wbBindLoraRows(card);
    });

    const af = card.querySelector('.wb-autofill');
    if (af) af.addEventListener('click', async () => {
      // 自动填写：把该格已审核的提示词/参数 + 角色 LoRA + 项目画风 LoRA 填进输入框（不发 LLM）
      if (!art) return toast('这格还没有提示词产物', 'err');
      // 注意：art 是 prompt-board 里的对象，字段是平铺的（不是 art.payload）
      const posEl = card.querySelector('.wb-pos'); if (posEl) posEl.value = art.prompt_pos || '';
      const negEl = card.querySelector('.wb-neg'); if (negEl) negEl.value = art.prompt_neg || '';
      // LoRA 合并：该格已有（含角色）→ 再补画风（同名去重，保留原权重）
      const merged = [];
      const seen = new Set();
      for (const l of [...(art.loras || []), ...styleLoras]) {
        if (!l.name || seen.has(l.name)) continue;
        seen.add(l.name);
        merged.push({ name: l.name, weight: l.weight ?? 0.8 });
      }
      const wrap = card.querySelector('.wb-loras');
      if (wrap) wrap.innerHTML = merged.map(wbLoraRow).join('') || '<div class="mut" style="font-size:12px">（无）</div>';
      wbBindLoraRows(card);
      // 填入后自动保存（含画风 LoRA）
      lastLora[ref] = null;
      lastPN[ref] = null;
      autoSaveLoras(card);
      autoSavePN(card);
      toast(`已填入提示词与 ${merged.length} 个 LoRA（含画风）`, 'ok');
    });
    // 未生成提示词的格：按钮是「生成提示词」→ 调 LLM 生成这一格
    const gp = card.querySelector('.wb-gen-prompt');
    if (gp) gp.addEventListener('click', async () => {
      gp.disabled = true; gp.textContent = '生成中…';
      try {
        const r = await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/prepare`, { method: 'POST', body: '{}' });
        toast(r.reused ? '该格已有提示词' : '已生成该格提示词', 'ok');
        loadWorkbench(); refreshGates();
      } catch (e) { toast('生成失败：' + e.message, 'err'); gp.disabled = false; gp.textContent = '生成提示词'; }
    });
    card.querySelector('.wb-gen').addEventListener('click', async () => {
      const count = +card.querySelector('.wb-count').value || 4;
      const btn = card.querySelector('.wb-gen');
      const posEl = card.querySelector('.wb-pos');
      btn.disabled = true; btn.textContent = '准备中…';
      if ((!posEl || !posEl.value.trim()) && !art) {
        try { await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/prepare`, { method: 'POST', body: '{}' }); }
        catch (e) { /* 交给后端用已有 payload 兜底 */ }
      }
      try {
        const r = await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/generate`, { method: 'POST', body: JSON.stringify({ count }) });
        toast(`${ref} 出图已入队 #${r.job_id}（${count} 张）`);
        setTimeout(() => loadWorkbench(), 4000);
      } catch (e) { toast(e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '出图'; }
    });
  });
  attachLoraCombos(document.querySelector('#wb-list'), '.wb-lora-name');
}

async function renderWbCands(pa) {
  const card = document.querySelector(`#wb-list [data-ref="${CSS.escape(pa.ref)}"]`);
  if (!card) return;
  const box = card.querySelector('.wb-cands');
  const imgs = await api(`/api/projects/${state.projectId}/artifacts?kind=image&ref_prefix=${encodeURIComponent(pa.ref)}`);
  if (!imgs.length) { box.innerHTML = '<div class="empty" style="font-size:12px">还没有候选图，点「出图」</div>'; return; }
  const a = await api('/api/artifacts/' + imgs[0].id);
  const cands = (a.payload && a.payload.candidates) || [];
  const sel = a.payload && a.payload.selected_index;
  box.innerHTML = `<div class="candgrid">${cands.map((c, i) => `
    <div class="cand ${i === sel ? 'sel' : ''}" data-art="${a.id}" data-idx="${i}">
      <img src="/api/artifacts/${a.id}/candidate/${i}" loading="lazy">
      <div class="lbl"><span>#${i + 1}</span>${i === sel ? '<span style="color:var(--ok)">已选</span>' : ''}</div></div>`).join('')}</div>`;
  box.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', () => {
    openLightbox(`/api/artifacts/${el.dataset.art}/candidate/${el.dataset.idx}`, async () => {
      await api(`/api/artifacts/${el.dataset.art}/select`, { method: 'POST', body: JSON.stringify({ index: +el.dataset.idx }) });
      toast('已采用', 'ok'); renderWbCands(pa); refreshGates();
    });
  }));
}

// ---------- 通用产物列表 ----------
$('#reload-art').addEventListener('click', loadArtifacts);
async function loadArtifacts() {
  if (!state.projectId) return toast('先选择项目', 'err');
  const kind = $('#art-kind').value;
  const rows = await api(`/api/projects/${state.projectId}/artifacts?kind=${kind}`);
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
async function loadProviders() {
  const rows = await api('/api/providers');
  $('#pvlist').innerHTML = rows.length ? rows.map((p) => `
    <div class="pitem"><div><b>${esc(p.name)}</b> <span class="mut">${esc(p.model)}</span>
      <div class="meta">${esc(p.base_url)} ${p.has_key ? '· 已设 key' : '· 无 key'}</div></div>
      <div class="spacer"></div><button class="sm" data-test="${p.id}">测试</button></div>`).join('')
    : '<div class="empty">尚未配置</div>';
  $$('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    toast('测试中…');
    try { const r = await api(`/api/providers/${b.dataset.test}/test`, { method: 'POST' });
      toast(r.ok ? `可用：${r.reply}` : `失败：${r.error}`, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
  }));
}
$('#btn-addpv').addEventListener('click', async () => {
  try {
    await api('/api/providers', { method: 'POST', body: JSON.stringify({
      name: $('#pv-name').value, base_url: $('#pv-url').value, model: $('#pv-model').value, api_key: $('#pv-key').value }) });
    toast('已添加', 'ok'); loadProviders(); loadStageBinding();
  } catch (e) { toast(e.message, 'err'); }
});
$('#btn-reloadpv').addEventListener('click', loadProviders);
$('#btn-import-tv').addEventListener('click', async () => {
  try {
    const r = await api('/api/providers/import-tavern', { method: 'POST', body: '{}' });
    if (!r.found) return toast('没找到酒馆配置', 'err');
    if (!r.has_key) return toast('酒馆里没读到 key，请手动填', 'err');
    // 自动填进表单，确认后保存
    $('#pv-name').value = r.name; $('#pv-url').value = r.base_url;
    $('#pv-model').value = r.model; $('#pv-key').value = r.api_key;
    await api('/api/providers', { method: 'POST', body: JSON.stringify({
      name: r.name, base_url: r.base_url, model: r.model, api_key: r.api_key }) });
    toast(`已导入：${r.model}`, 'ok');
    loadProviders(); loadStageBinding();
  } catch (e) { toast('导入失败：' + e.message, 'err'); }
});

async function loadStageBinding() {
  const providers = await api('/api/providers');
  const opts = providers.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.model)}</option>`).join('');
  $('#stagelist').innerHTML = ['S2', 'S3'].map((s) =>
    `<div><label class="fld">${s}</label><select data-stage="${s}" class="stage-bind">${providers.length ? opts : '<option value="">（先添加供应商）</option>'}</select></div>`).join('');
  $$('.stage-bind').forEach((sel) => sel.addEventListener('change', async () => {
    if (!sel.value || !state.projectId) return;
    await api(`/api/projects/${state.projectId}/stage-models`, { method: 'PATCH', body: JSON.stringify({ [sel.dataset.stage]: +sel.value }) });
    toast(`${sel.dataset.stage} 已绑定`, 'ok');
  }));
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
async function openComfySettings() {
  let cfg;
  try {
    cfg = await api('/api/comfy/config');
  } catch (e) { return toast(e.message, 'err'); }

  let currentLoras = [];

  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(1000px,95vw)">
    <h3>出图设置 <span class="mut" style="font-size:12px;font-weight:400">连上后端 → 选工作流 → 看参数 → 出图</span></h3>

    <div class="divider"></div>
    <div><b>① 连接</b>
      <span class="mut" style="font-size:12px">　点「连接」= 发一次请求，把后端的工作流与 LoRA 拉回来</span></div>
    <div class="row" style="margin-top:8px">
      <label class="fld" style="margin:0">后端</label>
      <select id="cs-backend" style="width:150px">
        <option value="local" ${cfg.backend === 'local' ? 'selected' : ''}>本机 ComfyUI</option>
        <option value="cloud" ${cfg.backend === 'cloud' ? 'selected' : ''}>仙宫云</option>
      </select>
      <input id="cs-url" placeholder="地址（本机默认 http://127.0.0.1:8188）"
             value="${esc(cfg.backend === 'local' ? (cfg.local_url || 'http://127.0.0.1:8188') : (cfg.cloud_url || ''))}"
             style="flex:1;min-width:260px">
      <input id="cs-key" type="password" placeholder="${cfg.has_api_key ? 'API Key（已存，留空不改）' : 'API Key（一般不用）'}" style="width:170px">
      <button class="sm primary" id="cs-connect">连接</button>
      <span class="pill" id="cs-state">—</span>
    </div>
    <div class="mut" id="cs-counts" style="font-size:12px;margin-top:6px"></div>

    <div class="divider"></div>
    <div class="row">
      <div><b>② 工作流</b>
        <span class="mut" style="font-size:12px">　点一个工作流看它的参数</span></div>
      <div class="spacer"></div>
      <span class="mut" style="font-size:12px">当前：</span><span class="pill tag" id="cs-current">${esc(cfg.workflow_name || '（未选）')}</span>
    </div>
    <div id="cs-wf-list" style="margin-top:8px;max-height:190px;overflow:auto">
      <div class="empty">点「连接」后这里会列出后端上的工作流</div>
    </div>

    <div class="divider"></div>
    <div id="cs-detail"><div class="empty">点上面一个工作流，这里显示它的参数（提示词 / 采样 / LoRA 槽）</div></div>

    <div class="row" style="margin-top:16px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button></div>
  </div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  const backendNow = () => box.querySelector('#cs-backend').value;
  box.querySelector('#cs-backend').addEventListener('change', () => {
    const b = backendNow();
    box.querySelector('#cs-url').value = b === 'local' ? (cfg.local_url || 'http://127.0.0.1:8188') : (cfg.cloud_url || '');
  });
  const setState = (cls, text) => {
    const el = box.querySelector('#cs-state');
    el.className = 'pill ' + cls; el.innerHTML = `<i class="dotm"></i>${text}`;
  };

  // ---- ① 连接：POST 一次，拿工作流 + 模型清单 ----
  box.querySelector('#cs-connect').addEventListener('click', async () => {
    setState('run', '连接中…');
    const backend = backendNow();
    const url = box.querySelector('#cs-url').value.trim();
    const api_key = box.querySelector('#cs-key').value;
    try {
      const r = await api('/api/comfy/connect', { method: 'POST', body: JSON.stringify({ backend, url, api_key }) });
      if (backend === 'local') cfg.local_url = url; else if (url) cfg.cloud_url = url;
      if (!r.reachable) { setState('err', '连不上'); box.querySelector('#cs-counts').textContent = r.error || ''; return; }
      setState('ok', '已连接');
      currentLoras = r.loras || [];
      box.querySelector('#cs-counts').textContent =
        `工作流 ${r.workflows.length} 个 · LoRA ${(r.loras || []).length} 个 · checkpoint ${(r.checkpoints || []).length} 个 · VAE ${(r.vaes || []).length} 个`;
      renderServerWorkflows(r.workflows || []);
    } catch (e) { setState('err', '失败'); toast(e.message, 'err'); }
  });

  function renderServerWorkflows(list) {
    const el = box.querySelector('#cs-wf-list');
    if (!list.length) { el.innerHTML = '<div class="empty">这台后端上还没有工作流（先在 ComfyUI 里存一个）</div>'; return; }
    el.innerHTML = list.map((n) => `
      <div class="pitem" data-wf="${esc(n)}" style="cursor:pointer">
        <div class="av">▧</div>
        <div><b>${esc(n)}</b>
          ${n === cfg.workflow_name || n.replace(/\.json$/, '') === cfg.workflow_name ? ' <span class="pill ok">当前</span>' : ''}</div>
        <div class="spacer"></div>
        <span class="mut" style="font-size:12px">点击查看参数</span>
      </div>`).join('');
    el.querySelectorAll('[data-wf]').forEach((row) =>
      row.addEventListener('click', () => inspectWorkflow(row.dataset.wf)));
  }

  // ---- ② 点工作流 → 看它有哪些参数 ----
  async function inspectWorkflow(name) {
    const el = box.querySelector('#cs-detail');
    el.innerHTML = '<div class="empty">读取中…（UI 格式需要转换成 API 格式，稍等）</div>';
    let r;
    try {
      r = await api('/api/comfy/server-workflow', { method: 'POST', body: JSON.stringify({ backend: backendNow(), name }) });
    } catch (e) {
      el.innerHTML = `<div class="empty" style="color:var(--err);text-align:left">读取失败：${esc(e.message)}</div>`;
      return;
    }
    const d = r.describe || {};
    const prompts = (d.text_params || []).slice(0, 8);
    const lora = d.lora || { slots: [] };
    el.innerHTML = `
      <div class="row" style="gap:8px">
        <b>${esc(name)}</b>
        <span class="pill tag">${d.node_count} 节点</span>
        <span class="pill tag">${r.ui_format ? 'UI 格式（已转 API）' : 'API 格式'}</span>
        <span class="pill tag">LoRA：${esc(lora.mode || '无')}</span>
        <div class="spacer"></div>
        <button class="sm primary" id="cs-use">就用它出图</button>
      </div>
      ${(r.warnings || []).length ? `<div class="empty" style="color:var(--warn);text-align:left;font-size:12px;margin-top:6px">⚠ ${r.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
      ${(d.missing_nodes || []).length ? `<div class="empty" style="color:var(--err);text-align:left;font-size:12px;margin-top:6px">缺节点：${d.missing_nodes.map(esc).join('、')}（这台 ComfyUI 上没装/没加载，可能跑不了）</div>` : ''}

      <div style="margin-top:10px"><b style="font-size:13px">参数</b>
        <span class="mut" style="font-size:12px">　带「疑似提示词」标记的通常就是正/负提示词</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;margin-top:6px">
        ${prompts.map((t, i) => `
          <label class="mini-card" style="padding:8px 10px;display:block;cursor:pointer">
            <input type="checkbox" class="cs-param" data-node="${esc(t.node_id)}" data-input="${esc(t.input)}"
                   ${t.looks_prompt && i < 2 ? 'checked' : ''} style="width:auto">
            <span class="pill tag" style="margin-left:6px">${esc(t.class_type)}#${esc(t.node_id)}</span>
            ${t.looks_prompt ? '<span class="pill warn" style="margin-left:4px">疑似提示词</span>' : ''}
            <div class="mut" style="font-size:11px;margin-top:4px;word-break:break-all">${esc((t.value || '').slice(0, 90))}</div>
          </label>`).join('') || '<div class="mut" style="font-size:12px">没找到文本参数</div>'}
      </div>

      <div style="margin-top:10px"><b style="font-size:13px">LoRA 槽（${(lora.slots || []).length} 个）</b>
        <span class="mut" style="font-size:12px">　勾选启用；名字可下拉联想后端已有的 LoRA</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;margin-top:6px">
        ${(lora.slots || []).map((s, i) => `
          <div class="mini-card" style="padding:8px 10px">
            <label style="font-size:12px"><input type="checkbox" class="cs-lora" ${s.on ? 'checked' : ''} style="width:auto">
              槽 ${i + 1} · ${esc(s.input)}</label>
            <input class="cs-lora-name" list="cs-lora-opts" value="${esc(s.lora || '')}" placeholder="lora 文件名" style="width:100%;margin-top:4px;font-size:12px">
            <label class="fld" style="margin:4px 0 0;font-size:11px">权重
              <input class="cs-lora-w" type="number" step="0.05" value="${s.strength ?? 1}" style="width:74px"></label>
          </div>`).join('') || '<div class="mut" style="font-size:12px">这个工作流没有可识别的 LoRA 堆加载节点</div>'}
      </div>

      <div style="margin-top:10px"><b style="font-size:13px">采样参数</b></div>
      <div class="grid2" style="margin-top:6px">
        ${Object.entries(d.sampler || {}).map(([k, v]) => `
          <div class="mini-card" style="padding:8px 10px;display:flex;justify-content:space-between">
            <span class="mut" style="font-size:12px">${esc(k)}</span><b style="font-size:12px">${esc(String(v.value))}</b>
          </div>`).join('') || '<div class="mut" style="font-size:12px">没识别到采样节点（可能是子图）</div>'}
      </div>

      <div style="margin-top:12px"><b style="font-size:13px">试跑</b>
        <span class="mut" style="font-size:12px">　用上面勾选的提示词与 LoRA 真出一张</span></div>
      <div class="grid2" style="margin-top:6px">
        <div><label class="fld">正向提示词</label><textarea id="cs-t-pos" style="min-height:54px">1girl, solo, masterpiece, best quality</textarea></div>
        <div><label class="fld">负向提示词</label><textarea id="cs-t-neg" style="min-height:54px">worst quality, low quality</textarea></div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="sm primary" id="cs-test">试跑一张</button>
        <span class="mut" id="cs-test-msg" style="font-size:12px"></span>
      </div>
      <div id="cs-test-out" style="margin-top:10px"></div>`;

    const old = document.getElementById('cs-lora-opts'); if (old) old.remove();
    const dl = document.createElement('datalist'); dl.id = 'cs-lora-opts';
    dl.innerHTML = currentLoras.map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);

    const collectParams = () => {
      const plain = {};
      const map = { steps: 'steps', cfg: 'cfg', sampler_name: 'sampler', scheduler: 'scheduler', denoise: 'denoise', width: 'width', height: 'height' };
      Object.entries(map).forEach(([k, out]) => {
        const v = (d.sampler || {})[k];
        if (v && typeof v.value !== 'object') plain[out] = v.value;
      });
      return plain;
    };
    const collectLoras = () => Array.from(el.querySelectorAll('.cs-lora')).map((cb) => {
      const card = cb.closest('.mini-card');
      const name = card.querySelector('.cs-lora-name').value.trim();
      const w = +card.querySelector('.cs-lora-w').value || 0.8;
      return cb.checked && name ? { name, weight: w } : null;
    }).filter(Boolean);

    el.querySelector('#cs-use').addEventListener('click', async () => {
      try {
        const im = await api('/api/comfy/import-from-server', { method: 'POST', body: JSON.stringify({ backend: backendNow(), name }) });
        cfg.workflow_name = im.name;
        const cur = box.querySelector('#cs-current'); if (cur) cur.textContent = im.name;
        renderServerWorkflows(Array.from(box.querySelectorAll('#cs-wf-list [data-wf]')).map((x) => x.dataset.wf));
        toast(`已选中：${im.name}`, 'ok');
        if ((im.warnings || []).length) toast('提示：' + im.warnings.join('；'), 'err');
      } catch (e) { toast(e.message, 'err'); }
    });

    el.querySelector('#cs-test').addEventListener('click', async () => {
      const btn = el.querySelector('#cs-test'); const msg = el.querySelector('#cs-test-msg');
      btn.disabled = true; msg.textContent = '出图中…（可能几十秒）';
      try {
        const params = collectParams();
        const loras = collectLoras();
        await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({ default_params: params }) });
        await api('/api/comfy/import-from-server', { method: 'POST', body: JSON.stringify({ backend: backendNow(), name }) });
        cfg.workflow_name = name.replace(/\.json$/, '');
        const r = await api('/api/comfy/test-run', { method: 'POST', body: JSON.stringify({
          prompt_pos: el.querySelector('#cs-t-pos').value,
          prompt_neg: el.querySelector('#cs-t-neg').value,
          params, loras,
        }) });
        msg.textContent = '完成';
        el.querySelector('#cs-test-out').innerHTML = `<img src="${r.url}" style="max-width:100%;border-radius:10px;border:1px solid var(--line2)">`;
      } catch (e) { msg.textContent = ''; toast('试跑失败：' + e.message, 'err'); }
      finally { btn.disabled = false; }
    });
  }
}


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

async function loadCompose() {
  const menu = $('#cps-menu');
  if (!state.projectId) { menu.innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  try {
    const d = await api(`/api/projects/${state.projectId}/compose-board`);
    state._composePages = d.pages || [];
    const ready = d.pages.filter((p) => p.ready).length;
    $('#cps-info').textContent = `${d.pages.length} 页 · ${ready} 页可合成`;
    if (!d.pages.length) { menu.innerHTML = '<div class="empty">还没有分格页（先跑 S2）</div>'; return; }
    menu.innerHTML = d.pages.map((p) => {
      const done = p.panels.filter((x) => x.has_image).length;
      return `<div class="pitem" data-cpspage="${esc(p.page_ref)}" style="cursor:pointer">
        <div class="av" style="width:26px;height:26px">${p.page_index}</div>
        <div><b>${pageLabel(p.page_ref)}</b>
          <div class="meta">${done}/${p.panels.length} 格有图${p.composed ? ' · 已合成' : ''}</div></div>
        <div class="spacer"></div>
        <span class="pill ${p.ready ? 'ok' : 'warn'}"><i class="dotm"></i>${p.ready ? '可合成' : '缺图'}</span>
      </div>`;
    }).join('');
    menu.querySelectorAll('[data-cpspage]').forEach((el) =>
      el.addEventListener('click', () => showComposePage(el.dataset.cpspage)));
    // 已完成 / 编辑中的页
    renderComposeFinished();
    // 默认选中第一页
    if (state._composePages[0]) showComposePage(state._composePages[0].page_ref);
  } catch (e) { menu.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/** 分页合成下方：已完成整页 PNG + 可继续编辑的画布存档。 */
async function renderComposeFinished() {
  const box = $('#cps-finished');
  if (!box) return;
  let pages = [], pageImgs = [], docs = [];
  try {
    pages = state._composePages || (await api(`/api/projects/${state.projectId}/compose-board`)).pages || [];
    pageImgs = await api(`/api/projects/${state.projectId}/artifacts?kind=page_image`);
    docs = await api(`/api/projects/${state.projectId}/artifacts?kind=med_doc`);
  } catch { /* ignore */ }
  const docByRef = {}; docs.forEach((d) => { docByRef[d.ref] = d; });
  const imgByRef = {}; pageImgs.forEach((d) => { imgByRef[d.ref] = d; });
  const allRefs = Array.from(new Set([...pages.map((p) => p.page_ref), ...pageImgs.map((d) => d.ref), ...docs.map((d) => d.ref)]));
  if (!allRefs.length) { box.innerHTML = '<div class="empty">还没有合成结果</div>'; return; }
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">
    ${allRefs.map((ref) => {
      const png = imgByRef[ref];
      const doc = docByRef[ref];
      return `<div class="mini-card" style="padding:10px">
        <div class="row" style="gap:6px"><b>${pageLabel(ref)}</b>
          ${png ? '<span class="pill ok"><i class="dotm"></i>已合成</span>' : ''}
          ${doc ? '<span class="pill warn"><i class="dotm"></i>编辑中</span>' : ''}</div>
        <div style="margin-top:8px;border:1px solid var(--line2);border-radius:8px;overflow:hidden;background:#f8fafc">
          ${png ? `<img src="/api/artifacts/${png.id}/file" style="width:100%;display:block">`
               : `<div class="empty" style="font-size:12px;padding:24px 0">还没有整页 PNG</div>`}
        </div>
        <div class="row" style="margin-top:8px;gap:6px">
          <button class="sm primary" data-cps-edit="${esc(ref)}">${doc ? '继续编辑' : '去编辑'}</button>
          ${png ? `<a class="sm" href="/api/artifacts/${png.id}/file" target="_blank">看 PNG</a>` : ''}
          ${doc && doc.path ? `<a class="sm" href="/api/artifacts/${doc.id}/file" target="_blank">看编辑图</a>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
  box.querySelectorAll('[data-cps-edit]').forEach((b) => b.addEventListener('click', () => {
    const ref = b.dataset.cpsEdit;
    window.open(`/ui/editor_bridge/index.html?page=${encodeURIComponent(ref)}&p=${state.projectId}&edit=1`, '_blank');
  }));
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
      <div class="spacer"></div>
      <button class="sm primary" id="cps-do">去 MED 合成</button>
      <button class="sm" id="cps-open">在 MED 打开</button>
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
  const rb = $('#cps-run');
  if (rb) rb.addEventListener('click', async () => {
    try {
      const r = await api(`/api/projects/${state.projectId}/run/S5`, { method: 'POST', body: JSON.stringify({ page_ref: p.page_ref }) });
      toast(`${pageLabel(p.page_ref)} 后台合成已入队 #${r.job_id}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/** 打开 MED 并自动装模板 + 贴好已选画面；openOnly=true 时只打开不合成。 */
function medCompose(page, openOnly) {
  const url = '/ui/editor_bridge/index.html' + (openOnly ? '' : `?page=${encodeURIComponent(page.page_ref)}&p=${state.projectId}&auto=1`);
  window.open(url, '_blank');
  if (!openOnly) toast('已在新标签打开 MED，正在自动装框贴图…', 'ok');
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
  startJobsSSE();
  startTavernSSE();
  setInterval(refreshGates, 5000);
})();
