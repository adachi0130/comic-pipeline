# AI 漫画自动化生产线（MVP）

只写故事大纲，逐阶段产出漫画：**结构规划 → 正文 → 分格脚本 → 分镜提示词 → 逐格出图 → 分页合成 → 导出**，
每个阶段后面设一道人工审查门（也可切「全自动」一键跑完）。

- **大脑**：本项目自研后端（FastAPI + SQLite + 作业队列 + 版本化/血缘）。
- **笔杆（S2 正文）**：SillyTavern 扩展桥，正文跑酒馆完整管线（角色卡 + 世界书 + 预设 + Prompt Manager）。
- **画笔（S6 拼页）**：Manga Editor Desu（69 版式模板 + 气泡 + 网点/集中线/运动线），经同源 iframe + 注入桥驱动。
- **出图（S5）**：后端直接调 ComfyUI（仙宫云经 SSH 隧道，本机 ComfyUI 可作备用），只操作你现有 Anima 文生图工作流的参数。

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
    stages/           S1..S7 作业处理器（M0 已实现 S5）
    api/routes/       REST + SSE
  prompts/            S1/S3/S4 提示词（M1 交付）
  scripts/            build_template_menu.py / parse_med_templates.mjs / fetch_editor.*
  static/
    editor/           vendor 的 Manga Editor Desu（不入 git，按 EDITOR_VERSION.md 拉取）
    ui/               自研前端（M1）+ editor_bridge/（MED 驱动桥 + 人工验证页）
extensions/comic-bridge/   SillyTavern 扩展（M1 交付）
config/
  workflows/anima_t2i.json      你的 Anima 文生图工作流（API 格式，需自备）
  workflow_params.yaml          工作流参数映射表（脚本自动初猜后可手改）
tests/                          离线自测 + MED 桥冒烟测试
```

## 快速开始

```bash
# 1. 依赖
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m pip install playwright pillow
.venv/Scripts/python.exe -m playwright install chromium

# 2. 拉取 Manga Editor Desu（约 99MB，不入 git）
bash backend/scripts/fetch_editor.sh      # 或 powershell -File backend/scripts/fetch_editor.ps1

# 3. 生成 69 个模板菜单（需要上一步的 editor 里的模板 JS）
.venv/Scripts/python.exe backend/scripts/build_template_menu.py \
    --vertical  backend/static/editor/js/svg/manga-panels-image-vertical.js \
    --landscape backend/static/editor/js/svg/manga-panels-image-landscape.js

# 4. 起后端
cd backend && ../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8770
#   - 业务接口    http://127.0.0.1:8770/api/*
#   - MED 工作台  http://127.0.0.1:8770/editor/
#   - 桥人工验证  http://127.0.0.1:8770/ui/editor_bridge/index.html
```

## 自测

```bash
.venv/Scripts/python.exe tests/test_workflow_mapping.py   # 工作流参数映射 + LoRA 链/旁路
.venv/Scripts/python.exe tests/test_artifacts.py          # 版本化 + 血缘 + 失效传播
.venv/Scripts/python.exe tests/test_med_bridge.py         # MED 桥端到端（无头）
```

## M0 最小闭环（已验证）

1. **连出图后端**：`POST /api/comfy/connect {backend, url, api_key}` —— 一次请求把后端上
   **已有的工作流列表 + LoRA/checkpoint/VAE 列表**拉回来。
   - 对应 Manga Editor Desu 的「外部 AI 设置」：填个地址就能连，不是让你手工传文件。
   - LoRA 列表来自 `/models/loras`；工作流列表来自 `/userdata?dir=workflows`。
2. **点一个工作流看参数**：`POST /api/comfy/server-workflow {name}` —— 读该工作流的原始文件，
   **UI 格式自动转 API 格式**（靠 `/object_info` 把控件位置对应到输入名），并体检出：
   提示词参数、采样参数、LoRA 槽（含每个槽的现有 LoRA/开关/权重）、缺失节点。
3. **选定就用**：`POST /api/comfy/import-from-server {name}` —— 存进登记表、设为当前、自动映射参数。
4. **试跑一张**：`POST /api/comfy/test-run` —— 验证「连接 + 工作流 + 参数 + LoRA」整条通不通，
   返回可预览图片 URL。（实测：832×1216 图，约 2 分钟）
5. **出几格**：`POST /api/projects/{id}/panels/{panel_ref}/generate` 入队 S5 出图。
6. **MED 拼第一页**：桥把模板 SVG `loadSVGPlusReset` 装上，按阅读顺序落提示词、`putImageInFrame` 贴图，`canvas2DataURL` 导出整页 PNG。

### 出图工作流支持范围

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
> 顶部还管**角色触发词/LoRA 绑定**与**正负向提示词预设**），
> 「出图」页的预览来自 **S3 提示词产物**（每格正/负向），并在点「出图」时自动准备缺的提示词。

### 角色触发词 与 提示词预设

- **角色卡**（`characters` 表）：`name` / `trigger_words`（触发词）/ `lora_name`（角色 LoRA，**可留空**）/
  `lora_weight` / `use_lora` / `prompt_block`（固定外观词块）。触发词与角色 LoRA 绑定。
- **提示词预设**（`prompt_presets` 表）：`kind`=positive/negative、`scope`=global/project、`is_default`。
  勾「默认」的那个会被 S3 当作风格骨架（正向前缀 / 负向基础）喂给 AI。
- `_characters()` 与 `_default_presets()` 把这些注入 S3 的提示词模板
  （`{{CHARACTERS_JSON}}` / `{{PRESET_POSITIVE}}` / `{{PRESET_NEGATIVE}}`）。
- 若角色 `lora_name` 为空，S3 不列它的 LoRA，改用 `prompt_block + trigger_words` 描述外观。
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

## 酒馆扩展（S2）安装与启用

1. 把 `extensions/comic-bridge/` 复制到 `<SillyTavern>/data/default-user/extensions/comic-bridge/`；
2. 酒馆重启后，在「扩展」面板里打开开关（或写 `data/default-user/settings.json` 的
   `extension_settings.comicBridge = {"enabled": true, "backend": "http://127.0.0.1:8770"}`）；
3. 后端入队正文请求（`POST /api/projects/{id}/prose/request`）→ 扩展轮询领取 → 酒馆原生生成 →
   正文回传后端置「待审」。
4. 生成期间酒馆标签页需保持打开；后端已对 `http://localhost:8000` 放行 CORS。

> 自测用 `tools/mock_llm.py` 起本地 OpenAI 兼容 mock（支持流式），可无额度验证整条 S2 链路。


## 关键约束（已核实）

- **Manga Editor Desu 无自动化 API**（无 postMessage / URL 参数 / 全局导出对象）。我们用同源 iframe + 注入 `med_bridge.js`（运行在 MED 全局作用域）调用其顶层函数；版本锁定见 `backend/static/EDITOR_VERSION.md`，升级前跑 `tests/test_med_bridge.py`。
- **MED 没有内置简体中文字体**（只有日文 Noto Sans JP）。桥的 `setupCJKFonts()` 用 MED 自带字体管理器以 `local()` 方式注册系统字体（微软雅黑），不改 MED 源码。
- **MED 自身不能改 LoRA 权重**、缺 `%prompt%` 时静默失败，故**出图放在后端**，MED 只负责排版/嵌字/技法/导出。
- **git 仅本地**（无远程）。
