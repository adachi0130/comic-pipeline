# AI 漫画自动化生产线（MVP）

只写故事大纲，逐阶段产出漫画：**正文 → 分页分格 → 分镜提示词 → 逐格出图 → 分页合成 → 导出 PDF/CBZ**，
每个阶段后面设一道人工审查门（也可切「全自动」一键跑完）。

- **大脑**：本项目自研后端（FastAPI + SQLite + 作业队列 + 版本化/血缘）。
- **笔杆（S2 正文）**：SillyTavern 扩展桥，正文跑酒馆完整管线（角色卡 + 世界书 + 预设 + Prompt Manager）。
- **画笔（S6 拼页）**：Manga Editor Desu（69 版式模板 + 气泡 + 网点/集中线/运动线），经同源 iframe + 注入桥驱动。
- **出图（S5）**：后端直接调 ComfyUI（本机或云端，云端可经 SSH 隧道），只操作你现有文生图工作流的参数。

工作台新增「漫画编辑器」和「整册导出」：精修页可在当前页面保存、返回预览、审核后直接导出 PDF/CBZ；导出中心展示实际纳入的页与历史版本下载。后续分批改进见 [易用性改进清单](docs/易用性改进清单.md)。

「配置与资产」提供供应商、连接与工作流、阶段模型、系统提示词及角色/预设/画风分类入口。项目和主要编辑窗口保留草稿并显示保存状态；出图连接可独立保存，工作流修改在关闭或切换前提醒，保存失败可保留输入重试。

「出图」现为逐格工作台：按页、进度、关键词定位，集中编辑本格正负面、尺寸和 LoRA，放大或比较两张候选图后采用；选图写新版本，保留旧选择与文件。提交生成固定提示词版本，切格后任务仍归原格，页与格的位置可恢复。

---

## 目录

- [前置要求](#前置要求)
- [5 步跑起来（克隆 → 打开前端）](#5-步跑起来克隆--打开前端)
- [配置出图与 LLM](#配置出图与-llm)
- [接入 SillyTavern（正文）](#接入-sillytavern正文)
- [无头自动驾驶](#无头自动驾驶)
- [自测](#自测)
- [目录结构](#目录结构)
- [排错](#排错)
- [许可证与第三方](#许可证与第三方)

> 📖 **想知道这个项目有什么功能、漫画是怎么从大纲做成成书的、每个界面怎么操作？**
> 看 **[docs/使用手册.md](docs/使用手册.md)**。

---

## 前置要求

| 依赖 | 建议版本 | 用来做什么 | 必需 |
|---|---|---|---|
| **Python** | 3.11 – 3.13（实测 3.13.9） | 后端与脚本 | ✅ 必需 |
| **Git** | 任意较新版本 | 克隆仓库 | ✅ 必需 |
| **Node.js** | 18+（实测 22） | 只在**生成版式模板菜单**时用一次（脚本内部调用 `node`） | ⚠️ 跑模板脚本时必需 |
| **ComfyUI** | 任意可访问的实例 | 逐格出图（S5） | ⭕ 想真出图才需要 |
| **SillyTavern** | 1.13.x（实测 1.13.3） | 正文生成（S2） | ⭕ 想跑正文才需要 |
| **LLM API Key** | 任意 OpenAI 兼容端点 | 分页分格(S2)/分镜提示词(S3) | ⭕ 想跑 AI 阶段才需要 |

> 说明：**没有 MED、没有 ComfyUI、没有酒馆，后端也能正常启动**（只是对应功能用不了）。
> 下面第 1–3 步做完就能打开前端界面；第 4 步是把它真正跑通。

---

## 5 步跑起来（克隆 → 打开前端）

### 第 0 步：克隆

```bash
git clone <你的仓库地址> comic-pipeline
cd comic-pipeline
```

### 第 1 步：建虚拟环境 + 装依赖

**Windows：**

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m playwright install chromium
```

**macOS / Linux：**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
```

> `playwright install chromium` 会下载一个无头浏览器，供 **MED 合成桥**和**酒馆常驻桥**使用；
> 首次约 100–150 MB，耐心等一会儿。

### 第 2 步：拉取 Manga Editor Desu（约 99 MB，不入 git）

MED 体积大且是第三方 GPL 代码，**不随仓库分发**，用脚本按锁定的 commit 拉取：

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File backend/scripts/fetch_editor.ps1

# macOS / Linux
bash backend/scripts/fetch_editor.sh
```

拉取后落在 `backend/static/editor/`。锁定的版本见 `backend/static/EDITOR_VERSION.md`。

### 第 3 步：生成版式模板菜单 + 灌入技法库

```bash
# 3.1 解析 MED 的 69 个版式模板 → 写入数据库 + data/template_menu.json（需要 node）
.venv/Scripts/python.exe backend/scripts/build_template_menu.py \
    --vertical  backend/static/editor/js/svg/manga-panels-image-vertical.js \
    --landscape backend/static/editor/js/svg/manga-panels-image-landscape.js

# 3.2 灌入技法库（集中线/运动线/网点/拟声词…），S3 提示词会用到
.venv/Scripts/python.exe backend/scripts/seed_techniques.py
```

> 脚本会自动执行建表（`init_db`），不需要手动建库。
> **Windows 用户**把上面的 `.venv/Scripts/python.exe` 换成对应的 Linux 路径即可。

### 第 4 步：配置（出图 / LLM，可选但推荐）

```bash
# 出图配置模板 → 实际配置（comfy.yaml 已 .gitignore，可安全填 API Key）
cp config/comfy.example.yaml config/comfy.yaml     # Windows: copy config\comfy.example.yaml config\comfy.yaml
```

- **LLM 供应商**：启动后在前端「设置 / 供应商」里填 `base_url` + `api_key` + `model`，
  或点「从酒馆导入」复用酒馆正在用的模型（需先跑起酒馆）。
- 详见 [配置出图与 LLM](#配置出图与-llm)。

### 第 5 步：启动后端

```bash
# Windows
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8770

# macOS / Linux
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8770
```

> 必须在 **`backend/` 目录**下运行（让 `app.main:app` 能被找到）：
> ```bash
> cd backend
> ../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8770
> ```
> 或者用一键脚本（会连常驻酒馆桥一起起）：`.venv/Scripts/python.exe tools/start_all.py`

打开：

| 入口 | 地址 |
|---|---|
| 前端工作台 | http://127.0.0.1:8770/ui/ |
| MED 编辑工作台 | http://127.0.0.1:8770/editor/ |
| 健康检查 | http://127.0.0.1:8770/api/health （应返回 `{"ok": true, ...}`） |

**到这一步，前端界面就能打开了。** 剩下的是把外部服务接上。

---

## 配置出图与 LLM

### 出图后端（ComfyUI）

两种连法，都在前端「**出图 → 出图设置**」里做：

1. **连本机 ComfyUI**：填 `http://127.0.0.1:8188`，点「连接」——会拉回**已有的工作流列表 + LoRA/checkpoint/VAE 列表**。
2. **连云端 ComfyUI**（如仙宫云）：填云端给的访问地址；若需要鉴权会以 `Authorization: Bearer <key>` 发送。
   云端若只能 SSH 访问，可在 `config/comfy.yaml` 或环境变量里开 SSH 隧道（见 `app/config.py` 的 `TunnelSettings`）。

工作流可以从后端拉取，也可以点「**上传 JSON 工作流**」选择本地文件：

- **API 格式**可以离线解析；普通 **UI 格式**需要连接 ComfyUI 读取节点定义，支持先展开子图再转换。
- 上传后先预览，确认后点「**保存并用它出图**」。工作流保存在本项目，可从「已保存的工作流」再次打开；上传同名文件会建议新名称。
- 工作流正向文本使用 `%prompt%`，负向使用 `%negative%`，也可在解析后的文本框中点「插入」添加。出图时替换占位符，保留前后的固定词，例如 `masterpiece, %prompt%`。
- 串联和堆加载 LoRA 都集中展示为列表，可调整启用、文件名、模型权重及节点支持的 CLIP 权重。

从后端选择工作流时：

- **点一个工作流 → 看参数**：读该工作流原始文件，UI 格式自动转 API 格式（靠 `/object_info` 把控件位置对应到输入名），
  并体检出提示词参数、采样参数、LoRA 槽、缺失节点。
- **选定即用** → 存进登记表、设为当前、自动映射参数。
- **试跑一张** → 验证「连接 + 工作流 + 参数 + LoRA」整条链路。

**出图参数从哪来**：S3 逐格提示词产物里的 `prompt_pos/prompt_neg/width/height/loras/params`，
S5 直接套用（宽高按该格画框几何算，长边 1216、64 对齐）。

支持的工作流写法：`%prompt%` / `%negative%` 占位符，或字段映射（`CLIPTextEncode.text` 等）；
LoRA 支持三种节点（多 `LoraLoader` 串联、rgthree `Lora Loader Stack`、rgthree `Power Lora Loader`）。
细节见 [出图工作流支持范围](#出图工作流支持范围)。

### LLM 供应商（分页分格 / 分镜提示词）

任意 **OpenAI 兼容**端点即可（DashScope / DeepSeek / Kimi / 智谱 / OpenRouter / Ollama / vLLM…）。
在配置里填 `base_url` + `api_key` + `model` 即可，代码不绑定任何具体厂商。

---

## 接入 SillyTavern（正文）

1. 把 `extensions/comic-bridge/` 复制到 `<SillyTavern>/data/default-user/extensions/comic-bridge/`；
2. 酒馆重启后，在「扩展」面板里打开开关（或写 `data/default-user/settings.json` 的
   `extension_settings.comicBridge = {"enabled": true, "backend": "http://127.0.0.1:8770"}`）；
3. 后端入队正文请求（`POST /api/projects/{id}/prose/request`）→ 扩展轮询领取 → 酒馆原生生成 →
   正文回传后端置「待审」。

> 生成期间酒馆标签页需保持打开；后端已对 `http://localhost:8000` 放行 CORS。
> **不想开酒馆标签页**？用常驻酒馆桥：`tools/tavern_bridge.py`（用无头浏览器替你常开一个酒馆页），
> `tools/start_all.py` 已经把它一起起了。
> 自测无额度时可用 `tools/mock_llm.py` 起本地 OpenAI 兼容 mock（支持流式），验证整条 S2 链路。

---

## 无头自动驾驶

不经前端、直接串起 S1→S4→(S5)→S6→S7（把项目 `review_mode` 设为 `auto` 即全程无人值守）：

```bash
.venv/Scripts/python.exe backend/scripts/autodrive.py --project 1
```

---

## 自测

```bash
.venv/Scripts/python.exe -X utf8 -B -m unittest discover -s tests -p 'test_*safety.py' -v
.venv/Scripts/python.exe tests/test_workflow_mapping.py   # 工作流参数映射 + LoRA 链/旁路
.venv/Scripts/python.exe tests/test_artifacts.py          # 版本化 + 血缘 + 失效传播
.venv/Scripts/python.exe tests/test_med_bridge.py         # MED 桥端到端（无头，需已拉取 MED）
```

安全回归使用 `tests/` 下独立临时目录及内存 SQLite，进程、网络出图和 MED 均隔离或 mock；
PDF/CBZ 使用临时图片真实导出。它不启动应用 lifespan、不访问实际项目数据库，也不需要下载浏览器。

### 数据安全修复：存储与兼容性

- 启动工具不再扫描或强杀已有 Python / 浏览器进程；已有后端在线时退出。
  在原启动终端按 **Ctrl+C** 停止本次子进程。`start_all.py --stop` 保留参数，
  只显示手动停止指引并返回退出码 2。
- 常驻酒馆桥不扫描、读取或删除会话文件，旧的会话清理函数已禁用。
- 产物文件必须属于 `data/projects/<project_id>/`。绝对路径、相对路径均会检查实际解析结果；
  越界路径、跨项目路径、Windows ADS、外部符号链接/联接均拒绝。
  通用 payload 编辑禁止改写 `candidates/files/path` 文件引用；上传、生成及普通提示词编辑接口保留。
- 新候选图、上传图、整页 PNG、MED 预览及 PDF/CBZ 各次写入使用独立 UUID 子目录，
  文件采用排他创建。API URL 和数据库 `path/payload` 格式保持兼容。
- 删除候选仅从新版本列表移除该项，保留物理文件和旧版本；该操作不会立即释放磁盘空间。
- **没有数据库迁移或旧文件搬移。**已有合法项目文件继续通过原产物 ID 读取，
  新生成结果不再写入旧的固定文件名。历史已被覆盖/删除的内容无法由本次修复恢复。
- 旧记录若指向项目目录外，访问会被拒绝；不会自动复制、改写或修复该记录。
  项目目录及 `projects/` 目录的联接也会被拒绝；数据根目录仍可由 `COMIC_DATA_DIR` 配置。
- **回滚：**停止程序后恢复代码版本即可，数据库结构保持原样，新旧路径均存于既有字段。
  保留所有新增 UUID 目录；回滚后旧代码会重新带来清理和覆盖风险，应先保留完整数据副本。

---

## 目录结构

```
backend/
  app/
    config.py         配置：路径 / ComfyUI / 隧道 / 页面规格 / 工作流参数映射
    models.py         SQLAlchemy 模型（artifacts 版本化、血缘、模板、技法、供应商、作业…）
    artifacts.py      版本化 + 血缘 + 失效传播（“只重跑受影响部分”）
    schemas.py        阶段产物契约（S1/S3/S4 的 pydantic 模型）
    llm/client.py     供应商无关 LLM 客户端（任意 OpenAI 兼容）+ 校验 + 重试 + 留痕
    comfy/            ComfyUI 客户端 / 工作流参数自动映射 / SSH 隧道 / 出图服务
    med/              PageComposer 抽象 + Manga Editor Desu 适配器
    stages/           S1..S7 作业处理器
    api/routes/       REST + SSE
  prompts/            S1/S3/S4 提示词（版本化资产）
  scripts/            build_template_menu.py / seed_techniques.py / parse_med_templates.mjs / fetch_editor.* / autodrive.py
  static/
    editor/           vendor 的 Manga Editor Desu（不入 git，按 EDITOR_VERSION.md 拉取）
    ui/               自研前端 + editor_bridge/（MED 驱动桥 + 人工验证页）
extensions/comic-bridge/   SillyTavern 扩展
config/
  comfy.example.yaml         出图后端配置模板（复制为 comfy.yaml）
  workflows/<name>.json      你的文生图工作流（API 格式，需自备，不入 git）
  workflow_params.yaml       工作流参数映射表（脚本自动初猜后可手改，不入 git）
data/                    数据库与产物（不入 git，首次启动自动创建）
tests/                   离线自测 + MED 桥冒烟测试
tools/                   start_all.py（一键启动）/ tavern_bridge.py（常驻酒馆桥）/ mock_llm.py
```

---

## 排错

| 现象 | 原因 / 解决 |
|---|---|
| `ModuleNotFoundError: app.main` | 必须在 `backend/` 目录下启动 uvicorn |
| 打不开 `/ui/` 或页面 404 | 确认从项目根的 `backend/` 启动、端口 8770 未被占用 |
| `/editor/` 打不开 | 没拉取 MED（第 2 步）。后端不挂载不存在的目录，所以它不会导致启动失败，但 MED 合成用不了 |
| S2 生成时提示"无模板" | 没跑第 3 步 `build_template_menu.py`（需要 node） |
| S3 提示词里没有技法 | 没跑第 3 步 `seed_techniques.py` |
| 出图报"连不上 ComfyUI" | 确认 ComfyUI 已启动、地址/端口填对、云端地址是否需要 key 或隧道 |
| 出图报"缺节点" | 工作流用了你 ComfyUI 没装的 `class_type`；在工作流体检里能看缺哪些 |
| 酒馆正文一直"待生成" | 酒馆标签页没开 / 扩展没启用 / 未跑 `tavern_bridge.py` |
| 前端按钮点了没反应 | 本前端对 `/ui` 加了 no-cache；若仍异常，硬刷新（Ctrl+F5） |
| 换工作流后参数没生效 | 需要重跑一次「自动映射」（参数映射表是每工作流一份） |

---

## 许可证与第三方

- **Manga Editor Desu**（作者 new-sankaku，https://github.com/new-sankaku/manga-editor-desu ）采用
  **GPL-3.0**。本项目**不随仓库分发 MED 本体**，而是用 `fetch_editor.*` 按锁定 commit 拉取，
  以**同源 iframe + 注入桥**调用其内部函数驱动它。
- 详细的第三方组件、版本与本项目与 MED 的边界说明见 **`THIRD_PARTY_NOTICES.md`**。
- 若你二次分发（尤其是**把 MED 一起打包**），须遵守 GPL-3.0 的相应义务。

---

## 关键约束（已核实）

- **MED 无自动化 API**（无 postMessage / URL 参数 / 全局导出对象）。我们用同源 iframe + 注入 `med_bridge.js`（运行在 MED 全局作用域）调用其顶层函数；版本锁定见 `backend/static/EDITOR_VERSION.md`，升级前跑 `tests/test_med_bridge.py`。
- **MED 没有内置简体中文字体**（只有日文 Noto Sans JP）。桥的 `setupCJKFonts()` 用 MED 自带字体管理器以 `local()` 方式注册系统字体，不改 MED 源码。
- **MED 自身不能改 LoRA 权重**、缺 `%prompt%` 时静默失败，故**出图放在后端**，MED 只负责排版/嵌字/技法/导出。

## 出图工作流支持范围

- **两种写法**：`%prompt%` / `%negative%` 占位符（沿用 MED 风格），或字段映射（CLIPTextEncode.text 等）。
- **LoRA 三种节点**：
  - 多 `LoraLoader` 串联；
  - rgthree `Lora Loader Stack`（扁平式：`lora_01` + `strength_01`，空槽填 `None`）；
  - rgthree `Power Lora Loader`（对象式：`lora_1 = {on, lora, strength}`）。
- **前端虚拟节点**：KJNodes `SetNode`/`GetNode`、cg-use-everywhere `Anything Everywhere` 会被解析
  （把源直连到消费者），不进 API。
- **子图（subgraph）**：其定义不写在 UI 文件里，若工作流用了子图，工具会明确提示
  「请在 ComfyUI 里展开子图或改用『保存（API 格式）』导出」。

> 前端入口：**「出图 → 出图设置」**（① 连接 → ② 点工作流看参数 → 选定即用 → 试跑），
> **「提示词」**页是 S3 独立工作台（每页版式缩略图 + 每格提示词，可整册或单页生成、就地改词，
> 角色、预设和画风位于侧栏 **「配置与资产」** 的独立入口，S3 顶部可直接跳转），
> 「出图」页的预览来自 **S3 提示词产物**（每格正/负向），并在点「出图」时自动准备缺的提示词。

### 角色触发词 与 提示词预设

- **角色卡**（`characters` 表）：`name` / `trigger_words`（触发词）/ `lora_name`（角色 LoRA，**可留空**）/
  `lora_weight` / `use_lora` / `prompt_block`（固定外观词块）。触发词与角色 LoRA 绑定。
- **提示词预设**（`prompt_presets` 表）：`kind`=positive/negative、`scope`=global/project、`is_default`、
  `loras`（预设可绑定 LoRA）。勾「默认」的那个会被 S3 当作风格骨架（正向前缀 / 负向基础）喂给 AI，
  其 `loras` 也会**合入每格提示词**。本项目默认优先于全局默认，设置默认只替换同作用域的同类默认项。
- **S3 生成时一并算出**：每格的**宽高按该格画框（模板几何）**计算（长边 1216、64 对齐，与排版一致）；
  LoRA 合并顺序 = 预设 → 项目默认 → 出场角色 → 模型给的角色 LoRA（后者覆盖权重）。
  出图阶段（S5）**直接套用** S3 的宽高与 LoRA，不再重复解析角色。
- **提示词审查**：S3 页每格有「预览」（看完整正/负向 + LoRA + 尺寸 + 画框），
  每页有「预览整页」（一次看完整页每格），可就地「改这格」。
- `POST /projects/{id}/panels/{panel_ref}/prepare`：为某一格生成“带预设默认值 + 出场角色 LoRA”的
  提示词产物（S3 未跑时也能出图，不用手填参数）。

## 实施进度

- ✅ **M0**：后端骨架 + 版本化/血缘 + LLM 层 + ComfyUI 客户端与参数映射 + 作业队列 + 模板菜单 + MED 桥（已端到端验证）
- ✅ **M1**：S1/S3/S4 阶段与提示词资产 + comic-bridge 扩展 + 前端 UI + 阶段编排与双粒度审查门（已端到端验证）
- ✅ **M2**：S5 出图（LoRA 三级解析/可关角色 LoRA/批量张数/出图工作台挑图）+ 技法叠加（集中线/运动线）+ 无头自动驾驶（已端到端验证）
- ✅ **M3**：S7 PDF/CBZ 导出 + 整册预览入口（已端到端验证）
- ⏳ 后续：S2 正文分段持久化与"场→页"映射精化、无头跑酒馆（免开标签页）、出版级一致性调优

## 已验证的关键链路（本机实测）

| 链路 | 验证方式 | 结果 |
|---|---|---|
| MED 桥装模板/落词/贴图/导出 | `tests/test_med_bridge.py`（无头） | 装 3 格 → 落词 3/3 → 贴图 → 导出 PNG ✅ |
| MED 集中线/运动线叠加 | 无头调 `applyMangaTone` | 两者均 `ok`，导出图明显变化 ✅ |
| 工作流参数映射 + LoRA 链/旁路 | `tests/test_workflow_mapping.py` | 全通过 ✅ |
| 占位符 `%prompt%` + LoRA 堆加载 + UI→API 转换 | `tests/test_workflow_mapping.py` | 全通过 ✅ |
| 版本化 + 血缘 + 失效传播 | `tests/test_artifacts.py` | 改上游 → 下游标 stale ✅ |
| 分页合成（S6） | 真实服务 + 桥 | 3 格成页并落盘 ✅ |
| 整册导出（S7） | 真实服务 | PDF + CBZ 均生成 ✅ |
| **酒馆正文桥（S2）** | 无头浏览器打开酒馆、触发扩展 | 后端收到正文产物；捕获到酒馆发出的 **21,441 字符** prompt，其中同时含**角色卡**、**世界书**、我们的引导词 ✅ |
