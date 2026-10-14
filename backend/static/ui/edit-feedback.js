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

  function track({ element, group, label, read, write, auto = false, saveButton, status, onSaved }) {
    let saved = JSON.stringify(read());
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
        : dirty() ? (auto ? '修改未保存，停止输入后自动保存' : '有未保存的修改') : '已保存';
      if (saveButton) { saveButton.disabled = !!running || locked; saveButton.textContent = running ? '保存中…' : baselineButton; }
    }
    function changed() {
      if (disposed) return;
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
    function flush() {
      clearTimeout(timer);
      if (disposed) return Promise.resolve(true);
      if (running) return running;
      if (!dirty()) { failure = ''; render(); return Promise.resolve(true); }
      // 推迟到微任务，保证即使同步校验失败也能在 finally 中清掉 running。
      running = Promise.resolve().then(persist); render();
      return running;
    }
    const entry = {
      group, label, auto, dirty, flush, snapshot,
      get saving() { return !!running; },
      get failed() { return !!failure; },
      lock(value) { locked = value; render(); },
      accept() { if (!running) { saved = snapshot(); failure = ''; render(); } },
      changed,
      dispose() {
        disposed = true; clearTimeout(timer); entries.delete(entry);
        element.removeEventListener('input', changed); element.removeEventListener('change', changed);
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
  window.addEventListener('beforeunload', (event) => {
    if (![...entries].some((entry) => entry.dirty() || entry.saving)) return;
    event.preventDefault(); event.returnValue = '';
  });
  return { track, flush, prepare, clear, unsettled, snapshot };
}
