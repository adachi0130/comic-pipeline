import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditFeedback } from '../backend/static/ui/edit-feedback.js';

class Element extends EventTarget {
  constructor() { super(); this.dataset = {}; this.textContent = '保存'; this.disabled = false; this.children = []; }
  appendChild(child) { this.children.push(child); }
  setAttribute() {}
}
const listeners = new Map();
globalThis.window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} };
globalThis.document = { createElement: () => new Element() };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture(t, options = {}) {
  const messages = [];
  const feedback = createEditFeedback({ toast: (...args) => messages.push(args), ...options });
  t.after(() => feedback.clear(['cards', 'style']));
  return { feedback, messages };
}
function card(feedback, { write = async () => {}, auto = false, group = 'cards' } = {}) {
  const element = new Element(), button = new Element(), status = new Element();
  const data = { text: 'original', weight: 0 };
  const editor = feedback.track({ element, group, label: '表单', read: () => data, write, auto, saveButton: button, status });
  const input = (text) => { data.text = text; element.dispatchEvent(new Event('input')); };
  return { element, button, status, data, editor, input };
}

test('保存途中的新输入继续保存，重复保存共享请求且保留零权重', async (t) => {
  const { feedback } = fixture(t), pending = deferred(), writes = [];
  const c = card(feedback, { write: async (body) => { writes.push(body); if (writes.length === 1) await pending.promise; } });
  c.input('first'); const saving = c.editor.flush(); await tick();
  assert.equal(c.button.disabled, true); assert.equal(c.status.dataset.status, 'saving');
  c.input('latest'); assert.equal(c.editor.flush(), saving);
  assert.equal(writes.length, 1); pending.resolve(); assert.equal(await saving, true);
  assert.deepEqual(writes, [{ text: 'first', weight: 0 }, { text: 'latest', weight: 0 }]);
  assert.equal(c.editor.dirty(), false); assert.equal(c.button.disabled, false); assert.equal(c.status.dataset.status, 'saved');
});

test('恢复原文发生在保存途中时仍写回原文', async (t) => {
  const { feedback } = fixture(t), pending = deferred(), writes = [];
  const c = card(feedback, { write: async (body) => { writes.push(body.text); if (writes.length === 1) await pending.promise; } });
  c.input('change'); const saving = c.editor.flush(); await tick(); c.input('original'); pending.resolve();
  assert.equal(await saving, true); assert.deepEqual(writes, ['change', 'original']);
});

test('不同卡片的写入串行执行', async (t) => {
  const { feedback } = fixture(t), pending = deferred(), writes = [];
  const a = card(feedback, { write: async () => { writes.push('a'); await pending.promise; } });
  const b = card(feedback, { write: async () => { writes.push('b'); } });
  a.input('a'); b.input('b'); const first = a.editor.flush(), second = b.editor.flush(); await tick();
  assert.deepEqual(writes, ['a']); pending.resolve(); await Promise.all([first, second]); assert.deepEqual(writes, ['a', 'b']);
});

test('失败保留脏内容、按钮恢复且可重试', async (t) => {
  const { feedback } = fixture(t); let failed = true;
  const c = card(feedback, { write: async () => { if (failed) throw new Error('模拟离线'); } });
  c.input('draft'); assert.equal(await c.editor.flush(), false);
  assert.equal(c.editor.dirty(), true); assert.equal(c.data.text, 'draft'); assert.equal(c.button.disabled, false);
  assert.equal(c.status.dataset.status, 'failed'); assert.match(c.status.textContent, /模拟离线/);
  failed = false; assert.equal(await c.editor.flush(), true); assert.equal(c.status.dataset.status, 'saved');
});

test('自动保存失败会阻止刷新准备，不放弃输入', async (t) => {
  const { feedback } = fixture(t);
  const c = card(feedback, { auto: true, write: async () => { throw new Error('failed'); } });
  c.input('draft'); assert.equal(await feedback.prepare('cards', '刷新'), false); assert.equal(c.editor.dirty(), true);
});

test('手动表单取消放弃操作时草稿保留，保存途中禁止切换', async (t) => {
  let confirmations = 0;
  const { feedback } = fixture(t, { confirmAction: () => { confirmations++; return false; } });
  const pending = deferred(), c = card(feedback, { group: 'style', write: () => pending.promise });
  c.input('draft'); assert.equal(await feedback.prepare('style', '切换'), false); assert.equal(confirmations, 1);
  const saving = c.editor.flush(); await tick(); assert.equal(await feedback.prepare('style', '切换'), false);
  assert.equal(confirmations, 1); pending.resolve(); await saving; assert.equal(await feedback.prepare('style', '切换'), true);
});

test('连续输入合并为一次自动保存，移除后不会再写入', async (t) => {
  const { feedback } = fixture(t), writes = [];
  const c = card(feedback, { auto: true, write: async (body) => writes.push(body.text) });
  c.input('a'); c.input('b'); c.input('c');
  await new Promise((resolve) => setTimeout(resolve, 750)); assert.deepEqual(writes, ['c']);
  c.input('disposed'); feedback.clear('cards'); await new Promise((resolve) => setTimeout(resolve, 750));
  assert.deepEqual(writes, ['c']);
});

test('浏览器离开保护脏内容与尚未完成的保存', async (t) => {
  const { feedback } = fixture(t), pending = deferred();
  const c = card(feedback, { write: () => pending.promise });
  let warned = 0;
  const unload = () => listeners.get('beforeunload')({ preventDefault: () => warned++ });
  unload(); assert.equal(warned, 0); c.input('draft'); unload(); assert.equal(warned, 1);
  const saving = c.editor.flush(); await tick(); unload(); assert.equal(warned, 2);
  pending.resolve(); await saving; unload(); assert.equal(warned, 2);
});

test('窗口的其他异步操作也阻止切换和浏览器离开', async (t) => {
  const { feedback } = fixture(t); let busy = true, warned = false;
  feedback.track({ element: new Element(), group: 'style', label: '窗口', read: () => ({}), write: async () => {}, busyCheck: () => busy });
  assert.equal(feedback.unsettled('style'), true); assert.equal(await feedback.prepare('style', '切换'), false);
  listeners.get('beforeunload')({ preventDefault: () => { warned = true; } }); assert.equal(warned, true);
  busy = false; assert.equal(await feedback.prepare('style', '切换'), true);
});

test('清除表单调用清理一次并移除离开保护', async (t) => {
  const { feedback } = fixture(t); let value = 'original', cleaned = 0, warned = false;
  const element = new Element();
  const editor = feedback.track({ element, group: 'cards', label: '窗口', read: () => value, write: async () => {}, onDispose: () => { cleaned++; } });
  value = 'draft'; element.dispatchEvent(new Event('input')); assert.equal(editor.dirty(), true);
  feedback.clear('cards'); editor.dispose(); assert.equal(cleaned, 1);
  listeners.get('beforeunload')({ preventDefault: () => { warned = true; } }); assert.equal(warned, false);
});

test('明确保存指令可提交未改动的工作流，重复点击仍共享请求', async (t) => {
  const { feedback } = fixture(t), pending = deferred(); let writes = 0;
  const c = card(feedback, { write: async () => { writes++; await pending.promise; } });
  const saving = c.editor.flush(true); assert.equal(c.editor.flush(true), saving); await tick();
  assert.equal(writes, 1); pending.resolve(); assert.equal(await saving, true); assert.equal(c.editor.dirty(), false);
});

test('上传预览使用未保存基线，即使尚未编辑也需要保存', async (t) => {
  const { feedback } = fixture(t); let writes = 0;
  const editor = feedback.track({ element: new Element(), group: 'cards', label: '工作流', savedValue: null,
    read: () => [], write: async () => { writes++; } });
  assert.equal(editor.dirty(), true); assert.equal(await editor.flush(), true);
  assert.equal(writes, 1); assert.equal(editor.dirty(), false);
});

test('试跑输入等未持久化字段不会清掉工作流保存失败提示', async (t) => {
  const { feedback } = fixture(t), element = new Element(), status = new Element(); let value = 'original';
  element.matches = () => true;
  const editor = feedback.track({ element, group: 'cards', label: '工作流', watchSelector: '.persisted', status,
    read: () => value, write: async () => { throw new Error('failed'); } });
  value = 'dirty'; element.dispatchEvent(new Event('input')); assert.equal(await editor.flush(), false);
  element.matches = () => false; element.dispatchEvent(new Event('input')); assert.equal(status.dataset.status, 'failed');
});
