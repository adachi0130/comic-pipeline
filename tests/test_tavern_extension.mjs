import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../extensions/comic-bridge/index.js', import.meta.url), 'utf8');
const fetchSource = source.slice(source.indexOf('async function fetchChatList()'), source.indexOf('\nasync function pushMirror()'));
function load(fetch) {
  return runInNewContext(fetchSource + '\nfetchChatList', {
    fetch, getContext: () => ({ getRequestHeaders: () => ({}), characters: [{ avatar: 'hero.png', name: '主角' }], groups: [] })
  });
}
test('HTTP/network/schema failures report errors without publishing an empty list', async () => {
  for (const fetch of [async () => ({ ok: false, status: 503 }), async () => { throw new Error('离线'); }, async () => ({ ok: true, json: async () => ({}) })]) {
    const result = await load(fetch)();
    assert.equal(Object.hasOwn(result, 'chats'), false); assert.ok(result.chats_error);
  }
});
test('successful empty and nonempty responses are distinguished', async () => {
  const empty = await load(async () => ({ ok: true, json: async () => [] }))();
  assert.equal(empty.chats.length, 0); assert.equal(empty.chats_error, undefined);
  const populated = await load(async () => ({ ok: true, json: async () => [{ file_name: 'chapter.jsonl', avatar: 'hero.png', chat_items: 0 }] }))();
  assert.equal(populated.chats[0].char_name, '主角'); assert.equal(populated.chats[0].chat_items, 0);
});
