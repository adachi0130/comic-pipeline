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
  images: ['出图', '逐格出图与挑图'],
  pages: ['分格', '每页选模板（或让 AI 选）+ 打分格'],
  settings: ['设置', 'LLM 供应商 / ComfyUI / 阶段绑定'],
};
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  $$('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['projects', 'novel', 'pipeline', 'pages', 'images', 'settings'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
  $('#view-title').textContent = TITLES[tab][0];
  $('#view-sub').textContent = TITLES[tab][1];
  if (tab === 'novel') loadNovel();
  if (tab === 'pipeline') renderFlow().then(refreshGates);
  if (tab === 'images') loadWorkbench();
  if (tab === 'pages') loadPages();
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
  if (!rows.length) { box.innerHTML = '<div class="empty">还没有项目，先在上面创建一个</div>'; return; }
  box.innerHTML = rows.map((p) => `
    <div class="pitem ${p.id === state.projectId ? 'sel' : ''}" data-pick="${p.id}">
      <div class="av">${esc((p.title || '?').slice(0, 1))}</div>
      <div><b>${esc(p.title)}</b><div class="meta">${p.target_pages} 页 · ${p.review_mode === 'auto' ? '全自动' : '人工审查'}</div></div>
      <div class="spacer"></div>
      ${p.id === state.projectId ? '<span class="pill ok"><i class="dotm"></i>当前</span>' : '<span class="mut" style="font-size:12.5px">点击打开</span>'}
    </div>`).join('');
  $$('[data-pick]').forEach((el) => el.addEventListener('click', () => pickProject(+el.dataset.pick)));
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
    <h3>${esc(pageRef)} · 分格详情 <span class="mut" style="font-size:13px;font-weight:400">v${d.version}</span></h3>
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
      <div class="row" style="margin-bottom:6px"><b>第 ${p.panel_order} 格</b>
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
            <div class="row" style="gap:6px"><b>${esc(p.page_ref)}</b> ${pill(p.status)}
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
            <div class="mut" style="font-size:11.5px">第 ${x.panel_order} 格 · ${esc(x.shot || '')}</div>
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
      ${blk.items.map((it) => `<tr><td>${esc(it.ref)}</td><td>v${it.version}</td><td>${pill(it.status)}</td>
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
  if (!jobs.length) { box.innerHTML = '<div class="empty">暂无作业</div>'; return; }
  box.innerHTML = jobs.slice(0, 12).map((j) => `
    <div class="job"><span class="pill tag">${j.stage || j.kind}</span>
      <span class="mut" style="min-width:52px">#${j.id}</span>${pill(j.status)}
      <div class="bar"><i style="width:${j.total ? Math.round(100 * j.progress / j.total) : (j.status === 'done' ? 100 : 6)}%"></i></div>
      <span class="mut" style="font-size:12px">${esc(j.message || '')}</span></div>`).join('');
  refreshGates();
  const t = document.querySelector('.nav button.active')?.dataset.tab;
  if (t === 'novel') loadNovel();
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
    // 1) 先渲染 S2 分格产物（出图的依据），让主人直观看到分出来的版式和格子
    await renderWorkbenchPages();

    // 2) 再渲染逐格提示词出图卡片
    const prompts = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt`);
    if (!prompts.length) {
      box.innerHTML = '<div class="card"><div class="empty">还没有提示词产物（先跑 S2 分页分格、S3 提示词）</div></div>';
      $('#wb-info').textContent = '0 格';
      return;
    }
    let loraOpts = [];
    try { const r = await api('/api/comfy/assets'); loraOpts = r.loras || []; } catch { /* ComfyUI 未启动 */ }

    box.innerHTML = prompts.map((p) => {
      const pl = p.payload || {}; const l0 = (pl.loras || [])[0] || {};
      return `<div class="card" data-ref="${esc(p.ref)}" style="margin-bottom:12px;padding:16px">
        <div class="row"><b>${esc(p.ref)}</b> ${pill(p.status)}
          <div class="spacer"></div>
          <label class="fld" style="margin:0">张数</label>
          <input class="wb-count" type="number" value="${$('#wb-count').value}" min="1" max="8" style="width:66px">
          <button class="sm wb-save">保存</button><button class="primary sm wb-gen">出图</button></div>
        <div class="grid2" style="margin-top:10px">
          <div><label class="fld">正向</label><textarea class="wb-pos">${esc(pl.prompt_pos || '')}</textarea></div>
          <div><label class="fld">负向</label><textarea class="wb-neg">${esc(pl.prompt_neg || '')}</textarea></div>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="fld" style="margin:0"><input type="checkbox" class="wb-uselora" style="width:auto" ${(pl.loras || []).length ? 'checked' : ''}> 用 LoRA</label>
          <input class="wb-lora" placeholder="lora 文件名" value="${esc(l0.name || '')}" list="lora-list" style="max-width:280px">
          <label class="fld" style="margin:0">权重</label>
          <input class="wb-loraw" type="number" step="0.05" value="${l0.weight ?? 0.8}" style="width:80px">
        </div>
        <div class="wb-cands" style="margin-top:12px"></div></div>`;
    }).join('');
    const old = document.getElementById('lora-list'); if (old) old.remove();
    const dl = document.createElement('datalist'); dl.id = 'lora-list';
    dl.innerHTML = loraOpts.map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);
    $('#wb-info').textContent = `${prompts.length} 格`;
    bindWorkbench(prompts);
    for (const p of prompts) await renderWbCands(p);
  } catch (e) { toast(e.message, 'err'); }
}

/** 渲染 S2 分格产物：每页一张卡（真版式缩略图 + 每格摘要 + 出图进度）。 */
async function renderWorkbenchPages() {
  const box = $('#wb-pages');
  const d = await api(`/api/projects/${state.projectId}/pages`);
  const pages = d.pages || [];
  $('#wb-pages-info').textContent = `${pages.length} 页 · 目标 ${d.target_pages} 页`;
  if (!pages.length) {
    box.innerHTML = '<div class="empty">还没有分好的页。去「分格」页加一页或让 AI 选版式。</div>';
    return;
  }
  // 每页已有候选图数量（按 ref 前缀 panel:page. → 不好统计，改用 S3 提示词数）
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
    ${pages.map((p) => `
      <div class="mini-card" style="padding:12px" data-wbpage="${esc(p.page_ref)}">
        <div class="row" style="gap:8px">
          <div class="tplthumb-sm" title="${esc(p.template_id || '')}">
            ${p.template_id ? `<img src="/api/templates/${encodeURIComponent(p.template_id)}/svg" alt="">` : ''}
          </div>
          <div>
            <div class="row" style="gap:6px"><b>${esc(p.page_ref)}</b> ${pill(p.status)}
              <span class="pill tag">${p.panels.length} 格</span></div>
            <div class="mut" style="font-size:11.5px">${esc(p.template_id || '')}</div>
            <div class="mut" style="font-size:11.5px" data-tpldesc="${esc(p.page_ref)}"></div>
          </div>
          <div class="spacer"></div>
          <button class="sm" data-wbpick="${esc(p.page_ref)}">看这页候选图</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px;margin-top:10px">
          ${p.panels.map((x) => `<div class="mini-card" style="padding:6px 8px">
            <div class="mut" style="font-size:11px">第 ${x.panel_order} 格 · ${esc(x.shot || '')}</div>
            <div style="font-size:11.5px;margin-top:2px">${esc((x.action || x.scene_desc || '（空）').slice(0, 24))}</div>
          </div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
  // 补齐版式文字描述
  for (const p of pages) {
    const el = box.querySelector(`[data-tpldesc="${CSS.escape(p.page_ref)}"]`);
    if (!el || !p.template_id) continue;
    const t = (d.templates || []).find((x) => x.id === p.template_id);
    if (t) el.textContent = t.layout_desc || '';
  }
  box.querySelectorAll('[data-wbpick]').forEach((b) => b.addEventListener('click', () => {
    const el = document.querySelector(`#wb-list .card[data-ref^="${CSS.escape(b.dataset.wbpick.replace('page:', 'panel:'))}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.boxShadow = '0 0 0 3px var(--accent)'; setTimeout(() => { el.style.boxShadow = ''; }, 1400); }
    else toast('这页还没有对应的分镜提示词（先跑 S3）');
  }));
}


function bindWorkbench(prompts) {
  $$('#wb-list .card').forEach((card) => {
    const ref = card.dataset.ref;
    const art = prompts.find((p) => p.ref === ref);
    card.querySelector('.wb-save').addEventListener('click', async () => {
      const useLora = card.querySelector('.wb-uselora').checked;
      const lname = card.querySelector('.wb-lora').value.trim();
      const lw = +card.querySelector('.wb-loraw').value;
      await api(`/api/artifacts/${art.id}/payload`, { method: 'PATCH', body: JSON.stringify({
        prompt_pos: card.querySelector('.wb-pos').value, prompt_neg: card.querySelector('.wb-neg').value,
        loras: useLora && lname ? [{ name: lname, weight: lw }] : [] }) });
      toast(`${ref} 已保存（下游需重跑）`, 'ok'); refreshGates();
    });
    card.querySelector('.wb-gen').addEventListener('click', async () => {
      const count = +card.querySelector('.wb-count').value || 4;
      const r = await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/generate`, { method: 'POST', body: JSON.stringify({ count }) });
      toast(`${ref} 出图已入队 #${r.job_id}（${count} 张）`);
    });
  });
}

async function renderWbCands(pa) {
  const card = document.querySelector(`#wb-list .card[data-ref="${CSS.escape(pa.ref)}"]`);
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
      ${rows.map((r) => `<tr><td>${esc(r.ref)}</td><td>v${r.version}</td><td>${pill(r.status)}</td>
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
async function openComfySettings() {
  let cfg, wfs;
  try {
    [cfg, wfs] = await Promise.all([api('/api/comfy/config'), api('/api/comfy/workflows')]);
  } catch (e) { return toast(e.message, 'err'); }
  const wp = (cfg.default_params || {});

  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="box" style="width:min(980px,95vw)">
    <h3>出图设置 <span class="mut" style="font-size:12px;font-weight:400">仙宫云连接 · 工作流 · 参数 · LoRA</span></h3>

    <div class="divider"></div>
    <div><b>① 连接</b>
      <span class="mut" style="font-size:12px">　用哪台出图后端</span></div>
    <div class="row" style="margin-top:8px">
      <label class="fld" style="margin:0">后端</label>
      <select id="cs-backend" style="width:150px">
        <option value="cloud" ${cfg.backend === 'cloud' ? 'selected' : ''}>仙宫云</option>
        <option value="local" ${cfg.backend === 'local' ? 'selected' : ''}>本机 ComfyUI</option>
      </select>
      <span class="pill" id="cs-cloud-pill"><i class="dotm"></i>仙宫云 …</span>
      <span class="pill" id="cs-local-pill"><i class="dotm"></i>本机 …</span>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div><label class="fld">仙宫云地址（ComfyUI 的网址）</label>
        <input id="cs-cloud" placeholder="https://xxxx.xiangongyun.com" value="${esc(cfg.cloud_url || '')}"></div>
      <div><label class="fld">API Key（需要鉴权才填；留空=不改）</label>
        <input id="cs-key" type="password" placeholder="${cfg.has_api_key ? '已保存（留空不改）' : '通常不需要'}" value=""></div>
      <div><label class="fld">本机 ComfyUI 地址（备用调试）</label>
        <input id="cs-local" value="${esc(cfg.local_url || '')}"></div>
      <div></div>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="sm" id="cs-save-conn">保存连接</button>
      <button class="sm" id="cs-ping">测试连通</button>
      <span class="mut" id="cs-conn-msg" style="font-size:12px"></span>
    </div>

    <div class="divider"></div>
    <div><b>② 工作流</b>
      <span class="mut" style="font-size:12px">　选一个作为出图流程（API 格式；UI 格式会自动转）</span></div>
    <div class="row" style="margin-top:8px">
      <select id="cs-wf" style="min-width:280px">
        ${(cfg.workflows || []).length
          ? (cfg.workflows || []).map((n) => `<option value="${esc(n)}" ${n === cfg.workflow_name ? 'selected' : ''}>${esc(n)}${n === cfg.workflow_name ? '（当前）' : ''}</option>`).join('')
          : '<option value="">（还没有工作流，先导入）</option>'}
      </select>
      <button class="sm primary" id="cs-wf-use">设为当前</button>
      <button class="sm" id="cs-wf-guess">自动映射参数</button>
      <button class="sm" id="cs-wf-del">删除</button>
    </div>
    <div class="row" style="margin-top:8px">
      <input id="cs-wf-name" placeholder="新工作流名字，如 anima_t2i" style="min-width:200px">
      <label class="fld" style="margin:0;display:inline-flex;align-items:center;gap:6px">
        <input type="file" id="cs-wf-file" accept=".json,.txt" style="width:auto"> 选文件</label>
      <button class="sm" id="cs-wf-import">导入</button>
    </div>
    <div class="mut" style="font-size:12px;margin-top:4px">也支持粘贴：直接在下框贴完整 JSON 再点导入。</div>
    <textarea id="cs-wf-json" placeholder='{"3":{"class_type":"KSampler",...}} 或 ComfyUI 的 UI 格式 JSON'
      style="min-height:70px;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-top:6px"></textarea>
    <div id="cs-wf-info" class="mut" style="font-size:12px;margin-top:6px"></div>

    <div class="divider"></div>
    <div><b>③ 参数</b>
      <span class="mut" style="font-size:12px">　映射表（哪个参数写到工作流哪个节点）；一般「自动映射」就够了</span></div>
    <div class="grid2" style="margin-top:8px">
      <div><label class="fld">步数 steps</label><input id="cs-steps" type="number" value="${wp.steps ?? 26}"></div>
      <div><label class="fld">CFG</label><input id="cs-cfg" type="number" step="0.5" value="${wp.cfg ?? 6}"></div>
      <div><label class="fld">采样器 sampler</label><input id="cs-sampler" value="${esc(wp.sampler || 'euler')}"></div>
      <div><label class="fld">scheduler</label><input id="cs-sched" value="${esc(wp.scheduler || 'karras')}"></div>
      <div><label class="fld">宽 width</label><input id="cs-w" type="number" value="${wp.width ?? 832}"></div>
      <div><label class="fld">高 height</label><input id="cs-h" type="number" value="${wp.height ?? 1216}"></div>
      <div><label class="fld">checkpoint（可留空用工作流里的）</label><input id="cs-ckpt" value="${esc(wp.ckpt_name || '')}"></div>
      <div><label class="fld">出图后端 LoRA 列表（拉取后可选）</label>
        <select id="cs-lora-list"><option value="">（点右侧拉取）</option></select></div>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="sm" id="cs-save-params">保存参数</button>
      <button class="sm" id="cs-pull-loras">拉取 LoRA 列表</button>
      <span class="mut" id="cs-params-msg" style="font-size:12px"></span>
    </div>
    <pre id="cs-mapping" class="mut" style="font-size:11px;max-height:150px;overflow:auto;margin-top:8px"></pre>

    <div class="divider"></div>
    <div><b>④ 试跑一张</b>
      <span class="mut" style="font-size:12px">　验证连接+工作流+参数+LoRA 是否通（会真的出 1 张图）</span></div>
    <div class="grid2" style="margin-top:8px">
      <div><label class="fld">正向提示词</label>
        <textarea id="cs-t-pos" style="min-height:60px">1girl, solo, masterpiece, best quality</textarea></div>
      <div><label class="fld">负向提示词</label>
        <textarea id="cs-t-neg" style="min-height:60px">worst quality, low quality</textarea></div>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="sm primary" id="cs-test">试跑</button>
      <span class="mut" id="cs-test-msg" style="font-size:12px"></span>
    </div>
    <div id="cs-test-out" style="margin-top:10px"></div>

    <div class="row" style="margin-top:16px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button></div>
  </div>`;
  document.body.appendChild(box);
  box.querySelector('[data-close]').addEventListener('click', () => box.remove());
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

  // 连通状态异步补上（探测后端比较慢，不阻塞弹窗出现）
  api('/api/comfy/status').then((st) => {
    const setPill = (sel, ok, label) => {
      const el = box.querySelector(sel); if (!el) return;
      el.className = 'pill ' + (ok ? 'ok' : 'err');
      el.innerHTML = `<i class="dotm"></i>${label} ${ok ? '在线' : '未连上'}`;
    };
    setPill('#cs-cloud-pill', !!(st.cloud && st.cloud.reachable), '仙宫云');
    setPill('#cs-local-pill', !!(st.local && st.local.reachable), '本机');
  }).catch(() => {});

  const wfInfo = () => {
    const name = $('#cs-wf').value;
    const item = (wfs.workflows || []).find((x) => x.name === name);
    $('#cs-wf-info').innerHTML = item
      ? `节点 ${item.node_count} 个 · ${item.api_format ? 'API 格式' : '非 API 格式'} · 提示词占位符 ${item.prompt_placeholder || '无（按字段映射）'} · LoRA 方式 ${esc(item.lora_mode || '无')}`
      : '';
    return name;
  };
  const loadMapping = async (name) => {
    if (!name) { $('#cs-mapping').textContent = ''; return; }
    try { const m = await api(`/api/comfy/workflows/${encodeURIComponent(name)}/mapping`);
      $('#cs-mapping').textContent = '参数映射：' + JSON.stringify(m.bindings || {}, null, 0); }
    catch { $('#cs-mapping').textContent = ''; }
  };
  wfInfo(); loadMapping($('#cs-wf').value);
  $('#cs-wf').addEventListener('change', () => { wfInfo(); loadMapping($('#cs-wf').value); });

  $('#cs-save-conn').addEventListener('click', async () => {
    try {
      await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({
        backend: $('#cs-backend').value, cloud_url: $('#cs-cloud').value.trim(),
        cloud_api_key: $('#cs-key').value, local_url: $('#cs-local').value.trim() }) });
      $('#cs-conn-msg').textContent = '已保存'; toast('连接配置已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#cs-ping').addEventListener('click', async () => {
    // 先存再测，避免测的是旧地址
    try {
      await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({
        backend: $('#cs-backend').value, cloud_url: $('#cs-cloud').value.trim(),
        cloud_api_key: $('#cs-key').value, local_url: $('#cs-local').value.trim() }) });
    } catch { /* ignore */ }
    $('#cs-conn-msg').textContent = '测试中…';
    try {
      const r = await api('/api/comfy/status');
      const reach = $('#cs-backend').value === 'local' ? r.local.reachable : r.cloud.reachable;
      $('#cs-conn-msg').textContent = reach ? '连通 ✅' : '连不上（检查地址/隧道）';
    } catch (e) { $('#cs-conn-msg').textContent = e.message; }
  });

  $('#cs-wf-use').addEventListener('click', async () => {
    const name = $('#cs-wf').value; if (!name) return toast('先选一个工作流', 'err');
    try { await api(`/api/comfy/workflows/${encodeURIComponent(name)}/activate`, { method: 'POST' });
      toast(`已设为当前：${name}`, 'ok'); loadMapping(name); } catch (e) { toast(e.message, 'err'); }
  });
  $('#cs-wf-guess').addEventListener('click', async () => {
    const name = $('#cs-wf').value; if (!name) return toast('先选一个工作流', 'err');
    try { await api(`/api/comfy/workflows/${encodeURIComponent(name)}/mapping/guess`, { method: 'POST' });
      toast('已自动映射参数', 'ok'); loadMapping(name); } catch (e) { toast(e.message, 'err'); }
  });
  $('#cs-wf-del').addEventListener('click', async () => {
    const name = $('#cs-wf').value; if (!name) return;
    if (!confirm(`删除工作流「${name}」？`)) return;
    try { await api(`/api/comfy/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('已删除', 'ok'); box.remove(); openComfySettings(); } catch (e) { toast(e.message, 'err'); }
  });
  $('#cs-wf-import').addEventListener('click', async () => {
    const name = $('#cs-wf-name').value.trim();
    if (!name) return toast('先给工作流起个名字', 'err');
    let wf = null;
    const f = $('#cs-wf-file').files[0];
    try {
      if (f) wf = await f.text();
      else if ($('#cs-wf-json').value.trim()) wf = $('#cs-wf-json').value.trim();
      else return toast('选文件或粘贴 JSON', 'err');
      $('#cs-wf-info').textContent = '导入中（UI 格式需要向后端拉节点定义，稍等）…';
      const r = await api('/api/comfy/workflows', { method: 'POST', body: JSON.stringify({ name, workflow: wf }) });
      toast(`已导入：${name}`, 'ok');
      if (r.warnings && r.warnings.length) toast('提示：' + r.warnings.join('；'), 'err');
      box.remove(); openComfySettings();
    } catch (e) { toast('导入失败：' + e.message, 'err'); $('#cs-wf-info').textContent = ''; }
  });

  const paramsPayload = () => ({
    steps: +$('#cs-steps').value || null, cfg: +$('#cs-cfg').value || null,
    sampler: $('#cs-sampler').value.trim() || null, scheduler: $('#cs-sched').value.trim() || null,
    width: +$('#cs-w').value || null, height: +$('#cs-h').value || null,
    ckpt_name: $('#cs-ckpt').value.trim() || null,
  });
  $('#cs-save-params').addEventListener('click', async () => {
    try { await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({ default_params: paramsPayload() }) });
      $('#cs-params-msg').textContent = '已保存'; toast('出图参数已保存', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });
  $('#cs-pull-loras').addEventListener('click', async () => {
    $('#cs-params-msg').textContent = '拉取中…';
    try {
      const r = await api('/api/comfy/assets?backend=' + $('#cs-backend').value);
      $('#cs-lora-list').innerHTML = (r.loras || []).map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('') || '<option value="">（这台后端没读到 LoRA）</option>';
      $('#cs-params-msg').textContent = `LoRA ${r.loras.length} · ckpt ${r.checkpoints.length}`;
    } catch (e) { $('#cs-params-msg').textContent = '失败：' + e.message; }
  });
  $('#cs-test').addEventListener('click', async () => {
    // 试跑前先把参数存下来，保证用的就是界面上填的
    try { await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({ default_params: paramsPayload() }) }); } catch { /* ignore */ }
    $('#cs-test-msg').textContent = '出图中…（可能要几十秒）';
    try {
      const r = await api('/api/comfy/test-run', { method: 'POST', body: JSON.stringify({
        prompt_pos: $('#cs-t-pos').value, prompt_neg: $('#cs-t-neg').value, params: paramsPayload() }) });
      $('#cs-test-msg').textContent = '完成';
      $('#cs-test-out').innerHTML = `<img src="${r.url}" style="max-width:100%;border-radius:10px;border:1px solid var(--line2)">`;
    } catch (e) { $('#cs-test-msg').textContent = ''; toast('试跑失败：' + e.message, 'err'); }
  });
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
  await loadProjects();
  // 不再自动选中项目：进入「项目」页显示列表，点某个项目才看详情（二级页面）
  showProjectView('list');
  startJobsSSE();
  startTavernSSE();
  setInterval(refreshGates, 5000);
})();
