# comic-bridge：SillyTavern 前端扩展（M1 交付）

**为什么用前端扩展而不是服务器插件**：已核实 SillyTavern 1.13.3 的 server plugin 只拿到一个
Express router，接触不到生成大脑——角色卡格式化、世界书关键词激活与预算、Prompt Manager 组装
全在浏览器前端。用服务器插件就得在 Node 侧重写整套逻辑，故不采用。

**放置位置**：`<SillyTavern>/data/default-user/extensions/comic-bridge/`（免构建 `index.js` + `manifest.json`，ES module）。

**流程**：后端把引导词入队 → 扩展轮询 `GET /api/bridge/tasks/claim` 领取 →
`/inject` + `/trigger await=true`（或 `generateQuietPrompt`）→ 酒馆跑完整管线，正文流式打进聊天 →
扩展监听 `GENERATION_ENDED` / `MESSAGE_RECEIVED` 抓新段落 → `POST /api/bridge/result` 回传 → 置「待审」。

**前提**：S2 生成期间酒馆标签页保持打开；后端已放行酒馆 origin（`http://localhost:8000`）的 CORS。

## 会话列表同步与更新

扩展周期性读取酒馆 Recent Chats 并推送给漫画后端，正文页的「刷新列表」读取最近推送的快照。应用后端在线不等于酒馆页面或常驻桥在线，正文页会独立显示最近同步状态。

列表读取失败时发送 `chats_error` 并省略 `chats`，后端保留上次成功列表；成功读到空列表才发送 `chats: []`。重新拉取成功会清除错误，生成中的 `live` 状态继续保留。

更新本仓库后，需将本目录文件重新同步至 `<SillyTavern>/data/default-user/extensions/comic-bridge/`，重载酒馆标签页；使用常驻桥时重开该桥，使页面载入新版扩展。此次改动不会自动修改外部酒馆安装目录。
