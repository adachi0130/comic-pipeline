export function createProviderManager({ api, $, esc, toast, editFeedback, refreshBindings }) {
  let editingId = null, request = 0, busy = false;
  const fields = ['pv-name', 'pv-url', 'pv-model', 'pv-key'];
  const panel = $('[data-settings-panel="providers"]');
  const status = document.createElement('div'); status.className = 'save-feedback'; status.id = 'pv-form-status';
  $('#pvlist').before(status);
  const read = () => ({ id: editingId, name: $('#pv-name').value.trim(), base_url: $('#pv-url').value.trim(),
    model: $('#pv-model').value.trim(), key: $('#pv-key').value.trim() });
  const draft = editFeedback.track({
    element: panel, group: 'provider-form', label: '供应商', status, read, busyCheck: () => busy,
    savedText: () => editingId === null ? '填写后点击添加供应商' : '未修改',
    write: async ({ id, key, ...body }) => {
      if (!body.name || !body.base_url || !body.model) throw new Error('请填写名称、base_url 和模型');
      if (key || id === null) body.api_key = key;
      await api(id === null ? '/api/providers' : `/api/providers/${id}`, { method: id === null ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    },
  });
  function canReplace() {
    if (busy || draft.saving) { toast('供应商正在保存，请稍候。'); return false; }
    return !draft.dirty() || confirm('供应商表单有未保存的修改。更换编辑项会放弃这些修改，确定继续吗？');
  }
  function reset() {
    editingId = null; fields.forEach((id) => { $('#' + id).value = ''; });
    $('#pv-key').placeholder = 'API Key（可选）'; $('#btn-addpv').textContent = '添加供应商';
    $('#pv-cancel-edit').textContent = '清空表单'; draft.accept();
  }
  async function locked(action) {
    if (busy || draft.saving) return;
    busy = true;
    const controls = [...panel.querySelectorAll('input, button')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try { await action(); }
    finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  }
  async function load() {
    const key = ++request, box = $('#pvlist');
    try {
      const rows = await api('/api/providers'); if (key !== request) return;
      box.innerHTML = rows.length ? rows.map((provider) => `<div class="pitem" style="cursor:default;flex-wrap:wrap"><div style="min-width:0;overflow-wrap:anywhere"><b>${esc(provider.name)}</b> <span class="mut">${esc(provider.model)}</span>
        <div class="meta">${esc(provider.base_url)} ${provider.has_key ? '· 已设 Key' : '· 无 Key'} · ${provider.enabled ? '启用' : '停用'}</div></div>
        <div class="spacer"></div><button class="sm" data-pv-edit="${provider.id}">编辑</button><button class="sm" data-test="${provider.id}">测试</button>
        <button class="sm" data-pv-toggle="${provider.id}">${provider.enabled ? '停用' : '启用'}</button></div>`).join('') : '<div class="empty">尚未配置供应商，可在上方添加或从酒馆导入。</div>';
      box.querySelectorAll('[data-pv-edit]').forEach((button) => button.addEventListener('click', () => {
        if (!canReplace()) return;
        const provider = rows.find((item) => item.id === Number(button.dataset.pvEdit));
        editingId = provider.id; $('#pv-name').value = provider.name; $('#pv-url').value = provider.base_url;
        $('#pv-model').value = provider.model; $('#pv-key').value = '';
        $('#pv-key').placeholder = provider.has_key ? '已保存 Key，留空不改' : 'API Key（可选）';
        $('#btn-addpv').textContent = '保存修改'; $('#pv-cancel-edit').textContent = '取消编辑'; draft.accept(); $('#pv-name').focus();
      }));
      box.querySelectorAll('[data-test]').forEach((button) => button.addEventListener('click', async () => {
        if (busy || button.disabled) return; button.disabled = true;
        try {
          const result = await api(`/api/providers/${button.dataset.test}/test`, { method: 'POST' });
          toast(result.ok ? `可用：${result.reply}` : `失败：${result.error}`, result.ok ? 'ok' : 'err');
        } catch (error) { toast(error.message, 'err'); }
        finally { button.disabled = false; }
      }));
      box.querySelectorAll('[data-pv-toggle]').forEach((button) => button.addEventListener('click', async () => {
        if (busy || button.disabled) return; button.disabled = true;
        const provider = rows.find((item) => item.id === Number(button.dataset.pvToggle));
        try { await api(`/api/providers/${provider.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !provider.enabled }) }); await load(); }
        catch (error) { toast(error.message, 'err'); button.disabled = false; }
      }));
    } catch (error) { if (key === request) box.innerHTML = `<div class="empty">读取供应商失败：${esc(error.message)}，点击刷新重试。</div>`; }
  }
  $('#pv-cancel-edit').addEventListener('click', () => { if (canReplace()) reset(); });
  $('#btn-addpv').addEventListener('click', () => locked(async () => {
    const button = $('#btn-addpv'), label = button.textContent; button.textContent = '保存中…';
    try {
      if (!(await draft.flush(true))) return;
      toast('供应商已保存', 'ok'); reset(); await load();
    } finally { if (draft.dirty()) button.textContent = label; }
  }));
  $('#btn-reloadpv').addEventListener('click', load);
  $('#btn-import-tv').addEventListener('click', () => locked(async () => {
    try {
      const imported = await api('/api/providers/import-tavern', { method: 'POST', body: '{}' });
      if (!imported.found || !imported.has_key) throw new Error('酒馆配置或 Key 不完整，请手动填写');
      await api('/api/providers', { method: 'POST', body: JSON.stringify({
        name: imported.name, base_url: imported.base_url, model: imported.model, api_key: imported.api_key }) });
      // 导入独立供应商，不覆盖当前表单里尚未保存的内容。
      toast(`已导入：${imported.model}`, 'ok'); await load(); refreshBindings();
    } catch (error) { toast('导入失败：' + error.message, 'err'); }
  }));
  return { load };
}
