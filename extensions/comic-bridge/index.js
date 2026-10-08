/**
 * comic-bridge —— 让外部自研后端驱动酒馆生成故事正文。
 *
 * 为什么是前端扩展：已核实 SillyTavern 1.13.3 的 server plugin 只拿到一个 Express router，
 * 接触不到生成大脑——角色卡格式化、世界书激活与预算、Prompt Manager 组装全在浏览器端。
 * 所以必须把扩展跑在酒馆页面里，通过 SillyTavern.getContext() 调原生生成。
 *
 * 数据流：
 *   后端入队 → 本扩展轮询 /api/bridge/tasks/claim 领取 → 酒馆原生生成（完整管线） →
 *   监听 GENERATION_ENDED 抓新段落 → POST /api/bridge/result 回传 → 后端置「待审」。
 *
 * 免构建：直接用 ES module，import 酒馆自己的模块。
 */

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../script.js';

const DEFAULT_BACKEND = 'http://127.0.0.1:8770';
const POLL_INTERVAL_MS = 3000;

let polling = false;
let currentTask = null;
let backendUrl = DEFAULT_BACKEND;
// 记录本次任务开始前的聊天长度，用于识别“新生成的那条”
let chatLenBefore = 0;

function getSettings() {
  const ctx = getContext();
  ctx.extensionSettings.comicBridge ??= { enabled: false, backend: DEFAULT_BACKEND };
  return ctx.extensionSettings.comicBridge;
}

function saveSettings() {
  getContext().saveSettingsDebounced();
}

async function api(path, opts = {}) {
  const res = await fetch(backendUrl + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/** 领取一个待办任务；没有返回 null。 */
async function claimTask() {
  const data = await api('/api/bridge/tasks/claim');
  return data.task || null;
}

/**
 * 执行一个任务：把引导词注入当前角色对话并触发生成。
 * 走完整管线：角色卡 + 世界书 + 预设 + Prompt Manager。
 */
async function runTask(task) {
  const ctx = getContext();
  currentTask = task;
  chatLenBefore = ctx.chat.length;

  const instruction = task.instruction || '请以小说形式扩写这一场，注重画面感，只输出正文。';

  // 用 /send 把引导词作为用户消息加入，再 /trigger 触发生成（结果落在聊天里，可见流式输出）
  const quoted = instruction.replace(/"/g, '\\"');
  await ctx.executeSlashCommandsWithOptions(`/send ${quoted}`);

  // 触发一次正常生成；await=true 等它结束
  await ctx.executeSlashCommandsWithOptions('/trigger await=true');

  // 正常情况下 GENERATION_ENDED 监听器会把结果回传；这里兜底：
  if (currentTask === task) {
    await reportResult(task, extractNewText());
  }
}

/** 取本次任务新生成的助手消息文本。 */
function extractNewText() {
  const ctx = getContext();
  const added = ctx.chat.slice(chatLenBefore);
  const assistant = added.filter((m) => m.is_user === false);
  return assistant.map((m) => m.mes || '').join('\n\n').trim();
}

async function reportResult(task, text) {
  if (currentTask !== task) return;
  currentTask = null;
  try {
    await api('/api/bridge/result', {
      method: 'POST',
      body: JSON.stringify({ job_id: task.job_id, scene_id: task.scene_id, text }),
    });
    toastr?.success?.('漫画桥：正文已回传后端');
  } catch (e) {
    console.error('[comic-bridge] 回传失败', e);
    toastr?.error?.(`漫画桥：回传失败 ${e.message}`);
  }
}

async function tick() {
  if (!polling) return;
  const s = getSettings();
  if (!s.enabled || currentTask) {
    setTimeout(tick, POLL_INTERVAL_MS);
    return;
  }
  try {
    const task = await claimTask();
    if (task) {
      toastr?.info?.(`漫画桥：领取任务 #${task.job_id}`);
      await runTask(task);
    }
  } catch (e) {
    // 后端没开时静默重试
    console.debug('[comic-bridge]', e.message);
  }
  setTimeout(tick, POLL_INTERVAL_MS);
}

function startPolling() {
  if (polling) return;
  polling = true;
  tick();
}

function stopPolling() {
  polling = false;
}

// 生成结束时抓文本回传
eventSource.on(event_types.GENERATION_ENDED, async () => {
  if (!currentTask) return;
  const task = currentTask;
  // 稍等一拍，等消息写入 chat
  setTimeout(() => reportResult(task, extractNewText()), 300);
});

// ---------- UI ----------
jQuery(async () => {
  const s = getSettings();
  backendUrl = s.backend || DEFAULT_BACKEND;

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
          <span>启用轮询（领取并生成正文任务）</span>
        </label>
        <div class="cb-hint">启用后需保持本标签页打开；生成会走完整角色卡/世界书/预设管线。</div>
      </div>
    </div>
  </div>`;

  jQuery('#extensions_settings2').append(html);

  jQuery('#cb-backend').on('input', function () {
    backendUrl = String(this.value || DEFAULT_BACKEND).trim();
    getSettings().backend = backendUrl;
    saveSettings();
  });
  jQuery('#cb-enabled').on('change', function () {
    getSettings().enabled = this.checked;
    saveSettings();
    this.checked ? startPolling() : stopPolling();
  });

  if (s.enabled) startPolling();
  console.log('[comic-bridge] 已加载，后端 =', backendUrl);
});
