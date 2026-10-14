/* 主工作台的编辑会话；MED 内部调用全部留在 editor_bridge 中。 */
export function createEditorWorkbench({ state, api, $, toast, switchTab, loadCompose, refreshGates, pageLabel }) {
  let session = 0;
  let pagesRequest = 0;
  let loadTimer;
  const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function collapse() {
    document.body.classList.remove('editor-expanded');
    $('#ed-expand').setAttribute('aria-pressed', 'false');
    $('#ed-expand').textContent = '扩大画布';
  }

  function reset() {
    session++; clearTimeout(loadTimer);
    state.editor = null;
    state._editorPages = [];
    const frame = $('#ed-frame'); frame.removeAttribute('src'); frame.classList.add('hidden');
    $('#ed-empty').classList.remove('hidden');
    $('#ed-empty').textContent = '选择漫画页后，可在这里编辑图层、气泡、文字和构图。';
    $('#ed-save').disabled = true; $('#ed-window').disabled = true;
    $('#ed-state').className = 'pill'; $('#ed-state').textContent = '未打开';
    collapse();
  }

  async function loadPages() {
    const projectId = state.projectId;
    const request = ++pagesRequest;
    const select = $('#ed-page');
    if (!projectId) {
      select.innerHTML = '<option value="">先选择项目</option>';
      $('#ed-message').textContent = '请先到「项目」选择一部漫画，再打开它的漫画页。';
      return;
    }
    try {
      const board = await api(`/api/projects/${projectId}/compose-board`);
      if (state.projectId !== projectId || request !== pagesRequest) return;
      state._editorPages = board.pages || [];
      select.innerHTML = '<option value="">选择要编辑的漫画页</option>' + state._editorPages.map((p) =>
        `<option value="${esc(p.page_ref)}">${esc(pageLabel(p.page_ref))} · ${p.med_doc_id ? '已保存画布' : (p.ready ? '图片已就绪' : '可先编辑版式')}</option>`).join('');
      if (state.editor?.projectId === projectId) select.value = state.editor.pageRef;
      if (!state._editorPages.length) {
        $('#ed-message').textContent = '当前项目还没有分格页，请先到「分格分页」添加一页。';
      } else if (!state.editor && !$('#tab-editor').classList.contains('hidden')) {
        let last = '';
        try { last = localStorage.getItem(`comic.editor.page.${projectId}`) || ''; } catch { /* 私密浏览 */ }
        const page = state._editorPages.find((p) => p.page_ref === last) || state._editorPages[0];
        open(page.page_ref, page.med_doc_id ? 'edit=1' : 'auto=1');
      }
    } catch (e) {
      if (state.projectId === projectId && request === pagesRequest) $('#ed-message').textContent = '加载漫画页失败：' + e.message;
    }
  }

  async function open(pageRef, mode = 'edit=1') {
    const projectId = state.projectId;
    if (!projectId) { switchTab('projects'); return toast('先选择一个项目', 'err'); }
    const current = state.editor;
    if (current?.projectId === projectId && current.pageRef === pageRef && (current.ready || current.loading) && mode !== 'plain=1') {
      switchTab('editor'); return;
    }
    if (current?.dirty && !confirm('当前漫画页有未保存的修改。重新打开或切换页会丢失这些修改，确定继续吗？')) {
      $('#ed-page').value = current.pageRef; return;
    }
    const key = ++session;
    clearTimeout(loadTimer);
    state.editor = { projectId, pageRef, mode, session: key, dirty: false, ready: false, loading: true };
    switchTab('editor');
    try { localStorage.setItem(`comic.editor.page.${projectId}`, pageRef); } catch { /* 私密浏览 */ }
    const frame = $('#ed-frame'); frame.classList.add('hidden');
    $('#ed-empty').classList.remove('hidden'); $('#ed-empty').textContent = '正在加载漫画编辑器…';
    $('#ed-state').className = 'pill run'; $('#ed-state').textContent = '加载中';
    $('#ed-save').disabled = true; $('#ed-window').disabled = true;
    $('#ed-message').textContent = `${pageLabel(pageRef)} · 正在打开${mode === 'edit=1' ? '已保存画布' : '漫画页'}…`;
    try {
      const response = await fetch('/editor/');
      if (!response.ok) throw new Error('尚未安装 Manga Editor Desu，请按 README 运行 fetch_editor 脚本后重试');
      if (key !== session || state.projectId !== projectId) return;
      frame.src = `/ui/editor_bridge/index.html?page=${encodeURIComponent(pageRef)}&p=${projectId}&${mode}&embedded=1&session=${key}`;
      frame.classList.remove('hidden'); $('#ed-empty').classList.add('hidden');
      $('#ed-window').disabled = false;
      loadTimer = setTimeout(() => {
        if (key === session && !state.editor?.ready) $('#ed-message').textContent = '编辑器仍在加载，可以稍等或通过「独立窗口」检查编辑器是否正常。';
      }, 25000);
    } catch (e) {
      if (key !== session) return;
      state.editor.loading = false;
      $('#ed-state').className = 'pill err'; $('#ed-state').textContent = '加载失败';
      const message = document.createElement('p'); message.textContent = e.message;
      const retry = document.createElement('button'); retry.className = 'sm'; retry.textContent = '重试加载';
      retry.addEventListener('click', () => open(pageRef, mode));
      $('#ed-empty').replaceChildren(message, retry);
      $('#ed-message').textContent = '现有项目和画布存档仍保留，可修复安装后重试。';
    }
  }

  $('#ed-page').addEventListener('change', (event) => {
    const page = (state._editorPages || []).find((p) => p.page_ref === event.target.value);
    if (page) open(page.page_ref, page.med_doc_id ? 'edit=1' : 'auto=1');
  });
  $('#ed-back').addEventListener('click', () => switchTab('compose'));
  $('#open-editor-workbench').addEventListener('click', () => switchTab('editor'));
  $('#ed-expand').addEventListener('click', () => {
    const expanded = document.body.classList.toggle('editor-expanded');
    $('#ed-expand').textContent = expanded ? '恢复工作台' : '扩大画布';
    $('#ed-expand').setAttribute('aria-pressed', String(expanded));
  });
  $('#ed-save').addEventListener('click', () => {
    if (!state.editor?.ready) return;
    $('#ed-save').disabled = true;
    $('#ed-state').className = 'pill run'; $('#ed-state').textContent = '保存中';
    $('#ed-frame').contentWindow.postMessage({ type: 'comic-editor:command', command: 'save' }, location.origin);
  });
  $('#ed-window').addEventListener('click', () => {
    const editor = state.editor;
    if (!editor) return;
    if (editor.dirty && !confirm('当前页有未保存修改，请先保存以便独立窗口载入。仍要打开已保存的版本吗？')) return;
    const back = encodeURIComponent('/ui/?tab=compose');
    window.open(`/ui/editor_bridge/index.html?page=${encodeURIComponent(editor.pageRef)}&p=${editor.projectId}&edit=1&back=${back}`, '_blank', 'noopener');
  });
  window.addEventListener('message', (event) => {
    const editor = state.editor, data = event.data;
    if (!editor || event.origin !== location.origin || event.source !== $('#ed-frame').contentWindow
      || data?.type !== 'comic-editor:state' || String(data.session) !== String(editor.session)
      || Number(data.projectId) !== editor.projectId || data.pageRef !== editor.pageRef) return;
    if (data.event === 'ready') {
      editor.ready = true; editor.loading = false; clearTimeout(loadTimer); $('#ed-save').disabled = false;
    }
    if (data.event === 'dirty') editor.dirty = true;
    if (data.event === 'saved') {
      editor.dirty = !!data.dirty; $('#ed-save').disabled = false;
      loadCompose(); refreshGates(); loadPages();
      toast(`${pageLabel(editor.pageRef)} 已保存 v${data.version}`, 'ok');
    }
    if (data.event === 'error') { editor.loading = false; $('#ed-save').disabled = !editor.ready; }
    $('#ed-state').className = 'pill ' + (data.event === 'error' ? 'err' : (editor.dirty ? 'warn' : 'ok'));
    $('#ed-state').textContent = data.event === 'error' ? '操作失败' : (editor.dirty ? '未保存修改' : (data.event === 'saved' ? '已保存' : '已就绪'));
    $('#ed-message').textContent = data.message || (editor.dirty ? '当前页有未保存修改，点击「保存漫画页」写入新版本。' : '可编辑图层、气泡和文字，保存后继续留在当前页。');
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.editor?.dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  return { open, reset, collapse, loadPages };
}
