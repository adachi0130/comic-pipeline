// 保存控制器：同一份表单只有一个队列，保存过程中发生的输入继续保留。
export function createEditFeedback({ toast, confirmAction = (message) => window.confirm(message) }) {
  const entries = new Set();
  let writeQueue = Promise.resolve();
  const selected = (groups) => {
    const names = Array.isArray(groups) ? groups : [groups];
    return [...entries].filter((entry) => names.includes(entry.group));
  };
  function enqueue(write) {
    const next = writeQueue.catch(() => {}).then(write);
    writeQueue = next.catch(() => {});
    return next;
  }

  function track({ element, group, label, read, write, auto = false, saveButton, status, onSaved, onDispose, busyCheck, savedValue, savedText = '已保存', watchSelector }) {
    let saved = JSON.stringify(savedValue === undefined ? read() : savedValue);
    let timer = null, running = null, disposed = false, failure = '', locked = false;
    const baselineButton = saveButton?.textContent;
    if (!status) {
      status = document.createElement('div'); status.className = 'save-feedback';
      element.appendChild(status);
    }
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const snapshot = () => JSON.stringify(read());
    const dirty = () => !disposed && snapshot() !== saved;
    function render() {
      if (disposed) return;
      status.dataset.status = running ? 'saving' : failure ? 'failed' : dirty() ? 'dirty' : 'saved';
      status.textContent = running ? '保存中…' : failure ? `保存失败：${failure}；修改已保留，点击保存重试。`
        : dirty() ? (auto ? '修改未保存，停止输入后自动保存' : '有未保存的修改') : (typeof savedText === 'function' ? savedText() : savedText);
      if (saveButton) { saveButton.disabled = !!running || locked; saveButton.textContent = running ? '保存中…' : baselineButton; }
    }
    function changed(event) {
      if (disposed) return;
      if (event && watchSelector && !event.target.matches(watchSelector)) return;
      failure = ''; clearTimeout(timer); render();
      if (auto && dirty()) timer = setTimeout(() => flush(), 700);
    }
    async function persist() {
      try {
        while (!disposed && dirty()) {
          await enqueue(async () => {
            if (disposed || !dirty()) return;
            const body = snapshot();
            await write(JSON.parse(body));
            saved = body; failure = '';
            onSaved?.(JSON.parse(body));
          });
        }
        return !disposed && !dirty();
      } catch (error) { failure = error.message || '请求失败'; return false; }
      finally { running = null; clearTimeout(timer); render(); }
    }
    function flush(force = false) {
      clearTimeout(timer);
      if (disposed) return Promise.resolve(true);
      if (running) return running;
      if (force) saved = null;
      if (!dirty()) { failure = ''; render(); return Promise.resolve(true); }
      // 推迟到微任务，保证即使同步校验失败也能在 finally 中清掉 running。
      running = Promise.resolve().then(persist); render();
      return running;
    }
    const entry = {
      group, label, auto, dirty, flush, snapshot,
      get saving() { return !!running || !!busyCheck?.(); },
      get failed() { return !!failure; },
      lock(value) { locked = value; render(); },
      accept() { if (!running) { saved = snapshot(); failure = ''; render(); } },
      changed,
      dispose() {
        if (disposed) return;
        disposed = true; clearTimeout(timer); entries.delete(entry);
        element.removeEventListener('input', changed); element.removeEventListener('change', changed);
        onDispose?.();
      },
    };
    element.addEventListener('input', changed); element.addEventListener('change', changed);
    if (saveButton) saveButton.addEventListener('click', async () => {
      if (await flush()) toast(label + '已保存', 'ok');
    });
    entries.add(entry); render(); return entry;
  }

  async function flush(groups) {
    for (const entry of selected(groups)) {
      if (!entry.auto) continue;
      if (!(await entry.flush())) { toast(entry.label + '未保存，请先在原卡片重试。', 'err'); return false; }
    }
    return !selected(groups).some((entry) => entry.auto && (entry.dirty() || entry.saving));
  }
  async function prepare(groups, action) {
    if (!(await flush(groups))) return false;
    const manual = selected(groups).filter((entry) => !entry.auto && (entry.dirty() || entry.saving));
    if (manual.some((entry) => entry.saving)) { toast('正在保存，请完成后再' + action); return false; }
    return !manual.length || confirmAction(`${manual.map((entry) => entry.label).join('、')}有未保存的修改。${action}会放弃这些修改，确定继续吗？`);
  }
  const clear = (groups) => selected(groups).forEach((entry) => entry.dispose());
  const unsettled = (groups) => selected(groups).some((entry) => entry.dirty() || entry.saving);
  const snapshot = (groups) => selected(groups).map((entry) => entry.snapshot()).join('\n');
  function protectDialog({ box, label, read, write, saveButton, afterSave, closeOnSave = true, extraButtons = [] }) {
    const status = document.createElement('div'); status.className = 'save-feedback';
    box.querySelector('.box').appendChild(status);
    let busy = false;
    const draft = track({ element: box, group: 'project-dialog', label, read, write, status, busyCheck: () => busy,
      onDispose: () => { window.removeEventListener('keydown', onEscape); box.remove(); } });
    const buttonText = saveButton.textContent;
    const close = (force = false) => {
      if (!force && (busy || draft.saving)) { toast('正在保存，请稍候。'); return false; }
      if (!force && draft.dirty() && !confirmAction(`${label}有未保存的修改。关闭会放弃这些修改，确定继续吗？`)) return false;
      draft.dispose(); window.removeEventListener('keydown', onEscape); box.remove(); return true;
    };
    const onEscape = (event) => {
      if (event.key === 'Escape' && [...document.querySelectorAll('.modal:not(.hidden)')].at(-1) === box) close();
    };
    window.addEventListener('keydown', onEscape);
    box.querySelector('[data-close]')?.addEventListener('click', () => close());
    box.addEventListener('click', (event) => { if (event.target === box) close(); });
    async function save() {
      if (busy || draft.saving) return false;
      busy = true;
      const controls = [saveButton, ...extraButtons];
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => { control.disabled = true; }); saveButton.textContent = '保存中…';
      try {
        if (!(await draft.flush())) return false;
        toast(label + '已保存', 'ok');
        if (closeOnSave) close(true);
        try { await afterSave?.(); } catch (error) { toast('内容已保存，刷新失败：' + error.message, 'err'); }
        return true;
      } finally {
        busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); saveButton.textContent = buttonText;
      }
    }
    saveButton.addEventListener('click', save);
    async function operation(action) {
      if (busy || draft.saving) return false;
      busy = true;
      const controls = [...box.querySelectorAll('input, textarea, button')];
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => { control.disabled = true; });
      try { await action(); return true; }
      finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
    }
    return { draft, close, save, operation };
  }
  window.addEventListener('beforeunload', (event) => {
    if (![...entries].some((entry) => entry.dirty() || entry.saving)) return;
    event.preventDefault(); event.returnValue = '';
  });
  return { track, flush, prepare, clear, unsettled, snapshot, protectDialog };
}
