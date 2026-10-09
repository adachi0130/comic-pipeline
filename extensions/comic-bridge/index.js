/**
 * comic-bridge —— 让自研后端驱动酒馆写作，并把「酒馆对话」镜像回后端。
 *
 * 为什么是前端扩展：已核实 SillyTavern 1.13.3 的 server plugin 只拿到一个 Express router，
 * 接触不到生成大脑——角色卡格式化、世界书激活、Prompt Manager 组装全在浏览器端。
 *
 * 功能：
 * 1) 轮询后端任务，领取后调用酒馆原生管线生成（完整角色卡 + 世界书 + 预设）；
 * 2) 生成时收集「生成依据」（角色卡名/世界书名/激活条目标题/预设名/模型），随正文回传；
 * 3) 定期把当前对话镜像（消息列表 + 当前角色）推给后端，前端可直接看酒馆对话、直接发消息。
 *
 * 免构建：ES module。第三方扩展在 /scripts/extensions/third-party/<name>/，故相对路径多退一级。
 */

import { getContext } from '../../../../scripts/extensions.js';
import { eventSource, event_types, sendMessageAsUser, openCharacterChat } from '../../../../script.js';

const DEFAULT_BACKEND = 'http://127.0.0.1:8770';
const POLL_INTERVAL_MS = 3000;
const MIRROR_INTERVAL_MS = 2500;
const MIRROR_MAX_MESSAGES = 200;

let polling = false;
let currentTask = null;
let backendUrl = DEFAULT_BACKEND;
let chatLenBefore = 0;
// 本次生成的依据（由事件填充）
let currentReceipt = {};

function getSettings() {
  const ctx = getContext();
  ctx.extensionSettings.comicBridge ??= { enabled: false, backend: DEFAULT_BACKEND };
  return ctx.extensionSettings.comicBridge;
}
function saveSettings() { getContext().saveSettingsDebounced(); }

async function api(path, opts = {}) {
  const res = await fetch(backendUrl + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// ---------------- 生成依据收集 ----------------
/**
 * 读取“名字级”生成依据。刻意只取稳定字段，保证直观可靠：
 * - 角色卡名：优先 name2（酒馆当前角色名），回退 characters[characterId].name
 * - 世界书名：角色卡绑定的世界书（data.extensions.world / character_book.name）
 * - 预设名：getPresetManager().getSelectedPresetName()
 * - 模型 / 供应商：chatCompletionSettings
 * 世界书“激活了几条”由 WORLD_INFO_ACTIVATED 事件补充（可能为 0，属正常）。
 */
function collectStaticReceipt() {
  const ctx = getContext();
  const receipt = { at: new Date().toISOString() };
  try {
    let ch = null;
    if (ctx.characterId !== null && ctx.characterId !== undefined) {
      ch = (ctx.characters || [])[ctx.characterId] || null;
    }
    receipt.character_name = (ch && ch.name) || ctx.name2 || '';
    receipt.character_avatar = ch?.avatar || '';
    // 角色卡绑定的世界书
    const world = ch?.data?.extensions?.world || ch?.data?.character_book?.name || '';
    receipt.world_books = world ? [world] : [];
  } catch (e) { /* 忽略 */ }
  try {
    const pm = ctx.getPresetManager?.();
    if (pm?.getSelectedPresetName) receipt.preset_name = pm.getSelectedPresetName() || '';
  } catch (e) { /* 忽略 */ }
  try {
    const s = ctx.chatCompletionSettings;
    if (s?.chat_completion_source) receipt.api = s.chat_completion_source;
    receipt.model = s?.custom_model || s?.openai_model || '';
  } catch (e) { /* 忽略 */ }
  return receipt;
}

/** 世界书激活事件：补充“激活了几条 / 哪些条目”。 */
function attachReceiptListeners() {
  eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
    if (!currentTask || !Array.isArray(entries)) return;
    const books = new Set(currentReceipt.world_books || []);
    const titles = [];
    for (const e of entries) {
      if (e?.world) books.add(e.world);
      const t = e?.comment || (Array.isArray(e?.key) ? e.key[0] : '') || '';
      const s = String(t).trim();
      if (s && !/^\d+$/.test(s)) titles.push(s);
    }
    currentReceipt.world_books = [...books];
    currentReceipt.world_entries = titles.slice(0, 30);
    currentReceipt.world_count = entries.length;
  });

  // 组合后的最终 prompt：只记字数与指纹，避免把大段隐私文本传出去
  const onCombined = (data) => {
    if (!currentTask) return;
    try {
      const msgs = data?.chat ?? data?.prompt ?? [];
      const text = Array.isArray(msgs)
        ? msgs.map((m) => (typeof m === 'string' ? m : m?.content || '')).join('\n')
        : String(msgs || '');
      currentReceipt.prompt_chars = text.length;
      currentReceipt.prompt_hash = simpleHash(text);
    } catch (e) { /* 忽略 */ }
  };
  eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onCombined);
  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onCombined);
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ---------------- 对话镜像 ----------------
function snapshotMessages() {
  const ctx = getContext();
  const chat = ctx.chat || [];
  // 过滤系统消息 / 欢迎面板等噪声：镜像只保留真正的对话内容
  return chat
    .filter((m) => {
      if (!m) return false;
      if (m.is_system) return false;
      const name = (m.name || '').trim();
      if (name === 'SillyTavern System' || name === 'System') return false;
      const mes = m.mes || '';
      if (/^\s*<div\b/i.test(mes)) return false;
      if (/already configured the API|尝试发送些什么|Hint:/i.test(mes)) return false;
      return true;
    })
    .slice(-MIRROR_MAX_MESSAGES)
    .map((m) => ({
      name: m.name || '',
      is_user: !!m.is_user,
      is_system: !!m.is_system,
      mes: m.mes || '',
      send_date: m.send_date || '',
    }));
}

function snapshotContext() {
  const ctx = getContext();
  const ch = ctx.characters?.[ctx.characterId];
  return {
    character_name: ch?.name || '',
    character_avatar: ch?.avatar || '',
    chat_id: ctx.chatId || '',
    message_count: (ctx.chat || []).length,
    characters: (ctx.characters || []).map((c) => c.name).filter(Boolean),
  };
}

/** 拉取酒馆的对话列表（Recent Chats，跨角色），用于前端展示与切换。 */
async function fetchChatList() {
  const ctx = getContext();
  try {
    const res = await fetch('/api/chats/recent', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({ max: 50 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const chars = ctx.characters || [];
    const groups = ctx.groups || [];
    // 接口只给 avatar 文件名，角色名要在这一侧映射（与酒馆前端一致）
    const norm = (s) => String(s || '').trim();
    return (data || []).map((c) => {
      const avatar = c.avatar || '';
      const groupId = c.group || '';
      // 角色名：优先按 avatar 精确匹配；匹配不上则退回角色索引 / avatar 文件名
      // （酒馆的对话目录名就是 avatar 去掉 .png，故这个兜底是可靠的）
      const ch = chars.find((x) => norm(x.avatar) === norm(avatar));
      const byIndex = (function () {
        const id = ctx.characterId;
        const cur = id !== null && id !== undefined ? chars[id] : null;
        return cur && norm(cur.avatar) === norm(avatar) ? cur : null;
      })();
      const grp = groups.find((x) => String(x.id) === String(groupId));
      const fileFallback = avatar ? avatar.replace(/\.png$/i, '') : '';
      return {
        file_name: c.file_name,
        avatar,
        group: groupId,
        char_name: ch?.name || byIndex?.name || grp?.name || c.char_name || fileFallback || '',
        last_mes: c.last_mes || '',
        chat_items: c.chat_items ?? null,
        is_group: !!c.is_group,
      };
    }).filter((c) => c.file_name);
  } catch (e) {
    return [];
  }
}

async function pushMirror() {
  if (!getSettings().enabled) return;
  try {
    await api('/api/bridge/mirror', {
      method: 'POST',
      body: JSON.stringify({ context: snapshotContext(), messages: snapshotMessages(), receipt: currentReceipt, chats: await fetchChatList() }),
    });
  } catch (e) { /* 后端没开时静默 */ }
}

// ---------------- 任务执行 ----------------
async function claimTask() {
  const data = await api('/api/bridge/tasks/claim');
  return data.task || null;
}

/**
 * 执行酒馆操作任务（如切换对话）。
 * 跨角色切换需要先选中该角色，再 openCharacterChat(file_name)。
 */
async function runTavernOp(task, ctx) {
  try {
    if (task.action === 'switch') {
      if (task.avatar) {
        const idx = (ctx.characters || []).findIndex((c) => c.avatar === task.avatar);
        if (idx >= 0 && String(idx) !== String(ctx.characterId)) {
          await ctx.selectCharacterById(idx);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      // 注意：酒馆内部 chat id 不含 .jsonl（/api/chats/get 会自己补），必须去掉后缀
      const chatId = String(task.file_name || '').replace(/\.jsonl$/, '');
      await openCharacterChat(chatId);
      toastr?.success?.(`漫画桥：已切换到「${task.chat_name || task.file_name}」`);
    }
  } catch (e) {
    console.error('[comic-bridge] 酒馆操作失败', e);
    toastr?.error?.(`漫画桥：切换失败 ${e.message}`);
  }
  // 回传结果（记为 done），并立刻刷新镜像与列表
  try {
    await api('/api/bridge/result', {
      method: 'POST',
      body: JSON.stringify({ job_id: task.job_id, text: '', receipt: {}, op: task.action || '' }),
    });
  } catch (e) { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 600));
  await pushMirror();
}

async function runTask(task) {
  const ctx = getContext();
  // 酒馆操作任务（切换对话等）：不生成正文
  if (task.kind === 'tavern') {
    await runTavernOp(task, ctx);
    return;
  }
  currentTask = task;
  currentReceipt = collectStaticReceipt();
  chatLenBefore = ctx.chat.length;

  const mode = task.mode || 'start';
  let message;
  if (mode === 'raw') {
    // 前端直接发来的原话，照原样发给酒馆
    message = task.instruction || '';
  } else if (mode === 'continue') {
    const hint = task.instruction || '请自然地接着往下写，保持文风与人称一致。';
    const tail = task.context_tail || '';
    message = tail
      ? `【续写】以下是已写好的前文结尾（仅供衔接，不要重复）：\n……${tail}\n\n续写要求：${hint}`
      : `【续写】${hint}`;
  } else {
    const base = task.instruction ? `写作要求：${task.instruction}` : '请根据设定开始写作。';
    message = task.outline ? `故事大纲：${task.outline}\n\n${base}` : base;
  }

  // 程序化发送（不用斜杠命令，避免转义问题），然后触发生成
  try {
    await sendMessageAsUser(message);
  } catch (e) {
    // 兜底：退回斜杠命令
    const quoted = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    await ctx.executeSlashCommandsWithOptions(`/send ${quoted}`);
  }
  pushMirror(); // 让前端尽快看到“我们发出去的那条”
  await ctx.executeSlashCommandsWithOptions('/trigger await=true');

  if (currentTask === task) {
    await reportResult(task, extractNewText());
  }
}

/**
 * 只取“本次请求之后新产生的角色回复”，**绝不包含历史对话**。
 *
 * 从最后一条用户消息之后开始取（即使 chatLenBefore 因故不准，也不会把历史当产物）；
 * 只有你新发的那条用户消息之后的内容，才是本次要保存的产物。
 */
function extractNewText() {
  const ctx = getContext();
  const chat = ctx.chat || [];
  let start = chatLenBefore;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && chat[i].is_user) { start = i + 1; break; }
  }
  const from = Math.max(0, Math.min(start, chat.length));
  return chat
    .slice(from)
    .filter((m) => m && m.is_user === false && !m.is_system)
    .map((m) => m.mes || '')
    .join('\n\n')
    .trim();
}

async function reportResult(task, text) {
  if (currentTask !== task) return;
  currentTask = null;
  try {
    await api('/api/bridge/result', {
      method: 'POST',
      body: JSON.stringify({ job_id: task.job_id, text, receipt: currentReceipt }),
    });
    toastr?.success?.('漫画桥：正文已回传后端');
  } catch (e) {
    console.error('[comic-bridge] 回传失败', e);
    toastr?.error?.(`漫画桥：回传失败 ${e.message}`);
  }
  pushMirror();
}

// ---------------- 循环 ----------------
async function tick() {
  if (!polling) return;
  const s = getSettings();
  if (!s.enabled || currentTask) { setTimeout(tick, POLL_INTERVAL_MS); return; }
  try {
    const task = await claimTask();
    if (task) {
      toastr?.info?.(`漫画桥：领取任务 #${task.job_id}`);
      await runTask(task);
    }
  } catch (e) {
    console.debug('[comic-bridge]', e.message);
  }
  setTimeout(tick, POLL_INTERVAL_MS);
}

async function mirrorTick() {
  if (polling) { await pushMirror(); }
  setTimeout(mirrorTick, MIRROR_INTERVAL_MS);
}

function start() { if (!polling) { polling = true; tick(); mirrorTick(); } }
function stop() { polling = false; }

// 生成结束时兜底回传
eventSource.on(event_types.GENERATION_ENDED, () => {
  if (!currentTask) return;
  const task = currentTask;
  setTimeout(() => reportResult(task, extractNewText()), 300);
});

// ---------------- UI ----------------
jQuery(async () => {
  const s = getSettings();
  backendUrl = s.backend || DEFAULT_BACKEND;
  attachReceiptListeners();

  const html = `
  <div class="comic-bridge-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Comic Bridge（漫画生产桥）</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label>后端地址
          <input id="cb-backend" class="text_pole" type="text" value="${backendUrl}">
        </label>
        <label class="checkbox_label">
          <input id="cb-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>
          <span>启用（领取写作任务 + 推送对话镜像）</span>
        </label>
        <div class="cb-hint">启用后保持本标签页打开；生成走完整角色卡/世界书/预设管线。</div>
      </div>
    </div>
  </div>`;

  jQuery('#extensions_settings2').append(html);
  jQuery('#cb-backend').on('input', function () {
    backendUrl = String(this.value || DEFAULT_BACKEND).trim();
    getSettings().backend = backendUrl; saveSettings();
  });
  jQuery('#cb-enabled').on('change', function () {
    getSettings().enabled = this.checked; saveSettings();
    if (this.checked) { start(); pushMirror(); } else { stop(); }
  });

  if (s.enabled) start();
  console.log('[comic-bridge] 已加载，后端 =', backendUrl);
});
