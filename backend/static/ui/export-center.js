export function createExportCenter({ state, api, $, esc, pill, toast, switchTab, pageLabel }) {
  let request = 0;
  let board = null;
  let jobs = [];
  let submitting = false;
  let observedJob = '';
  const active = () => jobs.find((job) => job.status === 'queued' || job.status === 'running');
  const currentBoard = () => board?.project_id === state.projectId;

  function updateRunButton() {
    $('#export-run').disabled = submitting || !currentBoard() || !board.ready || !!active();
  }

  function renderTask() {
    const job = active() || jobs[0];
    const box = $('#export-task');
    if (!job) { box.innerHTML = ''; updateRunButton(); return; }
    const running = job.status === 'queued' || job.status === 'running';
    const progress = job.total ? Math.min(100, Math.round(100 * job.progress / job.total)) : (job.status === 'done' ? 100 : 0);
    box.innerHTML = `<div class="export-task"><div class="row"><b>导出任务 #${job.id}</b>${pill(job.status)}
      <span class="mut">${esc(job.message || (running ? '正在生成成册文件…' : ''))}</span><div class="spacer"></div>
      ${running ? `<button class="sm" id="export-cancel">取消导出</button>` : ''}</div>
      <progress max="100" value="${progress}" aria-label="导出进度" style="width:100%;height:6px;margin-top:8px"></progress></div>`;
    if (job.status === 'failed' && job.error) box.insertAdjacentHTML('beforeend', `<div class="export-hint warn">${esc(job.error)}</div>`);
    box.querySelector('#export-cancel')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const result = await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' });
        if (!result.ok) throw new Error('任务已结束或无法取消，请刷新结果');
        toast('已请求取消导出', 'ok');
      } catch (e) { toast(e.message, 'err'); event.target.disabled = false; }
    });
    updateRunButton();
  }

  function render() {
    const included = board.pages.filter((page) => page.included);
    const missing = board.pages.filter((page) => !page.included);
    $('#export-summary').innerHTML = `<div class="export-stat"><b>${included.length}</b><span>本次导出页</span></div>
      <div class="export-stat"><b>${missing.length}</b><span>未纳入页</span></div>
      <div class="export-stat"><b>${board.target_pages}</b><span>项目目标页数</span></div>`;
    $('#export-hint').textContent = board.hint || (missing.length
      ? `按页码导出 ${included.length} 页；另有 ${missing.length} 页尚未成图或通过审核，不会纳入本次成册。`
      : `按页码导出全部 ${included.length} 页，图片使用当前已通过版本。`);
    $('#export-hint').className = 'export-hint ' + (board.ready ? '' : 'warn');
    $('#export-pages').innerHTML = board.pages.length ? board.pages.map((page) => `<div class="export-page ${page.included ? 'included' : ''}">
      <div class="export-thumb">${page.image_url ? `<img src="${esc(page.image_url)}" alt="${esc(pageLabel(page.ref))}整页预览" loading="lazy">`
        : `<span>${page.file_state === 'missing' ? '图片文件缺失' : (page.file_state === 'blocked' ? '图片不可访问' : '尚未保存整页')}</span>`}</div>
      <div class="export-page-info"><div class="row"><b>${esc(pageLabel(page.ref))}</b>${pill(page.status)}</div>
        <div class="mut">${page.included ? '✓ 纳入导出' : '未纳入'}${page.version ? ' · v' + page.version : ''}</div>
        <button class="sm" type="button" data-export-edit="${esc(page.ref)}">查看 / 编辑</button></div>
    </div>`).join('') : '<div class="empty">还没有漫画页，先完成分格、出图和分页合成。</div>';
    $('#export-pages').querySelectorAll('[data-export-edit]').forEach((button) => button.addEventListener('click', () => {
      state._composeSelected = button.dataset.exportEdit; switchTab('compose');
    }));
    $('#export-history').innerHTML = board.history.length ? board.history.map((version) => `<div class="export-version">
      <div><div class="row"><b>版本 ${version.version}</b>${version.is_current ? '<span class="pill tag">当前版本</span>' : ''}${pill(version.status)}</div>
        <div class="mut">${version.pages} 页${version.created_at ? ' · ' + esc(new Date(version.created_at + (version.created_at.endsWith('Z') || version.created_at.includes('+') ? '' : 'Z')).toLocaleString('zh-CN')) : ''}</div>
        ${version.status === 'stale' ? '<div class="mut">上游页面已修改，可下载旧文件，或重新导出更新版本。</div>' : ''}</div>
      <div class="row">${version.formats.map((format) => `<a class="download-button" href="/api/artifacts/${version.id}/download/${format}">下载 ${format.toUpperCase()}</a>`).join('')}</div>
    </div>`).join('') : '<div class="empty">还没有导出版本。选择格式并点击「生成成册文件」。</div>';
    renderTask();
  }

  async function load() {
    const projectId = state.projectId;
    const version = ++request;
    if (board?.project_id !== projectId) {
      $('#export-summary').innerHTML = ''; $('#export-history').innerHTML = ''; $('#export-task').innerHTML = '';
    }
    board = null; jobs = []; updateRunButton();
    if (!projectId) {
      $('#export-summary').innerHTML = '';
      $('#export-pages').innerHTML = '<div class="empty">先从左侧选择一个漫画项目。</div>';
      $('#export-history').innerHTML = ''; $('#export-hint').textContent = '选择项目后可预览整页、生成成册文件和下载历史版本。';
      renderTask(); return;
    }
    $('#export-pages').innerHTML = '<div class="empty">正在加载当前项目的漫画页…</div>';
    try {
      const [data, taskList] = await Promise.all([
        api(`/api/projects/${projectId}/export-board`), api(`/api/jobs?project_id=${projectId}`),
      ]);
      if (version !== request || projectId !== state.projectId) return;
      board = data; jobs = taskList.filter((job) => job.stage === 'S6' || job.kind === 'book');
      render();
    } catch (e) {
      if (version !== request || projectId !== state.projectId) return;
      $('#export-pages').innerHTML = `<div class="empty">加载失败：${esc(e.message)}，可点击刷新重试。</div>`;
      $('#export-history').innerHTML = ''; $('#export-summary').innerHTML = ''; $('#export-task').innerHTML = '';
      $('#export-hint').textContent = ''; updateRunButton();
    }
  }

  function onJobs(list) {
    jobs = list.filter((job) => job.project_id === state.projectId && (job.stage === 'S6' || job.kind === 'book'));
    if (!currentBoard()) return;
    const job = active() || jobs[0];
    const marker = job ? `${job.id}:${job.status}` : '';
    const terminal = job && ['done', 'failed', 'cancelled'].includes(job.status);
    if (terminal && marker !== observedJob && !$('#tab-exports').classList.contains('hidden')) {
      observedJob = marker; load(); return;
    }
    observedJob = marker; renderTask();
  }

  $('#export-refresh').addEventListener('click', load);
  $('#export-compose').addEventListener('click', () => switchTab('compose'));
  $('#export-format').addEventListener('change', (event) => {
    try { localStorage.setItem('comic.exportFormat', event.target.value); } catch { /* 私密浏览 */ }
  });
  try {
    const format = localStorage.getItem('comic.exportFormat');
    if (['pdf', 'cbz', 'both'].includes(format)) $('#export-format').value = format;
  } catch { /* 私密浏览 */ }
  $('#export-run').addEventListener('click', async () => {
    if (!currentBoard() || !board.ready || active() || submitting) return;
    const projectId = state.projectId;
    submitting = true; updateRunButton();
    try {
      const result = await api(`/api/projects/${projectId}/run/S6`, { method: 'POST', body: JSON.stringify({
        format: $('#export-format').value, page_artifact_ids: board.page_artifact_ids,
      }) });
      toast(`导出已入队 #${result.job_id}`, 'ok');
      if (state.projectId === projectId) await load();
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
    finally { submitting = false; updateRunButton(); }
  });
  return { load, onJobs };
}
