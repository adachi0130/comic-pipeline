<div align="center">

# 🎬 Comic Pipeline

**Write one outline. Get a finished manga volume.**

An end-to-end, human-in-the-loop pipeline that turns a story outline into a paginated,
fully inked comic — powered by **SillyTavern** for prose, **an OpenAI-compatible LLM** for
storyboarding, **ComfyUI** for panel art, and **Manga Editor Desu** for page composition.

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![ComfyUI](https://img.shields.io/badge/Backend-ComfyUI-1f6feb)](https://github.com/comfyanonymous/ComfyUI)
[![SillyTavern](https://img.shields.io/badge/Prose-SillyTavern-6f42c1)](https://github.com/SillyTavern/SillyTavern)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![Status: MVP](https://img.shields.io/badge/Status-MVP-orange.svg)](#roadmap)

[English](#english) · [简体中文](#简体中文) · [User Guide](docs/使用手册.md) · [Roadmap](docs/后续需求与路线图.md)

</div>

---

## English

> **TL;DR** — Clone, create a venv, run one fetch script for the editor, start uvicorn,
> open `http://127.0.0.1:8770/ui/`. Everything else (ComfyUI, SillyTavern, LLM keys) is optional
> and can be connected from the UI when you need it.

### Why

Generating a single image is easy. Producing a **consistent, paginated comic** is not — you
still have to keep the story coherent, decide how panels split across pages, write per-panel
prompts, keep characters and styles stable, hand-place every result into a page layout, and
export something a reader can actually open.

Comic Pipeline turns that into a repeatable assembly line. Every stage produces a **versioned
artifact** with lineage, so editing one thing invalidates only what depends on it instead of
forcing you to re-run the entire book.

### Pipeline

```text
 outline
    │
    ▼
 S1  Prose ────────────── SillyTavern (character card / world book / preset) or any LLM
    │                     human review gate
    ▼
 S2  Pagination & panels ─ AI picks page layouts + panel geometry
    │                     human review gate
    ▼
 S3  Panel prompts ─────── positive / negative / size / LoRA stack per panel
    │                     human review gate
    ▼
 S4  Panel generation ──── ComfyUI (local or cloud, optional SSH tunnel)
    │                     candidate comparison, adopt writes a new version
    ▼
 S5  Page composition ──── Manga Editor Desu via same-origin iframe bridge
    │                     bubbles, screentones, focus lines, motion lines
    ▼
 S6  Volume export ─────── PDF / CBZ
```

Every gate can be set to **manual** (stop and review) or **auto** (pass through), so the same
code path supports both "careful editor" and "unattended batch run".

### What you get

| | Capability | Notes |
|---|---|---|
| 🧠 | **Versioned artifacts with lineage** | Edits propagate invalidation downstream, not up |
| ✍️ | **Prose from SillyTavern** | Keeps your character cards, world books, presets and Prompt Manager |
| 🧩 | **AI storyboarding** | LLM proposes page layouts and panel splits; you can edit them |
| 🎯 | **Per-panel prompt workbench** | Positive/negative, size, seed, sampler params and LoRA per panel |
| 🖼️ | **ComfyUI integration** | Import API- or UI-format workflows; parameters auto-mapped |
| ⚖️ | **Candidate comparison** | Side-by-side compare, adopt writes a new version and keeps old files |
| 📐 | **Page editor** | 69 layout templates, bubbles, screentones, focus/motion lines |
| 📦 | **One-click export** | Whole-volume PDF / CBZ with an export center and version history |
| 🔒 | **Data-safety hardening** | Artifact paths sandboxed under `data/projects/<id>/`, exclusive file creation |

### Requirements

| Dependency | Version | Needed for | Required |
|---|---|---|---|
| **Python** | 3.11 – 3.13 (tested 3.13.9) | Backend and scripts | ✅ Yes |
| **Git** | Any recent | Cloning | ✅ Yes |
| **Node.js** | 18+ (tested 22) | Building the layout-template menu **once** | ⚠️ Only for that script |
| **ComfyUI** | Any reachable instance | Panel generation (S4) | ⭕ Only to generate art |
| **SillyTavern** | 1.13.x (tested 1.13.3) | Prose generation (S1) | ⭕ Only to write prose in Tavern |
| **LLM API key** | Any OpenAI-compatible endpoint | Storyboarding / prompts (S2, S3) | ⭕ Only for AI stages |

> The backend starts fine **without** ComfyUI, SillyTavern or the editor — those features
> simply stay unavailable. Steps 0–3 below are enough to open the UI.

### Quick start

```bash
git clone https://github.com/adachi0130/comic-pipeline.git
cd comic-pipeline
```

**1. Create a virtualenv and install dependencies**

```bash
# Windows
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m playwright install chromium

# macOS / Linux
python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
```

<details>
<summary>Why Playwright? (≈100–150 MB on first install)</summary>

A headless Chromium drives the **Manga Editor Desu composition bridge** and the
**resident SillyTavern bridge** (so you do not have to keep a Tavern tab open).

</details>

**2. Fetch Manga Editor Desu (≈99 MB, not vendored)**

The editor is third-party GPL-3.0 code, so it is **not** shipped in this repository.
A script pulls the pinned commit into `backend/static/editor/`:

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File backend/scripts/fetch_editor.ps1

# macOS / Linux
bash backend/scripts/fetch_editor.sh
```

The locked version is recorded in `backend/static/EDITOR_VERSION.md`.

**3. Build the layout menu and seed the technique library**

```bash
# Parse the editor's 69 layout templates into the DB (requires node)
.venv/Scripts/python.exe backend/scripts/build_template_menu.py \
    --vertical  backend/static/editor/js/svg/manga-panels-image-vertical.js \
    --landscape backend/static/editor/js/svg/manga-panels-image-landscape.js

# Seed techniques used by S3 prompts (focus lines, motion lines, screentones, SFX…)
.venv/Scripts/python.exe backend/scripts/seed_techniques.py
```

Tables are created automatically — no manual DB setup.

**4. Start the backend** (must run from `backend/`)

```bash
cd backend
../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8770
# macOS / Linux: ../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8770
```

Or use the one-shot launcher (also starts the resident Tavern bridge):

```bash
.venv/Scripts/python.exe tools/start_all.py
```

**5. Open it**

| Entry point | URL |
|---|---|
| Workbench UI | http://127.0.0.1:8770/ui/ |
| Manga editor | http://127.0.0.1:8770/editor/ |
| Health check | http://127.0.0.1:8770/api/health |

### Configuration

**ComfyUI** — connect from *Generation → Generation Settings*:

- **Local**: `http://127.0.0.1:8188`; the UI pulls your existing workflows plus the
  LoRA / checkpoint / VAE lists.
- **Cloud**: paste the endpoint; an optional `Authorization: Bearer <key>` is sent.
  For SSH-only hosts, enable the tunnel in `config/comfy.yaml` or environment variables.

Workflows can be imported from the backend or uploaded as JSON. API-format files parse
offline; UI-format files are converted by reading node definitions from ComfyUI (subgraphs
must be expanded first). Prompts use `%prompt%` / `%negative%` placeholders, preserving any
fixed text around them, e.g. `masterpiece, %prompt%`.

**LLM** — any OpenAI-compatible endpoint (DashScope, DeepSeek, Kimi, Zhipu, OpenRouter,
Ollama, vLLM…). Fill `base_url` + `api_key` + `model` in the UI; nothing is vendor-locked.

**SillyTavern** — copy `extensions/comic-bridge/` into
`<SillyTavern>/data/default-user/extensions/comic-bridge/`, restart Tavern, enable the
extension, then let the backend enqueue prose requests. Prefer not to keep a tab open?
Use `tools/tavern_bridge.py`, which `start_all.py` already launches.

### Headless autopilot

Run S1→S6 without touching the UI (set the project's `review_mode` to `auto` for a fully
unattended run):

```bash
.venv/Scripts/python.exe backend/scripts/autodrive.py --project 1
```

### Project layout

```text
backend/
  app/
    config.py       paths, ComfyUI, SSH tunnel, page spec, workflow mapping
    models.py       SQLAlchemy models (artifacts, lineage, templates, providers, jobs)
    artifacts.py    versioning + lineage + invalidation propagation
    schemas.py      stage contracts (pydantic)
    llm/            provider-agnostic LLM client (retry, validation, logging)
    comfy/          client, parameter auto-mapping, SSH tunnel, generation service
    med/            PageComposer abstraction + editor adapter
    stages/         S1..S6 job handlers
    api/routes/     REST + SSE
  prompts/          versioned S1/S2/S3 prompts
  scripts/          fetch_editor.*, build_template_menu.py, seed_techniques.py, autodrive.py
  static/
    editor/         vendored Manga Editor Desu (fetched, not in git)
    ui/             frontend + editor_bridge/ (iframe driver)
extensions/comic-bridge/   SillyTavern extension
tests/                     offline regression + bridge smoke tests
tools/                     start_all.py / tavern_bridge.py / mock_llm.py
```

### Testing

```bash
.venv/Scripts/python.exe -X utf8 -B -m unittest discover -s tests -p 'test_*safety.py' -v
.venv/Scripts/python.exe tests/test_workflow_mapping.py   # workflow mapping + LoRA chains
.venv/Scripts/python.exe tests/test_artifacts.py          # versioning + lineage + invalidation
.venv/Scripts/python.exe tests/test_med_bridge.py         # end-to-end editor bridge (needs the editor)
```

Safety regressions run against temporary directories and in-memory SQLite; processes,
network generation and the editor are isolated or mocked.

### Troubleshooting

<details>
<summary><b>ModuleNotFoundError: app.main</b></summary>

Start uvicorn from `backend/` — not from the repository root.

</details>

<details>
<summary><b><code>/ui/</code> is 404 or the page will not load</b></summary>

Confirm you launched from `backend/` and that port 8770 is free.

</details>

<details>
<summary><b><code>/editor/</code> is missing</b></summary>

Step 2 was skipped. The backend does not mount a missing directory, so startup still works —
but page composition will not.

</details>

<details>
<summary><b>S2 reports "no templates"</b></summary>

Run `backend/scripts/build_template_menu.py` (needs node).

</details>

<details>
<summary><b>"Cannot connect to ComfyUI"</b></summary>

Check that ComfyUI is running, the URL/port is right, and whether the cloud endpoint needs
an API key or an SSH tunnel.

</details>

<details>
<summary><b>"Missing nodes" during generation</b></summary>

Your workflow references a `class_type` your ComfyUI does not have. The workflow health
check lists exactly which ones.

</details>

### Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first
(Conventional Commits, one logical change per commit, never commit `.env`, databases,
generated workflows or the vendored editor). By submitting a PR you agree to license your
contribution under GPL-3.0-only.

### Acknowledgments

- **[Manga Editor Desu](https://github.com/new-sankaku/manga-editor-desu)** by new-sankaku —
  page composition (GPL-3.0, fetched at a pinned commit, not redistributed here).
- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI)** — generation backend.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — prose generation.

### License

Copyright (C) 2026 adachi0130.

Released under the **GNU General Public License v3.0 only** ([`LICENSE`](LICENSE)).
You may study, modify, and redistribute it, but **derivative works must also be released
under GPL-3.0 with full corresponding source**. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for third-party components and the exact boundary around the editor bridge.

<div align="right"><a href="#-comic-pipeline">↑ back to top</a></div>

---

## 简体中文

> **一句话**：克隆仓库 → 建虚拟环境 → 跑一次编辑器拉取脚本 → 启动 uvicorn →
> 打开 `http://127.0.0.1:8770/ui/`。ComfyUI、酒馆、LLM Key 都是可选项，用到了再在前端连。

### 为什么做这个

单独生成一张图不难。难的是**做成一本连贯、能翻页的漫画**：故事要一致，分页要合理，
每格提示词要写得准，角色和画风要稳，出图后还得一格一格摆进版式，最后导出成读者能打开的文件。

Comic Pipeline 把这条链路做成流水线：每个阶段产出**带版本和血缘的产物**，改一处只会让
下游失效，而不用把整本书重跑一遍。

### 流水线

```text
 故事大纲
    │
    ▼
 S1  正文 ─────────────── 酒馆（角色卡 / 世界书 / 预设）或任意 LLM
    │                     人工审查门
    ▼
 S2  分页分格 ─────────── AI 选版式 + 划分每一格
    │                     人工审查门
    ▼
 S3  分镜提示词 ───────── 每格正向 / 负向 / 尺寸 / LoRA 组合
    │                     人工审查门
    ▼
 S4  逐格出图 ─────────── ComfyUI（本机或云端，可选 SSH 隧道）
    │                     候选图对比，采用即写新版本
    ▼
 S5  分页合成 ─────────── 同源 iframe 桥驱动 Manga Editor Desu
    │                     气泡、网点、集中线、运动线
    ▼
 S6  整册导出 ─────────── PDF / CBZ
```

每道门都可切 **manual**（停下来审）或 **auto**（自动通过），同一套代码既能"精修"也能"无人值守跑完"。

### 能力一览

| | 能力 | 说明 |
|---|---|---|
| 🧠 | **产物版本化 + 血缘** | 修改只向下游传播失效，不会牵连上游 |
| ✍️ | **酒馆写正文** | 复用你已有的角色卡、世界书、预设与 Prompt Manager |
| 🧩 | **AI 分镜** | LLM 给出每页版式与分格方案，可人工修改 |
| 🎯 | **逐格提示词工作台** | 每格正负面、尺寸、种子、采样参数与 LoRA 独立可调 |
| 🖼️ | **ComfyUI 接入** | 支持 API / UI 两种工作流格式，参数自动映射 |
| ⚖️ | **候选图对比** | 并排比较，采用写新版本并保留旧文件 |
| 📐 | **漫画编辑器** | 69 个版式模板，气泡、网点、集中线、运动线 |
| 📦 | **一键导出** | 整册 PDF / CBZ，导出中心展示纳入页与历史版本 |
| 🔒 | **数据安全加固** | 产物路径限制在 `data/projects/<id>/`，文件排他创建 |

### 环境要求

| 依赖 | 建议版本 | 用来做什么 | 必需 |
|---|---|---|---|
| **Python** | 3.11 – 3.13（实测 3.13.9） | 后端与脚本 | ✅ 必需 |
| **Git** | 任意较新版本 | 克隆仓库 | ✅ 必需 |
| **Node.js** | 18+（实测 22） | 只在**生成版式模板菜单**时用一次 | ⚠️ 跑该脚本时必需 |
| **ComfyUI** | 任意可访问实例 | 逐格出图（S4） | ⭕ 想真出图才需要 |
| **SillyTavern** | 1.13.x（实测 1.13.3） | 正文生成（S1） | ⭕ 想用酒馆写正文才需要 |
| **LLM API Key** | 任意 OpenAI 兼容端点 | 分页分格 / 分镜提示词 | ⭕ 跑 AI 阶段才需要 |

> **没有编辑器、没有 ComfyUI、没有酒馆，后端也能正常启动**，只是对应功能用不了。
> 下面第 1–4 步做完就能打开前端界面。

### 快速开始

```bash
git clone https://github.com/adachi0130/comic-pipeline.git
cd comic-pipeline
```

**第 1 步：建虚拟环境并装依赖**

```bash
# Windows
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m playwright install chromium

# macOS / Linux
python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
```

<details>
<summary>为什么要装 Playwright？（首次约 100–150 MB）</summary>

无头 Chromium 用来驱动 **MED 合成桥**和**酒馆常驻桥**（这样不必一直开着酒馆标签页）。

</details>

**第 2 步：拉取 Manga Editor Desu（约 99 MB，不入 git）**

编辑器是第三方 GPL-3.0 代码，**不随仓库分发**，用脚本按锁定 commit 拉取到
`backend/static/editor/`：

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File backend/scripts/fetch_editor.ps1

# macOS / Linux
bash backend/scripts/fetch_editor.sh
```

锁定版本见 `backend/static/EDITOR_VERSION.md`。

**第 3 步：生成版式模板菜单 + 灌入技法库**

```bash
# 解析 69 个版式模板，写入数据库（需要 node）
.venv/Scripts/python.exe backend/scripts/build_template_menu.py \
    --vertical  backend/static/editor/js/svg/manga-panels-image-vertical.js \
    --landscape backend/static/editor/js/svg/manga-panels-image-landscape.js

# 灌入技法库（集中线 / 运动线 / 网点 / 拟声词…），S3 提示词会用到
.venv/Scripts/python.exe backend/scripts/seed_techniques.py
```

脚本会自动建表（`init_db`），不需要手动建库。

**第 4 步：启动后端**（必须在 `backend/` 目录下运行）

```bash
cd backend
../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8770
# macOS / Linux: ../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8770
```

或使用一键脚本（会连同常驻酒馆桥一起启动）：

```bash
.venv/Scripts/python.exe tools/start_all.py
```

**第 5 步：打开界面**

| 入口 | 地址 |
|---|---|
| 前端工作台 | http://127.0.0.1:8770/ui/ |
| 漫画编辑器 | http://127.0.0.1:8770/editor/ |
| 健康检查 | http://127.0.0.1:8770/api/health （应返回 `{"ok": true, ...}`） |

### 配置

**出图（ComfyUI）** —— 在「出图 → 出图设置」里配置：

- **连本机**：填 `http://127.0.0.1:8188`，会拉回已有工作流列表与 LoRA / checkpoint / VAE 列表。
- **连云端**：填云端地址；需要鉴权时发送 `Authorization: Bearer <key>`。
  只能 SSH 访问的机器可在 `config/comfy.yaml` 或环境变量里开隧道。

工作流支持从后端拉取或上传 JSON。API 格式可离线解析；UI 格式需要连 ComfyUI 读节点定义
（子图需先展开）。提示词使用 `%prompt%` / `%negative%` 占位符并保留前后固定词，
例如 `masterpiece, %prompt%`。

**LLM** —— 任意 OpenAI 兼容端点（DashScope / DeepSeek / Kimi / 智谱 / OpenRouter / Ollama / vLLM…），
在前端填 `base_url` + `api_key` + `model` 即可，代码不绑定任何厂商。

**酒馆（SillyTavern）** —— 把 `extensions/comic-bridge/` 复制到
`<SillyTavern>/data/default-user/extensions/comic-bridge/`，重启酒馆并启用扩展，
后端即可入队正文请求。不想一直开着酒馆标签页？用 `tools/tavern_bridge.py`，
`start_all.py` 已经会一起启动。

### 无头自动驾驶

不经前端，直接串起 S1→S6（把项目 `review_mode` 设为 `auto` 即全程无人值守）：

```bash
.venv/Scripts/python.exe backend/scripts/autodrive.py --project 1
```

### 目录结构

```text
backend/
  app/
    config.py       路径 / ComfyUI / 隧道 / 页面规格 / 工作流参数映射
    models.py       SQLAlchemy 模型（产物版本化、血缘、模板、技法、供应商、作业）
    artifacts.py    版本化 + 血缘 + 失效传播
    schemas.py      阶段产物契约（pydantic）
    llm/            供应商无关 LLM 客户端（重试、校验、留痕）
    comfy/          ComfyUI 客户端 / 参数自动映射 / SSH 隧道 / 出图服务
    med/            PageComposer 抽象 + 编辑器适配器
    stages/         S1..S6 作业处理器
    api/routes/     REST + SSE
  prompts/          S1/S2/S3 版本化提示词
  scripts/          fetch_editor.* / build_template_menu.py / seed_techniques.py / autodrive.py
  static/
    editor/         vendor 的 Manga Editor Desu（拉取，不入 git）
    ui/             自研前端 + editor_bridge/（iframe 驱动桥）
extensions/comic-bridge/   酒馆扩展
tests/                     离线回归 + 桥冒烟测试
tools/                     start_all.py / tavern_bridge.py / mock_llm.py
```

### 自测

```bash
.venv/Scripts/python.exe -X utf8 -B -m unittest discover -s tests -p 'test_*safety.py' -v
.venv/Scripts/python.exe tests/test_workflow_mapping.py   # 工作流映射 + LoRA 链/旁路
.venv/Scripts/python.exe tests/test_artifacts.py          # 版本化 + 血缘 + 失效传播
.venv/Scripts/python.exe tests/test_med_bridge.py         # 编辑器桥端到端（需已拉取编辑器）
```

安全回归使用独立临时目录和内存 SQLite，进程、网络出图与合成器均隔离或 mock。

### 排错

<details>
<summary><b>ModuleNotFoundError: app.main</b></summary>

必须在 `backend/` 目录下启动 uvicorn，不能在仓库根目录启动。

</details>

<details>
<summary><b><code>/ui/</code> 打不开或返回 404</b></summary>

确认从 `backend/` 启动，且 8770 端口没有被占用。

</details>

<details>
<summary><b><code>/editor/</code> 打不开</b></summary>

没执行第 2 步。后端不会挂载不存在的目录，所以不会导致启动失败，但合成功能用不了。

</details>

<details>
<summary><b>S2 提示"无模板"</b></summary>

没跑 `backend/scripts/build_template_menu.py`（需要 node）。

</details>

<details>
<summary><b>出图报"连不上 ComfyUI"</b></summary>

确认 ComfyUI 已启动、地址端口正确，云端地址是否需要 key 或 SSH 隧道。

</details>

<details>
<summary><b>出图报"缺节点"</b></summary>

工作流用了你 ComfyUI 没装的 `class_type`，工作流体检会列出具体缺哪些。

</details>

### 参与贡献

欢迎提 issue 和 PR，动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)
（Conventional Commits、一次提交只做一件事、不要提交 `.env` / 数据库 / 生成的工作流 / vendor 的编辑器）。
提交 PR 即表示同意以 GPL-3.0-only 授权你的贡献。

### 致谢

- **[Manga Editor Desu](https://github.com/new-sankaku/manga-editor-desu)**（作者 new-sankaku）——
  分页合成与精修（GPL-3.0，按锁定 commit 拉取，不随本仓库分发）。
- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI)** —— 出图后端。
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** —— 正文生成。

### 许可证

Copyright (C) 2026 adachi0130。

本项目按 **GNU General Public License v3.0（仅此版本 / GPL-3.0-only）** 发布，见 [`LICENSE`](LICENSE)。
欢迎学习、修改、二次开发与分发，但**分发衍生作品时必须同样以 GPL-3.0 开放对应源码**，不得闭源再发布。
第三方组件与编辑器桥的边界说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<div align="right"><a href="#-comic-pipeline">↑ 回到顶部</a></div>
