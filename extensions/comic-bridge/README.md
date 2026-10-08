# comic-bridge：SillyTavern 前端扩展（M1 交付）

**为什么用前端扩展而不是服务器插件**：已核实 SillyTavern 1.13.3 的 server plugin 只拿到一个
Express router，接触不到生成大脑——角色卡格式化、世界书关键词激活与预算、Prompt Manager 组装
全在浏览器前端。用服务器插件就得在 Node 侧重写整套逻辑，故不采用。

**放置位置**：`<SillyTavern>/data/default-user/extensions/comic-bridge/`（免构建 `index.js` + `manifest.json`，ES module）。

**流程**：后端把引导词入队 → 扩展轮询 `GET /api/bridge/tasks/claim` 领取 →
`/inject` + `/trigger await=true`（或 `generateQuietPrompt`）→ 酒馆跑完整管线，正文流式打进聊天 →
扩展监听 `GENERATION_ENDED` / `MESSAGE_RECEIVED` 抓新段落 → `POST /api/bridge/result` 回传 → 置「待审」。

**前提**：S2 生成期间酒馆标签页保持打开；后端已放行酒馆 origin（`http://localhost:8000`）的 CORS。
