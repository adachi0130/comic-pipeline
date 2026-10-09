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
  settings: ['设置', 'LLM 供应商 / ComfyUI / 阶段绑定'],
};
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  $$('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['projects', 'novel', 'pipeline', 'images', 'settings'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
  $('#view-title').textContent = TITLES[tab][0];
  $('#view-sub').textContent = TITLES[tab][1];
  if (tab === 'novel') loadNovel();
  if (tab === 'pipeline') renderFlow().then(refreshGates);
  if (tab === 'images') loadWorkbench();
  if (tab === 'settings') { loadProviders(); loadStageBinding(); }
  if (tab === 'projects') { if (state.projectId) api('/api/projects/' + state.projectId).then((p) => { state.project = p; renderProjectDetail(); }); }
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

async function pickProject(id) {
  state.projectId = id;
  state.project = await api('/api/projects/' + id);
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
function renderProjectDetail() {
  const box = $('#proj-detail');
  if (!box) return;
  const p = state.project;
  if (!p) { box.innerHTML = '<div class="empty">未选择项目</div>'; return; }
  const g = state._gates || {};
  const rows = (state.meta?.stages || []).map((s) => {
    const x = g[s.id] || { count: 0, approved: 0, review: 0 };
    return `<tr><td><span class="pill tag">${s.id}</span> ${esc(s.name)}</td>
      <td>${x.count || 0}</td><td>${x.approved ? `<span class="pill ok"><i class="dotm"></i>${x.approved}</span>` : '—'}</td>
      <td>${x.review ? `<span class="pill warn"><i class="dotm"></i>${x.review}</span>` : '—'}</td>
      <td>${x.stale ? `<span class="pill stale"><i class="dotm"></i>${x.stale}</span>` : '—'}</td></tr>`;
  }).join('');
  box.innerHTML = `
    <div class="grid3" style="margin-bottom:14px">
      <div><div class="mut" style="font-size:12px">标题</div><b>${esc(p.title)}</b></div>
      <div><div class="mut" style="font-size:12px">目标页数</div><b>${p.target_pages}</b></div>
      <div><div class="mut" style="font-size:12px">审查模式</div><b>${p.review_mode === 'auto' ? '全自动' : '人工审查'}</b></div>
    </div>
    <div style="margin-bottom:14px"><div class="mut" style="font-size:12px">大纲</div>
      <div style="white-space:pre-wrap;line-height:1.8">${esc(p.outline || '（未填写）')}</div></div>
    <table><thead><tr><th>阶段</th><th>产物数</th><th>已通过</th><th>待审</th><th>需重跑</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

$('#btn-new').addEventListener('click', async () => {
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({
      title: $('#np-title').value || '未命名漫画', outline: $('#np-outline').value, target_pages: +$('#np-pages').value || 16 }) });
    toast('项目已创建', 'ok');
    $('#np-title').value = ''; $('#np-outline').value = '';
    await pickProject(p.id);
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
  renderChatList(d.chats || [], d.context || {});
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

  const msgs = (d.messages || []).filter((m) => !isNoise(m));
  state.chatLenNow = msgs.length;
  const lc = $('#tv-lastcount');
  if (lc) lc.textContent = state.chatLenAtSend != null
    ? `发送前 ${state.chatLenAtSend} 条 · 现在 ${msgs.length} 条`
    : `当前会话共 ${msgs.length} 条`;
  const box = $('#tv-chat');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
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
        <div class="segh"><b>第 ${s.index} 段</b> ${pill(s.status)}
          <span class="pill tag">${s.mode === 'continue' ? '续写' : s.mode === 'raw' ? '直发' : '起笔'}</span>
          <span class="mut" style="font-size:12px">${s.chars} 字</span>
          <div class="spacer"></div>
          <button class="sm" data-edit="${s.id}">编辑</button>
          <button class="sm" data-approve="${s.id}">通过</button>
          <button class="sm danger" data-reject="${s.id}">驳回</button>
        </div>
        ${bits.length ? `<div class="mut" style="font-size:12px;margin-bottom:6px">生成依据：${bits.join(' · ')}</div>` : ''}
        <div class="txt clip">${esc(s.text)}</div>
      </div>`;
    }).join('');
    bindSegments();

    // 全文
    $('#nv-fullmeta').textContent = `共 ${n.total_count} 段 · ${n.chars} 字`;
    $('#nv-full').innerHTML = n.text ? n.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('') : '<div class="empty">暂无全文</div>';
  } catch (e) { toast(e.message, 'err'); }
}

function bindSegments() {
  $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/artifacts/${b.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
    toast('该段已通过', 'ok'); loadNovel(); refreshGates();
  }));
  $$('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const comment = prompt('驳回批注（可留空）：') || '';
    await api(`/api/artifacts/${b.dataset.reject}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
    toast('该段已驳回，可编辑后重审', 'ok'); loadNovel(); refreshGates();
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

// ---------- 流水线 ----------
async function renderFlow() {
  const box = $('#flow');
  if (!state.projectId) { box.innerHTML = '<div class="empty">请先在「项目」页选择或新建一个项目</div>'; return; }
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
      </div></div>`;
  }).join('');
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => openStageArtifacts(b.dataset.view)));
  $$('[data-run]').forEach((b) => b.addEventListener('click', () => runStage(b.dataset.run)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.go)));
}

async function runStage(stage) {
  if (!state.projectId) return toast('先选择项目', 'err');
  try {
    const r = await api(`/api/projects/${state.projectId}/run/${stage}`, { method: 'POST', body: '{}' });
    toast(`${stage} 已入队 #${r.job_id}`);
  } catch (e) { toast(e.message, 'err'); }
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
        <td><button class="sm" data-open="${it.id}">详情</button></td></tr>`).join('')}
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
}

async function refreshGates() {
  if (!state.projectId) return;
  try {
    const g = await api(`/api/projects/${state.projectId}/gates`);
    state._gates = g.stages;
    renderProjectDetail();
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

async function loadWorkbench() {
  if (!state.projectId) { $('#wb-list').innerHTML = '<div class="empty">请先选择项目</div>'; return; }
  const box = $('#wb-list');
  try {
    const prompts = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt`);
    if (!prompts.length) { box.innerHTML = '<div class="empty">还没有提示词产物（先跑 S2 分页分格、S3 提示词）</div>'; $('#wb-info').textContent = '0 格'; return; }
    let loraOpts = [];
    try { const r = await api('/api/comfy/assets?backend=cloud'); loraOpts = r.loras || []; } catch { /* ComfyUI 未启动 */ }

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
    const dl = document.createElement('datalist'); dl.id = 'lora-list';
    dl.innerHTML = loraOpts.map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);
    $('#wb-info').textContent = `${prompts.length} 格`;
    bindWorkbench(prompts);
    for (const p of prompts) await renderWbCands(p);
  } catch (e) { toast(e.message, 'err'); }
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
    $('#cf-out').textContent = JSON.stringify({ loras: r.loras, checkpoints: r.checkpoints }, null, 2);
    $('#cf-state').className = 'pill ok'; $('#cf-state').innerHTML = `<i class="dotm"></i>LoRA ${r.loras.length} · ckpt ${r.checkpoints.length}`;
  } catch (e) { $('#cf-state').className = 'pill err'; $('#cf-state').innerHTML = '<i class="dotm"></i>失败'; toast(e.message, 'err'); }
});
$('#cf-guess').addEventListener('click', async () => {
  try { const r = await api('/api/comfy/mapping/guess', { method: 'POST' });
    $('#cf-out').classList.remove('hidden'); $('#cf-out').textContent = JSON.stringify(r, null, 2);
    toast('工作流参数已自动映射', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

// ---------- 启动 ----------
(async () => {
  await checkHealth();
  await ensureMeta();
  await loadProjects();
  // 自动选中第一个项目，这样一进来就能看到详情（不用手动点）
  if (!state.projectId) {
    const rows = await api('/api/projects');
    if (rows.length) await pickProject(rows[0].id);
  }
  startJobsSSE();
  startTavernSSE();
  setInterval(refreshGates, 5000);
})();
