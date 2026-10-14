export function createComfySettings({ api, $, esc, toast, editFeedback, onSaved }) {
let opening = false;
async function open() {
  if (opening || document.querySelector('.comfy-settings-window')) return;
  opening = true;
  let cfg;
  try {
    cfg = await api('/api/comfy/config');
  } catch (e) { return toast(e.message, 'err'); }
  finally { opening = false; }

  let currentLoras = [];
  let serverWorkflows = [];
  let connected = false;
  let inspectVersion = 0;
  let workflowDraft = null, busy = '';

  const box = document.createElement('div');
  box.className = 'modal comfy-settings-window';
  box.innerHTML = `<div class="box" style="width:min(1000px,95vw)">
    <h3>出图设置 <span class="mut" style="font-size:12px;font-weight:400">连上后端 → 选工作流 → 看参数 → 出图</span></h3>

    <div class="divider"></div>
    <div><b>① 连接</b>
      <span class="mut" style="font-size:12px">　点「连接」= 发一次请求，把后端的工作流与 LoRA 拉回来</span></div>
    <div class="row" id="cs-connection-fields" style="margin-top:8px">
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
      <button class="sm" id="cs-save-connection">保存连接</button>
      <span class="pill" id="cs-state">—</span>
    </div>
    <div id="cs-connection-save-state" class="save-feedback"></div>
    <div class="mut" id="cs-counts" style="font-size:12px;margin-top:6px"></div>

    <div class="divider"></div>
    <div class="row">
      <div><b>② 工作流</b>
        <span class="mut" style="font-size:12px">　从后端选择，或上传自己的 JSON</span></div>
      <div class="spacer"></div>
      <button class="sm" id="cs-upload" type="button">上传 JSON 工作流</button>
      <input id="cs-upload-file" type="file" accept=".json,application/json" hidden>
      <span class="mut" style="font-size:12px">当前：</span><span class="pill tag" id="cs-current">${esc(cfg.workflow_name || '（未选）')}</span>
    </div>
    <div class="mut" style="font-size:12px;margin-top:6px">在工作流正向文本中填写 <code>%prompt%</code>，负向文本中填写 <code>%negative%</code>；出图时替换为你输入的正负面，固定词保留。</div>
    <div id="cs-upload-msg" role="status" aria-live="polite" style="font-size:12px;margin-top:6px"></div>
    <div style="margin-top:8px"><label class="fld">已保存的工作流</label><div id="cs-local-wf-list" class="cs-workflows"></div></div>
    <label class="fld" style="margin-top:10px">ComfyUI 后端工作流</label>
    <div id="cs-wf-list" style="margin-top:8px;max-height:190px;overflow:auto">
      <div class="empty">点「连接」后这里会列出后端上的工作流</div>
    </div>

    <div class="divider"></div>
    <div id="cs-detail"><div class="empty">点上面一个工作流，这里显示它的参数（提示词 / 采样 / LoRA 槽）</div></div>

    <div class="row" style="margin-top:16px"><div class="spacer"></div>
      <button class="sm" data-close>关闭</button></div>
  </div>`;
  document.body.appendChild(box);

  const backendNow = () => box.querySelector('#cs-backend').value;
  const connection = () => ({ backend: backendNow(), url: box.querySelector('#cs-url').value.trim(), key: box.querySelector('#cs-key').value.trim() });
  const connectionDraft = editFeedback.track({
    element: box.querySelector('#cs-connection-fields'), group: 'comfy-connection', label: '出图连接',
    status: box.querySelector('#cs-connection-save-state'), read: connection, savedText: '已保存连接',
    busyCheck: () => busy === 'saving' || busy === 'connecting',
    write: async (body) => {
      const result = await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({
        backend: body.backend, ...(body.url ? { [body.backend === 'local' ? 'local_url' : 'cloud_url']: body.url } : {}),
        ...(body.key ? { cloud_api_key: body.key } : {}),
      }) });
      cfg = { ...cfg, ...result }; onSaved?.();
    },
  });
  const close = async () => {
    if (!(await editFeedback.prepare(['comfy-connection', 'comfy-workflow'], '关闭出图设置'))) return;
    inspectVersion++; connectionDraft.dispose(); workflowDraft?.dispose();
    window.removeEventListener('keydown', onEscape); box.remove();
  };
  const onEscape = (event) => { if (event.key === 'Escape' && [...document.querySelectorAll('.modal:not(.hidden)')].at(-1) === box) close(); };
  window.addEventListener('keydown', onEscape);
  box.querySelector('[data-close]').addEventListener('click', close);
  box.addEventListener('click', (event) => { if (event.target === box) close(); });
  async function locked(action, kind = 'saving') {
    if (busy) { toast('当前操作还未完成，请稍候。'); return; }
    busy = kind; inspectVersion++;
    const controls = [...box.querySelectorAll('input, select, textarea, button:not([data-close])')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try { await action(); }
    finally { busy = ''; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  }
  async function canReplace() {
    if (busy) { toast('当前操作还未完成，请稍候。'); return false; }
    return editFeedback.prepare('comfy-workflow', '切换工作流');
  }
  box.querySelector('#cs-save-connection').addEventListener('click', () => locked(async () => {
    if (await connectionDraft.flush()) toast('出图连接已保存', 'ok');
  }));
  box.querySelectorAll('#cs-url, #cs-key').forEach((input) => input.addEventListener('input', () => { connected = false; inspectVersion++; }));
  box.querySelector('#cs-backend').addEventListener('change', () => {
    connected = false;
    inspectVersion++;
    serverWorkflows = [];
    renderServerWorkflows([]);
    setState('', '未连接');
    const b = backendNow();
    box.querySelector('#cs-url').value = b === 'local' ? (cfg.local_url || 'http://127.0.0.1:8188') : (cfg.cloud_url || '');
    connectionDraft.changed();
  });
  const setState = (cls, text) => {
    const el = box.querySelector('#cs-state');
    el.className = 'pill ' + cls; el.innerHTML = `<i class="dotm"></i>${text}`;
  };

  // ---- ① 连接：POST 一次，拿工作流 + 模型清单 ----
  box.querySelector('#cs-connect').addEventListener('click', () => locked(async () => {
    connected = false;
    setState('run', '连接中…');
    const backend = backendNow();
    const url = box.querySelector('#cs-url').value.trim();
    const api_key = box.querySelector('#cs-key').value;
    try {
      if (!(await connectionDraft.flush())) { setState('err', '配置未保存'); return; }
      const r = await api('/api/comfy/connect', { method: 'POST', body: JSON.stringify({ backend, url, ...(api_key ? { api_key } : {}) }) });
      if (backend === 'local') cfg.local_url = url; else if (url) cfg.cloud_url = url;
      if (!r.reachable) { setState('err', '连不上'); box.querySelector('#cs-counts').textContent = r.error || ''; return; }
      setState('ok', '已连接');
      connected = true;
      currentLoras = r.loras || [];
      const options = box.querySelector('#cs-lora-opts');
      if (options) options.innerHTML = currentLoras.map((l) => `<option value="${esc(l)}">`).join('');
      box.querySelector('#cs-counts').textContent =
        `工作流 ${r.workflows.length} 个 · LoRA ${(r.loras || []).length} 个 · checkpoint ${(r.checkpoints || []).length} 个 · VAE ${(r.vaes || []).length} 个`;
      serverWorkflows = r.workflows || [];
      renderServerWorkflows(serverWorkflows);
    } catch (e) { setState('err', '失败'); toast(e.message, 'err'); }
  }, 'connecting'));

  function renderServerWorkflows(list) {
    const el = box.querySelector('#cs-wf-list');
    if (!list.length) { el.innerHTML = `<div class="empty">${connected ? '这台后端上还没有工作流（先在 ComfyUI 里存一个）' : '点「连接」后这里会列出后端上的工作流'}</div>`; return; }
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

  function renderSavedWorkflows() {
    const el = box.querySelector('#cs-local-wf-list');
    el.innerHTML = (cfg.workflows || []).map((name) => `<button type="button" class="sm ${name === cfg.workflow_name ? 'primary' : ''}" data-saved-wf="${esc(name)}">${esc(name)}</button>`).join('')
      || '<span class="mut" style="font-size:12px">还没有保存的工作流，可先上传 JSON</span>';
    el.querySelectorAll('[data-saved-wf]').forEach((button) => button.addEventListener('click', () => inspectWorkflow(button.dataset.savedWf, 'saved')));
  }
  renderSavedWorkflows();

  box.querySelector('#cs-upload').addEventListener('click', () => box.querySelector('#cs-upload-file').click());
  box.querySelector('#cs-upload-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const signature = workflowDraft?.snapshot();
    if (!(await canReplace())) { event.target.value = ''; return; }
    const version = ++inspectVersion;
    const button = box.querySelector('#cs-upload');
    const msg = box.querySelector('#cs-upload-msg');
    button.disabled = true; msg.textContent = `正在解析 ${file.name}…`; msg.style.color = '';
    try {
      let workflow;
      try { workflow = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
      catch { throw new Error('JSON 格式无效，请上传从 ComfyUI 导出的 JSON 文件'); }
      const r = await api('/api/comfy/workflows/preview', { method: 'POST', body: JSON.stringify({
        name: file.name, workflow, backend: backendNow(), url: box.querySelector('#cs-url').value.trim(),
        check_nodes: connected,
      }) });
      if (version !== inspectVersion || !box.isConnected) return;
      if (signature !== workflowDraft?.snapshot() && !(await canReplace())) return;
      if (version !== inspectVersion || !box.isConnected) return;
      renderWorkflow(r, 'upload', workflow);
      msg.textContent = `已解析 ${file.name}，核对后点「保存并用它出图」`;
    } catch (e) {
      if (version === inspectVersion) { msg.textContent = e.message; msg.style.color = 'var(--err)'; }
    } finally { button.disabled = false; event.target.value = ''; }
  });

  // ---- ② 点工作流 → 看它有哪些参数 ----
  async function inspectWorkflow(name, source = 'server') {
    const signature = workflowDraft?.snapshot();
    if (!(await canReplace())) return;
    const version = ++inspectVersion;
    const message = box.querySelector('#cs-upload-msg');
    message.textContent = '正在读取工作流…'; message.style.color = '';
    let r;
    try {
      r = source === 'saved'
        ? await api(`/api/comfy/workflows/${encodeURIComponent(name)}/inspect`)
        : await api('/api/comfy/server-workflow', { method: 'POST', body: JSON.stringify({ backend: backendNow(), name }) });
    } catch (e) {
      if (version === inspectVersion) { message.textContent = '读取失败：' + e.message; message.style.color = 'var(--err)'; }
      return;
    }
    if (version !== inspectVersion || !box.isConnected) return;
    if (signature !== workflowDraft?.snapshot() && !(await canReplace())) return;
    if (version === inspectVersion && box.isConnected) { renderWorkflow(r, source); message.textContent = ''; }
  }

  function renderWorkflow(r, source, originalWorkflow = null) {
    workflowDraft?.dispose();
    const el = box.querySelector('#cs-detail');
    const name = r.name;
    const d = r.describe || {};
    const resolved = r.resolved || {};
    const lora = d.lora || { slots: [] };
    const rp = resolved.prompt_pos, rn = resolved.prompt_neg;
    // 下载工作流 JSON 到本地（raw=原样 / api=转换后的扁平版本）
    const dlUrl = (fmt) => `/api/comfy/server-workflow-download?backend=${encodeURIComponent(backendNow())}`
      + `&format=${fmt}&name=${encodeURIComponent(name)}`;
    // 试跑提示词预填：静态取文本；动态拼装取各文本块拼接；都没有则留默认
    const joinChunks = (o) => (o && o.chunks || []).map((c) => c.value || '').join('\n\n').trim();
    const testPos = d.has_prompt_placeholder ? '1girl, solo, masterpiece, best quality' : ((rp && !rp.dynamic && rp.value) ? rp.value : (joinChunks(rp) || '1girl, solo, masterpiece, best quality'));
    const testNeg = d.has_negative_placeholder ? 'worst quality, low quality' : ((rn && !rn.dynamic && rn.value) ? rn.value : (joinChunks(rn) || 'worst quality, low quality'));
    const textFields = [];
    const shownFields = new Set();
    const textEditor = (field, token) => {
      const input = field.input || 'text';
      const key = JSON.stringify([field.node_id, input]);
      if (shownFields.has(key)) return '';
      shownFields.add(key);
      const index = textFields.push({ node_id: field.node_id, input }) - 1;
      return `<div style="margin-top:6px">
        <div class="row" style="gap:6px"><span class="pill tag">${esc(field.class_type)}#${esc(field.node_id)}.${esc(input)}</span>
          <button class="sm" type="button" data-insert-token="${token}" data-text-index="${index}">插入 ${token}</button></div>
        <textarea class="cs-workflow-text" data-text-index="${index}" aria-label="工作流 ${esc(field.node_id)} ${esc(input)} 文本" style="min-height:70px;margin-top:5px">${esc(field.value || '')}</textarea>
      </div>`;
    };
    const condCard = (label, kind, obj, cls) => {
      if (!obj) return `<div class="mini-card" style="padding:8px 10px;margin-top:6px">
        <div class="row" style="gap:6px"><b style="font-size:13px">${label}</b>
          <span class="pill tag">未解析到</span></div></div>`;
      const head = `<div class="row" style="gap:6px"><b style="font-size:13px">${label}</b>
          <span class="pill ${kind}"><i class="dotm"></i>${obj.placeholder ? '占位符注入' : '来自 KSampler'}</span></div>`;
      const token = kind === 'ok' ? '%prompt%' : '%negative%';
      if (obj.dynamic) {
        const chunks = obj.chunks || [];
        return `<div class="mini-card" style="padding:8px 10px;margin-top:6px;border-color:${cls}">
          ${head}
          <div class="mut" style="font-size:11.5px;margin-top:5px;color:var(--warn)">
            ${obj.placeholder ? `以下 ${chunks.length} 处使用 ${esc(obj.placeholder)} 接收提示词` : `提示词由多个文本块动态拼装，可在需要接收前端提示词的文本块中插入 ${token}`}</div>
          ${chunks.map((c) => textEditor(c, token)).join('') || '<div class="mut" style="font-size:11px;margin-top:4px">（未定位到文本块）</div>'}
        </div>`;
      }
      return `<div class="mini-card" style="padding:8px 10px;margin-top:6px;border-color:${cls}">
        ${head}
        ${textEditor(obj, token)}
      </div>`;
    };
    el.innerHTML = `
      <div class="row" style="gap:8px">
        <b style="overflow-wrap:anywhere;min-width:0;max-width:100%">${esc(name)}</b>
        <span class="pill tag">${d.node_count} 节点</span>
        <span class="pill tag">${r.ui_format ? 'UI 格式（已转 API）' : 'API 格式'}</span>
        <span class="pill tag">LoRA：${esc(lora.mode || '无')}</span>
        <div class="spacer"></div>
        ${source === 'server' ? `<a class="sm" href="${dlUrl('raw')}" download style="text-decoration:none">下载原始 JSON</a>` : '<button class="sm" type="button" id="cs-download-raw">下载原始 JSON</button>'}
        <button class="sm" type="button" id="cs-download-api">下载 API 格式</button>
        <button class="sm primary" id="cs-use">保存并用它出图</button>
      </div>
      ${(r.warnings || []).length ? `<div class="empty" style="color:var(--warn);text-align:left;font-size:12px;margin-top:6px">⚠ ${r.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
      ${(d.missing_nodes || []).length ? `<div class="empty" style="color:var(--err);text-align:left;font-size:12px;margin-top:6px">缺节点：${d.missing_nodes.map(esc).join('、')}（这台 ComfyUI 上没装/没加载，可能跑不了）</div>` : ''}

      <div style="margin-top:12px"><b style="font-size:13px">工作流正 / 负面文本</b>
        <div class="mut" style="font-size:12px;margin-top:4px">可编辑固定词并插入占位符；保存后，逐格出图与试跑都会把输入的正负面填入对应占位符。</div></div>
      ${condCard('正向提示词', 'ok', rp, 'var(--ok)')}
      ${condCard('负向提示词', 'err', rn, 'var(--line2)')}
      ${(!rp && !rn) ? `<div class="empty" style="text-align:left;font-size:12px;margin-top:6px;color:var(--warn)">⚠ 没能解析出提示词：${esc(resolved.reason || '未知原因')}</div>` : ''}

      <div style="margin-top:10px"><b style="font-size:13px">LoRA（${(lora.slots || []).length} 个）</b>
        <span class="mut" style="font-size:12px">　统一管理启用、文件名和权重，按列表顺序试跑</span></div>
      <div class="cs-lora-table" style="margin-top:6px">
        <table><thead><tr><th>启用</th><th>LoRA 文件名</th><th>模型权重</th><th>CLIP 权重</th></tr></thead><tbody>
          ${(lora.slots || []).map((s, i) => `<tr data-cs-lora-row="${i}">
            <td><input type="checkbox" class="cs-lora" aria-label="启用 LoRA ${i + 1}" ${s.on ? 'checked' : ''} style="width:auto"></td>
            <td><input class="cs-lora-name" list="cs-lora-opts" value="${esc(s.lora || '')}" placeholder="LoRA 文件名" aria-label="LoRA ${i + 1} 文件名">
              <div class="mut" style="font-size:11px;margin-top:2px">${esc(s.node_id)} · ${esc(s.input)}</div></td>
            <td><input class="cs-lora-w" type="number" step="any" aria-label="LoRA ${i + 1} 模型权重" value="${s.strength ?? 1}" style="width:80px"></td>
            <td>${(s.strength_clip_input && s.strength_clip_input !== s.strength_input) || lora.mode === '堆加载 · 对象式'
              ? `<input class="cs-lora-clip" type="number" step="any" aria-label="LoRA ${i + 1} CLIP 权重" value="${s.strength_clip ?? ''}" placeholder="跟随模型" style="width:95px">`
              : '<span class="mut" style="font-size:12px">跟随模型</span>'}</td>
          </tr>`).join('') || '<tr><td colspan="4" class="mut">这个工作流没有可识别的 LoRA 节点</td></tr>'}
        </tbody></table>
      </div>

      <div style="margin-top:10px"><b style="font-size:13px">采样参数</b></div>
      <div class="grid2" style="margin-top:6px">
        ${Object.entries(d.sampler || {}).map(([k, v]) => `
          <div class="mini-card" style="padding:8px 10px;display:flex;justify-content:space-between">
            <span class="mut" style="font-size:12px">${esc(k)}</span><b style="font-size:12px">${esc(String(v.value))}</b>
          </div>`).join('') || '<div class="mut" style="font-size:12px">没识别到采样节点（可能是子图）</div>'}
      </div>

      <div style="margin-top:12px"><b style="font-size:13px">试跑</b>
        <span class="mut" style="font-size:12px">　用下面这两个提示词真出一张（已按解析结果预填）</span></div>
      <div class="grid2" style="margin-top:6px">
        <div><label class="fld">正向提示词</label><textarea id="cs-t-pos" style="min-height:54px">${esc(testPos)}</textarea></div>
        <div><label class="fld">负向提示词</label><textarea id="cs-t-neg" style="min-height:54px">${esc(testNeg)}</textarea></div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="sm primary" id="cs-test">试跑一张</button>
        <span class="mut" id="cs-test-msg" style="font-size:12px"></span>
      </div>
      <div id="cs-test-out" style="margin-top:10px"></div>`;

    const dl = document.createElement('datalist'); dl.id = 'cs-lora-opts';
    dl.innerHTML = currentLoras.map((l) => `<option value="${esc(l)}">`).join('');
    el.appendChild(dl);

    el.querySelectorAll('[data-insert-token]').forEach((button) => button.addEventListener('click', () => {
      const textarea = el.querySelector(`textarea[data-text-index="${button.dataset.textIndex}"]`);
      const token = button.dataset.insertToken;
      const start = textarea.selectionStart, end = textarea.selectionEnd;
      textarea.setRangeText(token, start, end, 'end');
      workflowDraft.changed();
      textarea.focus();
    }));

    const readWeight = (input, fallback = null) => {
      if (!input || input.value === '') return fallback;
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('LoRA 权重必须是有效数字');
      return value;
    };
    const collectWorkflow = () => {
      const workflow = JSON.parse(JSON.stringify(r.workflow));
      el.querySelectorAll('textarea.cs-workflow-text').forEach((textarea) => {
        const field = textFields[Number(textarea.dataset.textIndex)];
        workflow[field.node_id].inputs[field.input] = textarea.value;
      });
      el.querySelectorAll('[data-cs-lora-row]').forEach((row) => {
        const slot = lora.slots[Number(row.dataset.csLoraRow)];
        const inputs = workflow[slot.node_id].inputs;
        const name = row.querySelector('.cs-lora-name').value.trim();
        const on = row.querySelector('.cs-lora').checked && !!name;
        const weight = readWeight(row.querySelector('.cs-lora-w'), 1);
        const clip = readWeight(row.querySelector('.cs-lora-clip'));
        if (lora.mode === '堆加载 · 对象式') {
          inputs[slot.input] = { ...inputs[slot.input], on, lora: name, strength: weight, strengthTwo: clip };
        } else if (lora.mode === '串联') {
          inputs[slot.input] = name;
          inputs[slot.strength_input] = on ? weight : 0;
          if (slot.strength_clip_input && slot.strength_clip_input !== slot.strength_input) inputs[slot.strength_clip_input] = on ? (clip ?? weight) : 0;
        } else {
          inputs[slot.input] = on ? name : (r.workflow[slot.node_id].inputs[slot.input] === '' ? '' : 'None');
          if (slot.strength_input) inputs[slot.strength_input] = on ? weight : 0;
        }
      });
      return workflow;
    };
    const downloadWorkflow = (workflow, filename) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    el.querySelector('#cs-download-raw')?.addEventListener('click', () => downloadWorkflow(originalWorkflow || r.workflow, `${name}.json`));
    el.querySelector('#cs-download-api').addEventListener('click', () => {
      try { downloadWorkflow(collectWorkflow(), `${name}.api.json`); } catch (e) { toast(e.message, 'err'); }
    });

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
      const card = cb.closest('[data-cs-lora-row]');
      const name = card.querySelector('.cs-lora-name').value.trim();
      const w = readWeight(card.querySelector('.cs-lora-w'), 1);
      const clip = readWeight(card.querySelector('.cs-lora-clip'));
      return cb.checked && name ? { name, weight: w, ...(clip !== null ? { weight_clip: clip } : {}) } : null;
    }).filter(Boolean);

    let selectedName = name, lastWarnings = [];
    const saveSelectedWorkflow = async () => {
      const workflow = collectWorkflow();
      const im = await api('/api/comfy/workflows', { method: 'POST', body: JSON.stringify({
        backend: backendNow(), name: selectedName, workflow, activate: true, overwrite: source !== 'upload',
      }) });
      selectedName = im.name; source = 'saved'; lastWarnings = im.warnings || [];
      cfg.workflow_name = im.name;
      if (!(cfg.workflows || []).includes(im.name)) cfg.workflows = [...(cfg.workflows || []), im.name];
      box.querySelector('#cs-current').textContent = im.name;
      renderSavedWorkflows(); renderServerWorkflows(serverWorkflows);
      onSaved?.(); return im;
    };
    const workflowStatus = document.createElement('div'); workflowStatus.id = 'cs-workflow-save-state'; workflowStatus.className = 'save-feedback';
    el.prepend(workflowStatus);
    const draft = editFeedback.track({
      element: el, group: 'comfy-workflow', label: '工作流', status: workflowStatus,
      watchSelector: '.cs-workflow-text, .cs-lora, .cs-lora-name, .cs-lora-w, .cs-lora-clip',
      savedValue: source === 'upload' ? null : undefined,
      busyCheck: () => busy === 'saving' || busy === 'connecting',
      read: () => [...el.querySelectorAll('.cs-workflow-text, .cs-lora, .cs-lora-name, .cs-lora-w, .cs-lora-clip')]
        .map((input) => input.type === 'checkbox' ? input.checked : input.value),
      write: saveSelectedWorkflow,
    });
    workflowDraft = draft;

    el.querySelector('#cs-use').addEventListener('click', () => locked(async () => {
      const button = el.querySelector('#cs-use');
      const testButton = el.querySelector('#cs-test');
      button.disabled = true; testButton.disabled = true;
      try {
        if (!(await connectionDraft.flush()) || !(await draft.flush(true))) return;
        box.querySelector('#cs-upload-msg').textContent = '';
        toast(`已保存并选中：${selectedName}`, 'ok');
        if (lastWarnings.length) toast('提示：' + lastWarnings.join('；'), 'err');
      } catch (e) { toast(e.message, 'err'); }
      finally { button.disabled = false; testButton.disabled = false; }
    }));

    el.querySelector('#cs-test').addEventListener('click', () => locked(async () => {
      const btn = el.querySelector('#cs-test'); const msg = el.querySelector('#cs-test-msg');
      const useButton = el.querySelector('#cs-use');
      btn.disabled = true; useButton.disabled = true; msg.textContent = '出图中…（可能几十秒）';
      try {
        const params = collectParams();
        const loras = collectLoras();
        await api('/api/comfy/config', { method: 'PUT', body: JSON.stringify({ default_params: params }) });
        if (!(await connectionDraft.flush()) || !(await draft.flush(true))) throw new Error('配置或工作流未保存，请重试');
        busy = 'testing';
        const r = await api('/api/comfy/test-run', { method: 'POST', body: JSON.stringify({
          prompt_pos: el.querySelector('#cs-t-pos').value,
          prompt_neg: el.querySelector('#cs-t-neg').value,
          params, loras,
        }) });
        msg.textContent = '完成';
        el.querySelector('#cs-test-out').innerHTML = `<img src="${r.url}" style="max-width:100%;border-radius:10px;border:1px solid var(--line2)">`;
      } catch (e) { msg.textContent = ''; toast('试跑失败：' + e.message, 'err'); }
      finally { btn.disabled = false; useButton.disabled = false; }
    }));
  }
}



return { open };
}
