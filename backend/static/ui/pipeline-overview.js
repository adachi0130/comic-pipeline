import { STAGES, activeJob, jobStage, shapeTitle, suggestedStage, panelBox, duration } from './pipeline-overview-model.js';

export function createPipelineOverview({ state, api, $, esc, pill, toast, switchTab, refreshGates,
  pageLabel, panelFullLabel, openPageDetail, openStageArtifacts, focusImage }) {
  let board = null, projectId = null, request = 0, jobsEpoch = 0, jobs = [], stage = '', artifactSignature = '';
  let refreshTimer, connection = 'connecting', historyOpen = false;
  const targets = {}, counts = {}, submissions = new Map(), cancelling = new Set(), accepted = new Map();
  const visible = () => !$('#tab-pipeline').classList.contains('hidden');
  const scoped = () => board?.project_id === state.projectId;
  const label = (ref) => ref?.startsWith('panel:') ? panelFullLabel(ref) : ref?.startsWith('page:') ? pageLabel(ref) : '整个项目';
  const matching = (id, ref) => jobs.find((job) => activeJob(job) && jobStage(job)?.id === id && (!job.ref || !ref || job.ref === ref));

  function reset() {
    request++; projectId = null; board = null; jobs = []; stage = ''; artifactSignature = ''; historyOpen = false; accepted.clear();
    clearTimeout(refreshTimer);
    jobsEpoch++;
    for (const map of [targets, counts]) for (const key of Object.keys(map)) delete map[key];
    $('#ov-summary').innerHTML = ''; $('#ov-steps').innerHTML = ''; $('#ov-action').innerHTML = '';
    $('#ov-preview').innerHTML = '<div class="empty">选择项目后显示当前漫画。</div>';
    $('#jobs').innerHTML = ''; $('#ov-history').innerHTML = ''; $('#ov-feedback').textContent = '';
    $('#ov-live').textContent = '选择项目后显示任务';
    $('#ov-refresh').disabled = false; $('#ov-preview-title').textContent = '当前漫画'; $('#ov-task-count').textContent = '0 进行中';
  }
  async function load({ quiet = false } = {}) {
    const id = state.projectId;
    if (id !== projectId) { reset(); projectId = id; }
    if (!id) { reset(); return; }
    const version = ++request, epoch = jobsEpoch;
    if (!quiet && !board) $('#ov-preview').innerHTML = '<div class="empty">正在读取漫画产物…</div>';
    try {
      const data = await api(`/api/projects/${id}/overview`);
      if (id !== state.projectId || version !== request) return;
      board = data;
      if (epoch === jobsEpoch) jobs = data.jobs;
      stage ||= suggestedStage(data);
      state._gates = data.stages;
      render();
      $('#ov-feedback').textContent = '';
    } catch (error) {
      if (id !== state.projectId || version !== request) return;
      $('#ov-feedback').textContent = '总览读取失败：' + error.message + '，可点刷新重试。';
      if (!board) $('#ov-preview').innerHTML = '<div class="empty">暂时无法读取漫画产物。</div>';
    } finally { if (version === request) $('#ov-refresh').disabled = false; }
  }
  function render() {
    if (!scoped()) return;
    const sum = board.summary;
    $('#ov-summary').innerHTML = `<div><div class="ov-eyebrow">${esc(board.title)} · 当前成果</div><h2>${shapeTitle(board)}</h2>
      <p>${sum.prose_chars.toLocaleString()} 字正文 · ${sum.pages} / ${board.target_pages} 页分格 · ${sum.with_image} / ${sum.panels} 格有画面 · ${sum.composed} 页成图</p></div>
      <button class="primary sm" data-ov-suggest>处理下一步</button>`;
    $('#ov-summary [data-ov-suggest]').onclick = () => { stage = suggestedStage(board); renderSteps(); renderAction(); $('#ov-action').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    renderSteps(); renderAction(); renderJobs();
    const signature = JSON.stringify([board.prose, board.pages, board.book]);
    if (signature !== artifactSignature) { artifactSignature = signature; renderPreview(); }
  }
  function renderSteps() {
    if (!scoped()) return;
    $('#ov-steps').innerHTML = STAGES.map((step) => {
      const stats = board.stages[step.id] || {}, active = jobs.filter((job) => activeJob(job) && jobStage(job)?.id === step.id);
      const pending = [...submissions.values()].some((item) => item.id === state.projectId && item.stage === step.id);
      const text = pending ? '正在提交' : active.length ? `${active.length} 个任务${active.some((job) => job.cancel_requested) ? '取消中' : '进行中'}` : stats.stale ? `${stats.stale} 项需更新` : stats.review ? `${stats.review} 项待审` : stats.count ? `${stats.approved} / ${stats.count} 已通过` : '尚未产出';
      return `<button type="button" class="ov-step ${step.id === stage ? 'selected' : ''} ${active.length || pending ? 'working' : ''}" data-ov-stage="${step.id}" aria-pressed="${step.id === stage}"><span>${step.id}</span><b>${step.name}</b><small>${text}</small></button>`;
    }).join('');
    $('#ov-steps').querySelectorAll('[data-ov-stage]').forEach((button) => button.onclick = () => { stage = button.dataset.ovStage; renderSteps(); renderAction(); });
  }
  function actionInfo() {
    const ready = board.readiness[stage] || {}, pages = board.pages.filter((page) => page.script?.status === 'approved');
    const info = { stage, tab: STAGES.find((item) => item.id === stage).tab, targets: [], body: {}, ready: true, text: '', hint: '', goto: '' };
    if (stage === 'S1') return { ...info, text: '去写作与审核正文', navigate: true };
    if (stage === 'S6') return { ...info, text: '选择页序并导出', navigate: true };
    if (!ready.ready) { info.hint = ready.missing; info.goto = ready.goto; info.ready = false; }
    if (['S2', 'S3'].includes(stage) && !board.readiness.has_llm_provider) Object.assign(info, { ready: false, hint: '先配置并启用 LLM 供应商。', goto: 'settings', section: 'providers' });
    if (stage === 'S2') {
      info.text = board.pages.length ? '补齐剩余分页' : '提交分页分格';
      if (!board.has_templates) Object.assign(info, { ready: false, hint: '还没有版式模板，请先导入模板菜单。' });
      if (Array.from({ length: board.target_pages }, (_, index) => `page:${index + 1}`).every((ref) => board.pages.some((page) => page.ref === ref && page.script))) Object.assign(info, { ready: false, hint: '目标页数已分格，可在分格分页中编辑或调整目标页数。', goto: 'pages' });
    }
    if (stage === 'S3') {
      info.targets = pages.map((page) => ({ ref: page.ref, name: pageLabel(page.ref), page }));
      info.text = '生成本页提示词';
    }
    if (stage === 'S4') {
      info.targets = pages.flatMap((page) => page.panels.filter((panel) => panel.prompt?.status === 'approved').map((panel) => ({ ref: panel.ref, name: panelFullLabel(panel.ref), panel })));
      info.text = '生成本格候选图';
      if (!board.has_workflow) Object.assign(info, { ready: false, hint: '先在出图设置中保存并选用工作流。', goto: 'settings', section: 'comfy' });
    }
    if (stage === 'S5') {
      info.targets = pages.filter((page) => page.composable).map((page) => ({ ref: page.ref, name: pageLabel(page.ref), page }));
      info.text = '后台合成本页';
    }
    if (['S3', 'S4', 'S5'].includes(stage)) {
      if (!info.targets.length && info.ready) Object.assign(info, { ready: false,
        hint: stage === 'S3' ? '先审核至少一页分格。' : stage === 'S4' ? '先审核要出图的格及对应漫画页。' : '先审核漫画页，并给这页每格采用一张可用图片。', goto: stage === 'S3' ? 'pages' : stage === 'S4' ? 'prompts' : 'images' });
      if (!info.targets.some((item) => item.ref === targets[stage])) targets[stage] = (info.targets.find((item) => stage === 'S4' ? !item.panel.image_url : stage === 'S3' ? item.page.panels.some((panel) => !panel.prompt) : !item.page.page_image_url) || info.targets[0])?.ref || '';
      info.body = stage === 'S4' ? { panel_ref: targets[stage], count: counts.S4 || Math.min(8, state.project?.candidates_per_panel || 4) } : { page_ref: targets[stage] };
      const chosen = info.targets.find((item) => item.ref === targets[stage]);
      if (stage === 'S4' && chosen) info.body.prompt_artifact_id = chosen.panel.prompt.id;
      info.replacing = stage === 'S3' ? chosen?.page.panels.some((panel) => panel.prompt) : stage === 'S4' ? chosen?.panel.image : chosen?.page.page_image;
    }
    const ref = info.body.panel_ref || info.body.page_ref || '';
    info.active = matching(stage, ref);
    info.submitting = submissions.has(`${state.projectId}:${stage}:${ref}`);
    return info;
  }
  function renderAction() {
    if (!scoped()) return;
    const info = actionInfo(), step = STAGES.find((item) => item.id === stage);
    $('#ov-action').innerHTML = `<div class="ov-action-heading"><b>${step.id} · ${step.name}</b><button class="sm" data-ov-tab>进入工作台</button><button class="sm" data-ov-records>产物记录</button></div>
      <div class="row">${info.targets.length ? `<label class="ov-target">处理目标<select id="ov-target">${info.targets.map((item) => `<option value="${esc(item.ref)}" ${targets[stage] === item.ref ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>` : ''}
      ${stage === 'S4' ? `<label class="ov-count">候选张数<input id="ov-count" type="number" min="1" max="8" value="${info.body.count}"></label>` : ''}
      <button class="primary" id="ov-submit" ${!info.ready || info.active || info.submitting ? 'disabled' : ''}>${info.submitting ? '正在提交…' : info.active ? info.active.cancel_requested ? '任务正在取消…' : '该目标已有任务' : info.text}</button>
      ${info.goto ? '<button class="sm" data-ov-fix>去处理前置条件</button>' : ''}</div>
      <div class="ov-action-hint">${esc(info.hint || (info.active ? `任务 #${info.active.id} · ${label(info.active.ref)}，可在任务区查看。` : info.navigate ? '' : info.replacing ? '已有产物，重新生成会保留历史版本，并将相关下游标记需更新。' : '任务提交后在后台执行，任务区会持续显示进度。'))}</div>`;
    $('#ov-action [data-ov-tab]').onclick = () => switchTab(step.tab);
    $('#ov-action [data-ov-records]').onclick = () => openStageArtifacts(stage);
    $('#ov-action [data-ov-fix]')?.addEventListener('click', () => switchTab(info.goto, info.section));
    $('#ov-target')?.addEventListener('change', (event) => { targets[stage] = event.target.value; renderAction(); });
    $('#ov-count')?.addEventListener('input', (event) => { counts.S4 = Number(event.target.value); });
    $('#ov-submit').onclick = () => {
      if (info.navigate) { switchTab(info.tab); return; }
      const body = { ...info.body }; if (stage === 'S4') body.count = Number($('#ov-count').value);
      if (info.replacing && !confirm(`${step.name}已有产物，确定为${label(body.panel_ref || body.page_ref)}重新生成吗？历史版本会保留。`)) return;
      submit(stage, body);
    };
  }
  function renderPreview() {
    const sum = board.summary;
    $('#ov-preview-title').textContent = board.pages.length ? `漫画页 · ${sum.with_image}/${sum.panels} 格有画面` : board.prose.length ? '正文' : '还没有漫画产物';
    const novel = board.prose.length ? `<details class="ov-prose" ${board.pages.length ? '' : 'open'}><summary>故事正文 · ${sum.prose_chars.toLocaleString()} 字 · ${board.prose.length} 段</summary>
      <div class="ov-manuscript">${board.prose.map((item, index) => `<article><header><b>第 ${index + 1} 段</b>${pill(item.status)}<span>v${item.version}</span></header><div>${esc(item.text)}</div></article>`).join('')}</div></details>` : '';
    const book = board.book ? `<div class="ov-book"><div><b>成册文件 · v${board.book.version}</b> ${pill(board.book.status)}</div><div class="row">${board.book.downloads.map((file) => `<a class="download-button" href="${esc(file.url)}">下载 ${file.format.toUpperCase()}</a>`).join('') || '<span class="mut">当前版本的导出文件不可用</span>'}<button class="sm" data-ov-export>导出中心</button></div></div>` : '';
    const pages = board.pages.map((page) => {
      const whole = page.page_image_url && !page.needs_update, canvas = page.canvas.map(Number), ratio = canvas.length === 2 && canvas.every((n) => Number.isFinite(n) && n > 0) ? canvas[0] / canvas[1] : 672 / 950;
      return `<article class="ov-page" data-ov-page="${esc(page.ref)}"><header><b>${esc(pageLabel(page.ref))}</b><span class="pill ${page.needs_update ? 'stale' : whole ? 'ok' : 'tag'}">${page.needs_update ? '需更新' : whole ? '整页成图' : page.panels.some((panel) => panel.image_url) ? '画面填充中' : '已分格'}</span></header><span class="ov-page-job" data-ov-page-task="${esc(page.ref)}"></span>
        <div class="ov-paper" style="aspect-ratio:${ratio}">${whole ? `<button class="ov-whole" data-ov-compose="${esc(page.ref)}"><img src="${esc(page.page_image_url)}" alt="${esc(pageLabel(page.ref))}整页成图" loading="lazy"></button>` : page.panels.map((panel, index) => {
          const rect = panelBox(page, panel, index), stale = panel.image?.status === 'stale' || panel.prompt?.status === 'stale';
          return `<button class="ov-cell ${panel.image_url ? 'has-image' : ''} ${panel.preview_kind === 'candidate' ? 'unselected' : ''} ${stale ? 'outdated' : ''}" style="left:${rect[0]}%;top:${rect[1]}%;width:${rect[2]}%;height:${rect[3]}%" data-ov-panel="${esc(panel.ref)}" aria-label="${esc(panelFullLabel(panel.ref))}，${panel.image_url ? panel.preview_kind === 'candidate' ? '候选未采用' : '已采用画面' : '等待画面'}">
            ${panel.image_url ? `<img src="${esc(panel.image_url)}" alt="${esc(panelFullLabel(panel.ref))}" loading="lazy">` : `<span class="ov-cell-empty"><b>${panel.order}</b><span>${esc(panel.action || panel.shot || '等待画面').slice(0, 24)}</span>${panel.prompt ? '<small>已有提示词</small>' : ''}</span>`}
            ${panel.image_url ? `<span class="ov-cell-tag">${panel.order} · ${stale ? '需更新' : panel.preview_kind === 'candidate' ? '候选待采用' : '已采用'}</span>` : ''}<span class="ov-cell-live hidden" data-ov-cell-task></span></button>`;
        }).join('') || '<div class="empty">缺少分格记录</div>'}</div>
        <footer><span>${page.panels.filter((panel) => panel.image_url).length}/${page.panels.length} 格有画面 · ${page.panels.filter((panel) => panel.approved_image).length} 已采用</span><div class="row">
          ${page.script ? `<button class="sm" data-ov-edit="${esc(page.ref)}">查看分格</button>` : ''}<button class="sm" data-ov-compose="${esc(page.ref)}">${whole ? '查看整页' : '编辑 / 合成'}</button></div></footer></article>`;
    }).join('');
    $('#ov-preview').innerHTML = book + (pages ? `<div class="ov-legend"><span>空格：等待画面</span><span>虚线画面：候选未采用</span><span>实线画面：已采用</span><span>紫色：上游已修改</span></div><div class="ov-page-grid">${pages}</div>` : '') + novel
      || '<div class="empty">还没有产物，先写正文或粘贴已有故事。</div>';
    $('#ov-preview').querySelectorAll('[data-ov-panel]').forEach((button) => button.onclick = () => focusImage(button.dataset.ovPanel));
    $('#ov-preview').querySelectorAll('[data-ov-edit]').forEach((button) => button.onclick = () => openPageDetail(button.dataset.ovEdit));
    $('#ov-preview').querySelectorAll('[data-ov-compose]').forEach((button) => button.onclick = () => { state._composeSelected = button.dataset.ovCompose; switchTab('compose'); });
    $('#ov-preview [data-ov-export]')?.addEventListener('click', () => switchTab('exports'));
    renderPanelTasks();
  }
  function renderPanelTasks() {
    $('#ov-preview').querySelectorAll('[data-ov-panel]').forEach((button) => {
      const task = matching('S4', button.dataset.ovPanel), badge = button.querySelector('[data-ov-cell-task]');
      button.classList.toggle('rendering', !!task); badge.classList.toggle('hidden', !task);
      badge.textContent = task ? task.cancel_requested ? '正在取消' : task.status === 'queued' ? '等待出图' : '正在出图' : '';
    });
    $('#ov-preview').querySelectorAll('[data-ov-page-task]').forEach((element) => {
      const ref = element.dataset.ovPageTask, pageIndex = ref.split(':')[1];
      const tasks = jobs.filter((job) => activeJob(job) && (job.ref === ref || job.ref?.startsWith(`panel:${pageIndex}.`)));
      element.textContent = tasks.length ? tasks.map((job) => `${jobStage(job)?.name || job.kind} #${job.id}${job.cancel_requested ? ' · 取消中' : ''}`).join(' · ') : '';
    });
  }
  async function submit(id, body = {}) {
    const origin = state.projectId, ref = body.panel_ref || body.page_ref || '', key = `${origin}:${id}:${ref}`;
    if (!origin || submissions.has(key)) return;
    if (id === 'S1' || id === 'S6') { switchTab(id === 'S1' ? 'novel' : 'exports'); return; }
    if (matching(id, ref)) { toast(id === 'S3' && !ref ? '提示词阶段已有任务，请结束后再提交全部页。' : '相同目标已有任务，请在任务区查看。'); return; }
    if (id === 'S4' && (!Number.isInteger(body.count) || body.count < 1 || body.count > 8)) { toast('候选张数请填写 1 到 8 的整数', 'err'); return; }
    submissions.set(key, { id: origin, stage: id, ref }); renderSteps(); renderAction(); renderJobs();
    try {
      const result = await api(`/api/projects/${origin}/run/${id}`, { method: 'POST', body: JSON.stringify(body) });
      if (state.projectId === origin) {
        const existing = jobs.find((job) => job.id === result.job_id);
        if (!existing || activeJob(existing)) {
          const task = result.job || { id: result.job_id, project_id: origin, stage: id, ref, status: result.status };
          accepted.set(task.id, task);
          jobs = [task, ...jobs.filter((job) => job.id !== result.job_id)];
        }
        $('#ov-feedback').textContent = `${result.reused ? '已复用' : '已提交'}任务 #${result.job_id} · ${label(ref)}`;
        jobsEpoch++; renderSteps(); renderAction(); renderJobs(); scheduleRefresh();
      }
      toast(`${id} · ${label(ref)}${result.reused ? '已有任务' : '已提交'} #${result.job_id}`, 'ok');
    } catch (error) {
      if (state.projectId === origin) $('#ov-feedback').textContent = '提交失败：' + error.message + '，可处理后重新提交。';
      toast('提交失败：' + error.message, 'err');
    } finally {
      submissions.delete(key);
      if (state.projectId === origin) { renderSteps(); renderAction(); renderJobs(); }
    }
  }
  function taskCard(job) {
    const active = activeJob(job), step = jobStage(job), cancellingNow = cancelling.has(job.id) || (job.cancel_requested && active);
    const amount = job.total > 0 ? Math.min(100, Math.max(0, Math.round(job.progress / job.total * 100))) : null;
    return `<article class="ov-job ${active ? 'active' : ''} ${job.status === 'failed' ? 'failed' : ''}" data-ov-job="${job.id}"><header><span class="pill tag">${esc(step?.name || job.kind)}</span><b>${esc(label(job.ref))}</b><span class="mut">#${job.id}</span>${cancellingNow ? '<span class="pill warn">正在取消</span>' : pill(job.status)}<span class="ov-job-time" data-ov-duration="${job.id}">${duration(job)}</span></header>
      <div class="ov-job-message">${esc(job.error || job.message || (job.status === 'queued' ? '等待后台接手执行' : job.status === 'running' ? '正在处理，等待结果返回' : job.status === 'done' ? '已完成，可查看更新后的产物' : ''))}</div>
      ${active || job.status === 'done' ? `<div class="ov-job-progress"><progress max="100" ${amount != null || job.status === 'done' ? `value="${job.status === 'done' ? 100 : amount}"` : ''} aria-label="${esc(step?.name || job.kind)}任务进度"></progress><span>${job.total > 0 ? `${job.progress}/${job.total} ${['S2','S3'].includes(step?.id) ? '页' : step?.id === 'S4' ? '张' : '项'}` : active ? '处理中' : '完成'}</span></div>` : ''}
      <footer><button class="sm" data-ov-job-go="${job.id}">查看${step?.name || '产物'}</button>${job.status === 'failed' ? `<button class="sm" data-ov-job-detail="${job.id}">查看失败原因</button>${['S2','S3','S4','S5'].includes(step?.id) ? `<button class="sm" data-ov-retry="${job.id}">检查并重试</button>` : ''}` : ''}${active ? `<button class="sm danger" data-ov-cancel="${job.id}" ${cancellingNow ? 'disabled' : ''}>${cancellingNow ? '等待停止…' : '取消任务'}</button>` : ''}</footer></article>`;
  }
  function renderJobs() {
    const list = jobs.filter((job) => job.project_id === state.projectId), active = list.filter(activeJob), past = list.filter((job) => !activeJob(job));
    const pending = [...submissions.values()].filter((item) => item.id === state.projectId);
    $('#ov-live').textContent = connection === 'live' ? '实时同步' : connection === 'polling' ? '实时连接重连中 · 每 5 秒刷新' : '正在连接任务状态…';
    $('#ov-task-count').textContent = `${active.length} 进行中${pending.length ? ' · ' + pending.length + ' 正在提交' : ''}`;
    $('#jobs').innerHTML = pending.map((item) => `<div class="ov-submitting" role="status">正在提交 ${item.stage} · ${esc(label(item.ref))}…</div>`).join('')
      + (active.map(taskCard).join('') || (!pending.length ? '<div class="ov-idle">当前没有运行中的任务</div>' : ''));
    $('#ov-history-count').textContent = `${past.length} 条${past.some((job) => job.status === 'failed') ? ' · ' + past.filter((job) => job.status === 'failed').length + ' 条失败' : ''}`;
    $('#ov-history').innerHTML = past.map(taskCard).join('') || '<div class="empty">还没有历史任务。</div>';
    $('#ov-history-wrap').open = historyOpen;
    $('#tab-pipeline').querySelectorAll('[data-ov-cancel]').forEach((button) => button.onclick = () => cancel(Number(button.dataset.ovCancel)));
    $('#tab-pipeline').querySelectorAll('[data-ov-job-go]').forEach((button) => button.onclick = () => {
      const job = list.find((item) => item.id === Number(button.dataset.ovJobGo));
      if (job.ref?.startsWith('panel:')) focusImage(job.ref);
      else if (job.ref?.startsWith('page:') && jobStage(job)?.id === 'S5') { state._composeSelected = job.ref; switchTab('compose'); }
      else switchTab(jobStage(job)?.tab || 'pipeline');
    });
    $('#tab-pipeline').querySelectorAll('[data-ov-job-detail]').forEach((button) => button.onclick = () => showFailure(Number(button.dataset.ovJobDetail)));
    $('#tab-pipeline').querySelectorAll('[data-ov-retry]').forEach((button) => button.onclick = async () => {
      const job = list.find((item) => item.id === Number(button.dataset.ovRetry)), origin = state.projectId;
      if (!job) return;
      stage = jobStage(job).id;
      targets[stage] = job.ref;
      await load({ quiet: true });
      if (origin !== state.projectId) return;
      $('#ov-action').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('#ov-feedback').textContent = `已定位任务 #${job.id} 的处理阶段，请核对当前目标与参数后重新提交。`;
    });
  }
  async function showFailure(id) {
    const origin = state.projectId;
    try {
      const job = await api(`/api/jobs/${id}`);
      if (origin !== state.projectId) return;
      const dialog = document.createElement('div'); dialog.className = 'modal';
      dialog.innerHTML = `<div class="box ov-error-dialog"><h3>任务 #${id} · ${esc(jobStage(job)?.name || job.kind)}失败</h3><div class="txt">${esc((job.error || '').split('\n')[0] || '没有记录错误详情')}</div><details><summary>技术详情</summary><pre>${esc(job.error || '')}</pre></details><div class="row"><button class="sm" data-close>关闭</button></div></div>`;
      document.body.appendChild(dialog);
      const close = () => { dialog.remove(); window.removeEventListener('keydown', escape); };
      const escape = (event) => { if (event.key === 'Escape') close(); };
      dialog.querySelector('[data-close]').onclick = close; dialog.onclick = (event) => { if (event.target === dialog) close(); }; window.addEventListener('keydown', escape);
    } catch (error) { toast('读取失败：' + error.message, 'err'); }
  }
  async function cancel(id) {
    if (cancelling.has(id)) return;
    cancelling.add(id); renderJobs();
    try {
      const result = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
      if (!result.ok) throw new Error('任务已结束或无法取消，请刷新状态');
      const job = jobs.find((item) => item.id === id); if (job) job.cancel_requested = true;
      toast(`已请求取消任务 #${id}`, 'ok'); await refreshTasks();
    } catch (error) { toast(error.message, 'err'); await refreshTasks(); }
    finally { cancelling.delete(id); renderJobs(); }
  }
  async function refreshTasks() {
    const id = state.projectId, epoch = jobsEpoch;
    if (!id) return;
    try {
      const list = await api(`/api/jobs?project_id=${id}`);
      if (id === state.projectId && epoch === jobsEpoch) onJobs(list);
    } catch { if (id === state.projectId && epoch === jobsEpoch) $('#ov-live').textContent = '任务状态读取失败，可点刷新重试'; }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer); if (visible()) refreshTimer = setTimeout(() => load({ quiet: true }), 400);
  }
  function onJobs(list) {
    const next = list.filter((job) => job.project_id === state.projectId);
    for (let index = 0; index < next.length; index++) {
      const incoming = next[index], previous = jobs.find((job) => job.id === incoming.id);
      accepted.delete(incoming.id);
      if (previous && ((!activeJob(previous) && activeJob(incoming)) || (previous.status === 'running' && incoming.status === 'queued'))) next[index] = previous;
    }
    for (const [id, task] of accepted) if (!next.some((job) => job.id === id)) next.unshift(task);
    const signature = (items) => JSON.stringify(items.map((job) => [job.id, job.status, job.progress, job.total]));
    const changed = signature(next) !== signature(jobs);
    jobs = next; jobsEpoch++;
    renderJobs(); if (scoped()) { renderSteps(); renderAction(); renderPanelTasks(); }
    if (changed) scheduleRefresh();
  }
  function onConnection(value) { connection = value; renderJobs(); }
  function onGates(stages) {
    if (!scoped()) return;
    const changed = JSON.stringify(board.stages) !== JSON.stringify(stages);
    board.stages = stages; renderSteps();
    if (changed) scheduleRefresh();
  }
  $('#ov-refresh').onclick = () => { $('#ov-refresh').disabled = true; load(); refreshTasks(); refreshGates(); };
  $('#ov-history-wrap').addEventListener('toggle', () => { historyOpen = $('#ov-history-wrap').open; });
  setInterval(() => {
    if (!visible()) return;
    $('#tab-pipeline').querySelectorAll('[data-ov-duration]').forEach((element) => {
      const job = jobs.find((item) => item.id === Number(element.dataset.ovDuration)); if (job) element.textContent = duration(job);
    });
  }, 1000);
  return { load, reset, submit, onJobs, onGates, onConnection, refreshTasks, version: () => jobsEpoch };
}
