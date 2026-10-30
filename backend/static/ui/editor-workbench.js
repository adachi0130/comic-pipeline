/* 主页面漫画工作区，不使用 iframe；会话绑定发起操作的项目与页。 */
import { createComicEditor } from './editor/comicEditor.mjs';

export function createEditorWorkbench({ state, api, $, toast, switchTab, loadCompose, refreshGates, pageLabel }) {
  let session = 0, pagesRequest = 0, instance = null;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const editorApi = (path, options = {}) => api(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const badgeOf = (p) => p.editor_doc_id ? '已保存' : p.med_doc_id ? '旧存档' : p.ready ? '图片就绪' : '待出图';
  const current = (key, projectId) => session === key && state.projectId === projectId;

  function collapse() {
    document.body.classList.remove('editor-expanded');
    $('#ed-expand').setAttribute('aria-pressed', 'false'); $('#ed-expand').textContent = '专注画布';
  }
  function reset() {
    session++; pagesRequest++; instance?.dispose(); instance = null;
    state.editor = null; state._editorPages = [];
    $('#ed-host').classList.add('hidden'); $('#ed-empty').classList.remove('hidden');
    $('#ed-empty').textContent = '选择漫画页，开始编辑'; $('#ed-pages').innerHTML = '';
    $('#ed-save').disabled = true; $('#ed-window').disabled = true;
    $('#ed-state').className = 'pill'; $('#ed-state').textContent = '未打开'; collapse();
  }
  function renderPages() {
    const pages = state._editorPages || [];
    $('#ed-pages').innerHTML = pages.map((p) => `<button type="button" class="ed-page-tab${state.editor?.pageRef === p.page_ref ? ' active' : ''}" data-editor-page="${esc(p.page_ref)}" aria-pressed="${state.editor?.pageRef === p.page_ref}"><span class="ed-page-no">${esc(p.page_ref.split(':')[1].padStart(2, '0'))}</span><span>${esc(pageLabel(p.page_ref))}</span><small>${esc(badgeOf(p))}</small></button>`).join('');
    $('#ed-page').innerHTML = '<option value="">选择漫画页</option>' + pages.map((p) => `<option value="${esc(p.page_ref)}">${esc(pageLabel(p.page_ref))} · ${esc(badgeOf(p))}</option>`).join('');
    $('#ed-page').value = state.editor?.pageRef || '';
    $('#ed-page-count').textContent = `${pages.length} 页`;
    $('#ed-project-title').textContent = state.project?.title || '漫画编辑器';
  }
  async function loadPages() {
    const projectId = state.projectId, request = ++pagesRequest;
    if (!projectId) { $('#ed-message').textContent = '请先选择一部漫画。'; return; }
    try {
      const board = await api(`/api/projects/${projectId}/compose-board`);
      if (state.projectId !== projectId || request !== pagesRequest) return;
      state._editorPages = board.pages || []; renderPages();
      if (!state._editorPages.length) $('#ed-message').textContent = '当前项目还没有分格页，请到「分格分页」添加一页。';
      else if (!state.editor && !$('#tab-editor').classList.contains('hidden')) {
        let last = ''; try { last = localStorage.getItem(`comic.editor.page.${projectId}`) || ''; } catch {}
        await open((state._editorPages.find((p) => p.page_ref === last) || state._editorPages[0]).page_ref);
      }
    } catch (error) {
      if (state.projectId === projectId && request === pagesRequest) $('#ed-message').textContent = `加载漫画页失败：${error.message}`;
    }
  }
  async function open(pageRef) {
    const projectId = state.projectId;
    if (!projectId) { switchTab('projects'); toast('先选择一个项目', 'err'); return; }
    const previous = state.editor;
    if (previous?.projectId === projectId && previous.pageRef === pageRef && (previous.ready || previous.loading)) {
      switchTab('editor'); requestAnimationFrame(() => instance?.render()); return;
    }
    if (previous?.dirty && !confirm('当前漫画页有未保存的修改。切换页会丢失这些修改，确定继续吗？')) { $('#ed-page').value = previous.pageRef; return; }
    const key = ++session; instance?.dispose();
    state.editor = { projectId, pageRef, session: key, dirty: false, ready: false, loading: true };
    switchTab('editor'); renderPages();
    try { localStorage.setItem(`comic.editor.page.${projectId}`, pageRef); } catch {}
    const host = $('#ed-host'); host.classList.remove('hidden'); $('#ed-empty').classList.add('hidden');
    $('#ed-state').className = 'pill run'; $('#ed-state').textContent = '加载中';
    $('#ed-save').disabled = true; $('#ed-window').disabled = true;
    $('#ed-message').textContent = `${pageLabel(pageRef)} · 正在打开…`;
    const setState = (message, error = false) => {
      if (!current(key, projectId)) return;
      $('#ed-state').className = `pill ${error ? 'err' : state.editor.dirty ? 'warn' : 'ok'}`;
      $('#ed-state').textContent = error ? '操作失败' : state.editor.dirty ? '未保存' : '已就绪';
      if (message) $('#ed-message').textContent = message;
    };
    const editor = createComicEditor({ host, api: editorApi,
      onDirty(dirty) { if (current(key, projectId)) { state.editor.dirty = dirty; setState(dirty ? '当前页有未保存修改。' : '当前页已保存。'); } },
      onNotice(message, kind) { setState(message, kind === 'error'); },
      onSaved(payload) {
        if (!current(key, projectId)) return;
        state.editor.dirty = editor.isDirty();
        setState(payload.has_preview ? `已保存 v${payload.version} · 整页预览已更新` : `画布已保存 v${payload.version}，整页预览未生成，请重试。`);
        loadCompose(); refreshGates(); loadPages();
        toast(`${pageLabel(pageRef)} 已保存 v${payload.version}`, payload.has_preview ? 'ok' : '');
      },
    });
    instance = editor;
    try {
      await editor.load(projectId, pageRef);
      if (!current(key, projectId)) return;
      state.editor.ready = true; $('#ed-save').disabled = false; $('#ed-window').disabled = false; setState();
    } catch (error) { setState(`打开失败：${error.message}，可重新选择本页重试。`, true); }
    finally { if (current(key, projectId)) state.editor.loading = false; }
  }
  $('#ed-page').addEventListener('change', (e) => { if (e.target.value) open(e.target.value); });
  $('#ed-pages').addEventListener('click', (e) => { const p = e.target.closest('[data-editor-page]'); if (p) open(p.dataset.editorPage); });
  $('#ed-back').addEventListener('click', () => switchTab('compose'));
  $('#ed-overview').addEventListener('click', () => switchTab('pipeline'));
  $('#ed-export').addEventListener('click', () => switchTab('exports'));
  $('#open-editor-workbench').addEventListener('click', () => switchTab('editor'));
  $('#ed-expand').addEventListener('click', () => {
    const expanded = document.body.classList.toggle('editor-expanded');
    $('#ed-expand').textContent = expanded ? '显示面板' : '专注画布'; $('#ed-expand').setAttribute('aria-pressed', String(expanded));
    requestAnimationFrame(() => instance?.render());
  });
  $('#ed-save').addEventListener('click', async () => {
    if (!state.editor?.ready || !instance) return;
    const editor = instance; $('#ed-save').disabled = true;
    try { await editor.save(); } finally { if (editor === instance) $('#ed-save').disabled = false; }
  });
  $('#ed-window').addEventListener('click', () => {
    const e = state.editor; if (!e) return;
    if (e.dirty && !confirm('独立窗口会载入已保存版本，仍要打开吗？')) return;
    window.open(`/ui/editor/index.html?page=${encodeURIComponent(e.pageRef)}&p=${e.projectId}`, '_blank', 'noopener');
  });
  window.addEventListener('beforeunload', (e) => { if (state.editor?.dirty) { e.preventDefault(); e.returnValue = ''; } });
  return { open, reset, collapse, loadPages, refreshLayout: () => requestAnimationFrame(() => instance?.render()) };
}
