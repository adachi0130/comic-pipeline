/* 自研前端逻辑（原生 ES module，无构建）。 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const API = '';

let state = { projectId: null, templates: [], techniques: [] };

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const statusPill = (s) => {
  const map = { approved: ['ok', '已通过'], review: ['warn', '待审查'], rejected: ['err', '已驳回'],
    stale: ['stale', '需重跑'], running: ['run', '生成中'], pending: ['', '待生成'],
    done: ['ok', '完成'], failed: ['err', '失败'], queued: ['', '排队中'], cancelled: ['', '已取消'] };
  const [cls, label] = map[s] || ['', s || '—'];
  return `<span class="pill ${cls}">${label}</span>`;
};

// ---------- 出图工作台 ----------
$('#wb-reload').addEventListener('click', loadWorkbench);

async function loadWorkbench() {
  if (!state.projectId) return toast('先选择项目', 'err');
  const box = $('#wb-list');
  try {
    const prompts = await api(`/api/projects/${state.projectId}/artifacts?kind=panel_prompt`);
    if (!prompts.length) { box.innerHTML = '<div class="empty">还没有 S4 提示词产物（先跑 S3、S4）</div>'; $('#wb-info').textContent = '0 格'; return; }
    // 拉取可用 LoRA 列表（失败不阻塞）
    let loraOpts = '';
    try { const r = await api('/api/comfy/assets?backend=cloud'); loraOpts = (r.loras || []).join('\n'); } catch { /* ComfyUI 未启动 */ }

    box.innerHTML = prompts.map((p) => `
      <div class="card" data-ref="${esc(p.ref)}" style="margin-bottom:12px">
        <div class="row"><b>${esc(p.ref)}</b> ${statusPill(p.status)}
          <div class="spacer"></div>
          <label class="mut" style="font-size:12px">张数</label>
          <input class="wb-count" type="number" value="${$('#wb-count').value}" min="1" max="8" style="width:64px">
          <button class="sm wb-save">保存提示词</button>
          <button class="primary sm wb-gen">出图</button>
        </div>
        <div style="margin-top:8px"><label class="mut">正向</label>
          <textarea class="wb-pos">${esc((p.payload || {}).prompt_pos || '')}</textarea></div>
        <div style="margin-top:6px"><label class="mut">负向</label>
          <textarea class="wb-neg">${esc((p.payload || {}).prompt_neg || '')}</textarea></div>
        <div class="row" style="margin-top:6px"><label class="mut" style="font-size:12px">
            <input type="checkbox" class="wb-uselora" style="width:auto" ${(p.payload || {}).loras?.length ? 'checked' : ''}> 使用 LoRA</label>
          <input class="wb-lora" placeholder="lora 文件名" value="${esc(((p.payload || {}).loras || [{}])[0].name || '')}" list="lora-list">
          <label class="mut" style="font-size:12px">权重</label>
          <input class="wb-loraw" type="number" step="0.05" value="${((p.payload || {}).loras || [{}])[0].weight ?? 0.8}" style="width:74px">
        </div>
        <div class="wb-cands" style="margin-top:10px"></div>
      </div>`).join('');
    // 全局 datalist（LoRA 候选）
    const dl = document.createElement('datalist'); dl.id = 'lora-list';
    dl.innerHTML = loraOpts.split('\n').filter(Boolean).map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);
    $('#wb-info').textContent = `${prompts.length} 格`;
    bindWorkbench(prompts);
    for (const p of prompts) await renderWbCands(p);
  } catch (e) { toast(e.message, 'err'); }
}

function bindWorkbench(prompts) {
  $$('#wb-list .card').forEach((card) => {
    const ref = card.dataset.ref;
    card.querySelector('.wb-save').addEventListener('click', async () => {
      const pos = card.querySelector('.wb-pos').value;
      const neg = card.querySelector('.wb-neg').value;
      const useLora = card.querySelector('.wb-uselora').checked;
      const lname = card.querySelector('.wb-lora').value.trim();
      const lw = +card.querySelector('.wb-loraw').value;
      const art = prompts.find((p) => p.ref === ref);
      // 写一个新版本提示词产物（触发下游失效传播）
      await api(`/api/artifacts/${art.id}/payload`, { method: 'PATCH', body: JSON.stringify({
        prompt_pos: pos, prompt_neg: neg,
        loras: useLora && lname ? [{ name: lname, weight: lw }] : [] }) });
      toast(`${ref} 提示词已保存（下游标记需重跑）`, 'ok'); refreshGates();
    });
    card.querySelector('.wb-gen').addEventListener('click', async () => {
      const count = +card.querySelector('.wb-count').value || 4;
      const r = await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/generate`,
        { method: 'POST', body: JSON.stringify({ count }) });
      toast(`${ref} 出图已入队 #${r.job_id}（${count} 张）`);
    });
  });
}

async function renderWbCands(promptArt) {
  const card = document.querySelector(`#wb-list .card[data-ref="${CSS.escape(promptArt.ref)}"]`);
  if (!card) return;
  const box = card.querySelector('.wb-cands');
  const imgs = await api(`/api/projects/${state.projectId}/artifacts?kind=image&ref_prefix=${encodeURIComponent(promptArt.ref)}`);
  if (!imgs.length) { box.innerHTML = '<div class="empty" style="font-size:12px">还没有候选图，点“出图”</div>'; return; }
  const a = await api('/api/artifacts/' + imgs[0].id);
  const cands = (a.payload && a.payload.candidates) || [];
  const sel = a.payload && a.payload.selected_index;
  box.innerHTML = `<div class="candgrid">${cands.map((c, i) => `
    <div class="cand ${i === sel ? 'sel' : ''}" data-art="${a.id}" data-idx="${i}">
      <img src="/api/artifacts/${a.id}/candidate/${i}" loading="lazy">
      <div class="lbl"><span>#${i + 1}</span>${i === sel ? '<span style="color:var(--ok)">已选</span>' : ''}</div>
    </div>`).join('')}</div>`;
  box.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/artifacts/${el.dataset.art}/select`, { method: 'POST', body: JSON.stringify({ index: +el.dataset.idx }) });
    toast('已采用', 'ok'); renderWbCands(promptArt); refreshGates();
  }));
}

// ---------- Tab ----------
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('.nav button[data-tab]').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const tab = b.dataset.tab;
  ['projects', 'pipeline', 'workbench', 'candidates', 'settings'].forEach((t) =>
    $('#tab-' + t).classList.toggle('hidden', t !== tab));
  const titles = { projects: ['项目', '选择或新建一部漫画'], pipeline: ['流水线 S1–S7', '按阶段推进，每阶段后可审查'],
    workbench: ['出图工作台', '逐格改词 / 勾选 LoRA / 调批量张数 / 挑图'],
    candidates: ['候选图 / 审查', '人工挑图；自动模式取首张'], settings: ['设置', 'LLM 供应商 / ComfyUI / 阶段绑定'] };
  $('#view-title').textContent = titles[tab][0];
  $('#view-sub').textContent = titles[tab][1];
  if (tab === 'settings') { loadProviders(); loadStageBinding(); }
  if (tab === 'workbench') loadWorkbench();
}));

// ---------- 健康 ----------
async function checkHealth() {
  try { await api('/api/health'); $('#health').textContent = '后端：在线'; $('#health').className = 'pill ok'; }
  catch { $('#health').textContent = '后端：离线'; $('#health').className = 'pill err'; }
}

// ---------- 项目 ----------
async function loadProjects() {
  const rows = await api('/api/projects');
  const box = $('#plist');
  if (!rows.length) { box.innerHTML = '<div class="empty">还没有项目</div>'; return; }
  box.innerHTML = rows.map((p) => `
    <div class="pitem"><div><b>${esc(p.title)}</b>
      <div class="meta">${p.target_pages} 页 · ${p.review_mode === 'auto' ? '全自动' : '人工审查'}</div></div>
      <div class="spacer"></div>
      <button class="sm" data-pick="${p.id}">打开</button></div>`).join('');
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => pickProject(+b.dataset.pick)));
  if (!state.projectId && rows.length) pickProject(rows[0].id);
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function pickProject(id) {
  state.projectId = id;
  const p = await api('/api/projects/' + id);
  $('#cur-proj').innerHTML = `<b>${esc(p.title)}</b><br><span class="mut">${p.target_pages} 页</span>`;
  $('#automode').checked = p.review_mode === 'auto';
  refreshGates();
}

$('#btn-new').addEventListener('click', async () => {
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({
      title: $('#np-title').value || '未命名漫画',
      outline: $('#np-outline').value,
      target_pages: +$('#np-pages').value || 16,
    }) });
    toast('项目已创建', 'ok'); $('#np-title').value = ''; $('#np-outline').value = '';
    await loadProjects(); pickProject(p.id);
  } catch (e) { toast('创建失败：' + e.message, 'err'); }
});

// ---------- 全自动开关 ----------
$('#automode').addEventListener('change', async () => {
  if (!state.projectId) { toast('先选择项目', 'err'); $('#automode').checked = false; return; }
  try {
    await api(`/api/projects/${state.projectId}/review-mode`, { method: 'PATCH',
      body: JSON.stringify({ mode: $('#automode').checked ? 'auto' : 'manual' }) });
    toast($('#automode').checked ? '已切到全自动（门自动通过）' : '已切到人工审查', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- 阶段运行 ----------
function bindRun(btn, fn) { $(btn).addEventListener('click', async () => {
  if (!state.projectId) return toast('先选择项目', 'err');
  try { await fn(); } catch (e) { toast(e.message, 'err'); }
});}

bindRun('#run-S1', async () => { const r = await api(`/api/projects/${state.projectId}/run/S1`, { method: 'POST', body: '{}' }); toast(`S1 已入队 #${r.job_id}`); });
bindRun('#run-S2', async () => { const r = await api(`/api/projects/${state.projectId}/prose/request`, { method: 'POST',
  body: JSON.stringify({ scene_id: +$('#s2-scene').value, instruction: $('#s2-instr').value }) });
  toast(`已请求酒馆生成 #${r.job_id}（需酒馆标签页打开）`); });
bindRun('#run-S3', async () => { const r = await api(`/api/projects/${state.projectId}/run/S3`, { method: 'POST',
  body: JSON.stringify({ scene_id: +$('#s3-scene').value, page_budget: +$('#s3-budget').value }) });
  toast(`S3 已入队 #${r.job_id}`); });
bindRun('#run-S4', async () => { const r = await api(`/api/projects/${state.projectId}/run/S4`, { method: 'POST',
  body: JSON.stringify({ page_ref: $('#s4-page').value }) });
  toast(`S4 已入队 #${r.job_id}`); });
bindRun('#run-S5', async () => {
  const ref = $('#s5-panel').value; if (!ref) return toast('请填格 ref，如 panel:1.1', 'err');
  const r = await api(`/api/projects/${state.projectId}/panels/${encodeURIComponent(ref)}/generate`, { method: 'POST',
    body: JSON.stringify({ count: +$('#s5-count').value, params: {} }) });
  toast(`S5 出图已入队 #${r.job_id}`); });
bindRun('#run-S6', async () => {
  const ref = $('#s6-page').value; if (!ref) return toast('请填页 ref，如 page:1', 'err');
  const r = await api(`/api/projects/${state.projectId}/run/S6`, { method: 'POST', body: JSON.stringify({ page_ref: ref }) });
  toast(`S6 合成已入队 #${r.job_id}`); });

// ---------- 门状态 ----------
async function refreshGates() {
  if (!state.projectId) return;
  try {
    const g = await api(`/api/projects/${state.projectId}/gates`);
    for (const [stage, key] of [['S1', 'structure'], ['S3', 'page_script'], ['S4', 'panel_prompt'], ['S5', 'image'], ['S6', 'page_image']]) {
      const el = $('#st-' + stage); if (!el) continue;
      const s = g.stages[stage] || {};
      const total = s.count || 0;
      const cls = total === 0 ? '' : (s.review ? 'warn' : s.stale ? 'stale' : 'ok');
      const label = total === 0 ? '未开始' : `${s.approved}/${total} 通过${s.review ? ` · ${s.review} 待审` : ''}${s.stale ? ` · ${s.stale} 需重跑` : ''}`;
      el.className = 'pill ' + cls; el.textContent = label;
    }
  } catch { /* 忽略 */ }
}

// ---------- 作业 SSE ----------
function startJobsSSE() {
  const src = new EventSource(API + '/api/jobs/events' + (state.projectId ? `?project_id=${state.projectId}` : ''));
  src.onmessage = (ev) => {
    try { renderJobs(JSON.parse(ev.data)); } catch { /* keep-alive */ }
  };
  src.onerror = () => { /* 自动重连 */ };
}
function renderJobs(jobs) {
  const box = $('#jobs');
  if (!jobs.length) { box.innerHTML = '<div class="empty">暂无作业</div>'; return; }
  box.innerHTML = jobs.slice(0, 12).map((j) => `
    <div class="job"><span class="pill">${j.stage || j.kind}</span>
      <span class="mut" style="min-width:64px">#${j.id}</span>
      ${statusPill(j.status)}
      <div class="bar"><i style="width:${j.total ? Math.round(100 * j.progress / j.total) : (j.status === 'done' ? 100 : 8)}%"></i></div>
      <span class="mut" style="font-size:12px">${esc(j.message || '')}</span></div>`).join('');
  refreshGates();
}

// ---------- 候选图 / 审查 ----------
$('#reload-art').addEventListener('click', loadArtifacts);
async function loadArtifacts() {
  if (!state.projectId) return toast('先选择项目', 'err');
  const kind = $('#art-kind').value;
  const rows = await api(`/api/projects/${state.projectId}/artifacts?kind=${kind}`);
  const box = $('#artbox');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无产物</div>'; return; }
  if (kind === 'image') {
    box.innerHTML = rows.map((r) => candBlock(r)).join('');
    for (const r of rows) { await fillCandidates(r.id); }
  } else {
    box.innerHTML = `<table><thead><tr><th>ref</th><th>版本</th><th>状态</th><th>操作</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${esc(r.ref)}</td><td>v${r.version}</td><td>${statusPill(r.status)}</td>
        <td><button class="sm" data-detail="${r.id}">详情</button>
        <button class="sm" data-approve="${r.id}">通过</button>
        <button class="sm" data-reject="${r.id}">驳回</button></td></tr>`).join('') + '</tbody></table>';
    bindArtActions();
  }
}
function candBlock(r) {
  return `<div style="margin-bottom:16px"><div class="row" style="margin-bottom:6px">
    <b>${esc(r.ref)}</b> v${r.version} ${statusPill(r.status)}
    <div class="spacer"></div>
    <button class="sm" data-detail="${r.id}">详情</button></div>
    <div class="candgrid" id="cand-${r.id}"><div class="empty">加载候选…</div></div></div>`;
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
      <img src="/api/artifacts/${id}/candidate/${i}" alt="候选 ${i + 1}" loading="lazy">
      <div class="lbl"><span>#${i + 1}</span>${i === sel ? '<span style="color:var(--ok)">已选</span>' : ''}</div>
    </div>`).join('');
  box.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/artifacts/${el.dataset.art}/select`, { method: 'POST', body: JSON.stringify({ index: +el.dataset.idx }) });
    toast('已采用该候选', 'ok'); loadArtifacts();
  }));
}
function bindArtActions() {
  $$('[data-detail]').forEach((b) => b.addEventListener('click', async () => {
    const a = await api('/api/artifacts/' + b.dataset.detail);
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(a.payload, null, 2);
    $('#artbox').appendChild(pre);
  }));
  $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/artifacts/${b.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });
    toast('已通过', 'ok'); loadArtifacts();
  }));
  $$('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const comment = prompt('驳回批注（会随任务回流重跑）：') || '';
    await api(`/api/artifacts/${b.dataset.reject}/review`, { method: 'POST', body: JSON.stringify({ verdict: 'reject', comment }) });
    toast('已驳回', 'ok'); loadArtifacts();
  }));
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
      name: $('#pv-name').value, base_url: $('#pv-url').value,
      model: $('#pv-model').value, api_key: $('#pv-key').value }) });
    toast('供应商已添加', 'ok'); loadProviders(); loadStageBinding();
  } catch (e) { toast(e.message, 'err'); }
});
$('#btn-reloadpv').addEventListener('click', loadProviders);

async function loadStageBinding() {
  const providers = await api('/api/providers');
  const opts = providers.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.model)}</option>`).join('');
  $('#stagelist').innerHTML = ['S1', 'S3', 'S4'].map((s) =>
    `<div><label class="mut">${s}</label>
      <select data-stage="${s}" class="stage-bind">${providers.length ? opts : '<option value="">（先添加供应商）</option>'}</select></div>`).join('');
  $$('.stage-bind').forEach((sel) => sel.addEventListener('change', async () => {
    if (!sel.value) return;
    await api(`/api/projects/${state.projectId || 0}/stage-models`, { method: 'PATCH', body: JSON.stringify({ [sel.dataset.stage]: +sel.value }) });
    toast(`${sel.dataset.stage} 已绑定`, 'ok');
  }));
}

$('#cf-assets').addEventListener('click', async () => {
  $('#cf-state').textContent = '拉取中…'; $('#cf-state').className = 'pill run';
  try {
    const r = await api('/api/comfy/assets?backend=' + $('#cf-backend').value);
    $('#cf-out').classList.remove('hidden');
    $('#cf-out').textContent = JSON.stringify({ loras: r.loras, checkpoints: r.checkpoints }, null, 2);
    $('#cf-state').textContent = `LoRA ${r.loras.length} · ckpt ${r.checkpoints.length}`;
    $('#cf-state').className = 'pill ok';
  } catch (e) { $('#cf-state').textContent = '失败：' + e.message; $('#cf-state').className = 'pill err'; }
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
  await loadProjects();
  const meta = await api('/api/meta');
  state.templates = meta.templates; state.techniques = meta.techniques;
  startJobsSSE();
  setInterval(refreshGates, 5000);
})();
