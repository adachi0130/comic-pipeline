# 漫画编辑器替换 MED：新对话交接

编写日期：2026-10-28（Asia/Shanghai）。本次只编写交接文档，没有实施编辑器替换。

## 1. 新对话的任务与授权

用户希望将 `YILING0013/novelai_local_web` 中实用的漫画编辑能力迁入本项目，最终去掉 MED 运行依赖，漫画编辑继续在本项目 Web 页面内完成。

用户明确补充：**“抄”允许直接复制、修改、复用上游代码，正确处理开源协议即可，不限于参考界面后重新实现。**

必须同时满足：

- 保留本项目现有的 MED 来源分页分格模板，**不用参考项目自带的模板库替换它们**。
- 保留既有项目、产物、审核、版本、续跑、出图、预设、导出和保存保护功能。
- 一键自动生成的默认成品仍然只把图片拼入模板；不自动加集中线、运动线、文字或其他装饰。手工编辑工具可以提供，用户主动操作时才使用。
- 既要替换手动编辑器，也要替换后台 S5 自动拼页对 MED 的依赖。
- 按独立可回滚批次实施，每批提交本地 Git；不要自行合入 main 或推送远程。
- 用户不喜欢反复确认；上述实施范围已有授权，正常可逆实现无需重新申请。只有真正缺失的信息或无法自行解决的冲突才提问。

“不影响之前功能”是最终验收条件，不能用只展示新画布或新图层界面代替完整迁移。

## 2. 当前仓库与基线

| 项目 | 编写时状态 |
|---|---|
| 工作区 | `E:\GeneralApp\zcodefile\.zcode\workspace\default\comic-pipeline` |
| 当前分支 | `dev-adachi` |
| 功能基线 | `ca1b3b0380f7ef16c235f11c286ffd06f85d2026` |
| 远程 | `https://github.com/adachi0130/comic-pipeline.git` |
| 编写文档前 Git 状态 | 工作区干净；本地领先 `origin/dev-adachi` 6 个提交；本交接文档会另有提交 |
| 技术栈 | FastAPI、SQLAlchemy/SQLite、APScheduler；前端原生 ES modules，无现成 React 应用构建链 |
| 运行入口 | `http://127.0.0.1:8770/ui/`，后端同源提供静态页面和 API |
| 外部服务 | 酒馆 `:8000`，本机 ComfyUI `:8188`；实际连接以已保存配置为准 |

新对话先执行 `git status`、查看 HEAD 和本文件，确认用户是否在此后又产生修改；不要强制重置到上述基线。

近期提交：

| 提交 | 内容 |
|---|---|
| `ca1b3b0` | 一键生成带入正负面预设、配置编辑保存返回、合并菜单 |
| `e562709` | 大纲经 S1 扩写、断点续跑、模型失败提示、版式预览 |
| `9cf5780` | 引用故事大纲与目标页数 |
| `68b3bf4` | S3 返回错误页号的安全归一化与配置确认窗口 |
| `9726852` | 正文一键生成与纯贴图拼页 |

长期背景见 `docs/易用性改进清单.md`、`docs/使用手册.md`、`docs/后续需求与路线图.md` 和 `CHANGELOG.md`。其中“A2 先保留 MED”的旧决策已被本次替换需求更新。

## 3. 已核对的参考项目

参考仓库：[YILING0013/novelai_local_web](https://github.com/YILING0013/novelai_local_web)。

本次通过 GitHub API 确认的参考提交：**`4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3`**，提交时间 `2026-10-26T10:28:31Z`。后续应以此提交建立可追溯移植基线；要跟进更新时另外记录差异。网页缓存中的旧提交历史不能当成当前 HEAD。

已实际读取主组件的导入、模块导出和存储入口；**没有启动、构建或端到端验证参考编辑器**。

### 3.1 参考源码地图

以下目录均相对参考仓库：`next_nai_web/src/components/ai-painting/ComicWorkspace/`。

| 文件 | 已核对的作用 / 移植时关注点 |
|---|---|
| `ComicWorkspace.js` | 主交互组件；依赖 React、MUI、lucide、文件下载、i18n、ApiClient 等，不能单独复制一个文件就运行 |
| `comicDocument.mjs` | 页面、画框、几何变换、切割和图片适配；包含 `COMIC_TEMPLATES`、`applyTemplate`，这些模板入口须替换成本项目模板适配器 |
| `ComicPageArt.js` | 页面显示组件，可作为统一画布渲染入口的调查起点 |
| `ComicCropDialog.js` | 构图调整交互，依赖画框边界和图片适配函数 |
| `comicElements.mjs`、`ComicElementArt.js`、`ComicElementDialog.js` | 元素、文字与对话内容的移植调查入口 |
| `comicLayers.mjs`、`ComicLayerPanel.js` | 图层和渲染次序相关模块 |
| `comicSnapping.mjs` | 切割、拖动、旋转吸附相关纯逻辑 |
| `comicStorage.mjs` | 草稿和页面库存储，现用 IndexedDB；还导出 `renderComicPage`，应与展示渲染一起核对 |
| `comicProject.mjs` | 可编辑项目导入导出，涉及页面、模板、草稿和任务信息 |
| `ComicAIStudio.js`、`ComicLLMSettings.js`、`comicAI.mjs` | 参考项目自己的 AI 漫画流程；不要让它覆盖本项目一键编排和供应商配置 |
| `*.test.mjs` | 几何、元素、图层、项目包等已有测试，可连同相关代码按许可迁入并改造 |

源码目录：[固定提交的 ComicWorkspace](https://github.com/YILING0013/novelai_local_web/tree/4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3/next_nai_web/src/components/ai-painting/ComicWorkspace)。

参考编辑器涵盖画框编辑、构图、图层、气泡、文字、笔画、撤销重做、项目包与触摸操作；其页面资料主要保存在浏览器 IndexedDB。来源：[漫画工作区说明](https://github.com/YILING0013/novelai_local_web/blob/4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3/docs/comic-workspace.md)。

### 3.2 许可处理属于实施内容

- 已核对：参考仓库根目录 `LICENSE` 和 `next_nai_web/LICENSE` 标注 **AGPL-3.0**；`nai_flask/LICENSE` 标注 **GPL-3.0**。不能把整个仓库所有文件都简单视为同一个许可。
- 用户允许直接迁入代码；应保留原版权、许可头、原文件来源与修改记录，并补齐相应许可文本和源码提供说明。逐文件、字体和第三方依赖另行核对，不移除来源声明。
- 建议记录 `upstream 仓库 / commit / 原路径 / 本地路径 / 许可 / 修改说明` 的来源清单，随移植批次更新。
- 本项目根目录本次未发现独立 LICENSE 文件；不能擅自声称所有既有代码已采用 MIT 等许可。
- 当前 `THIRD_PARTY_NOTICES.md` 对 MED 的隔离说明不能直接套用到新移植方案。新增组件的许可边界、构建分发及向网络用户提供对应源码等事项，需要按实际采用方式落实，不能仅增加一句“开源”声明。
- **保留 MED 来源模板仍需保留其来源和适用许可**，即便最终不再运行 MED 编辑器。核对 SVG、原模板 JS、字体和桥代码各自来源。
- 上述为工程交接事项，不是要求重新向用户确认是否允许复制；用户已经允许按开源协议复用。

许可来源：[根 LICENSE](https://github.com/YILING0013/novelai_local_web/blob/4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3/LICENSE)、[前端 LICENSE](https://github.com/YILING0013/novelai_local_web/blob/4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3/next_nai_web/LICENSE)、[Flask LICENSE](https://github.com/YILING0013/novelai_local_web/blob/4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3/nai_flask/LICENSE)。

## 4. 本项目必须保住的链路

### 4.1 六阶段流水线

`S1 正文 → S2 分页分格 → S3 逐格提示词 → S4 候选图和采用 → S5 整页图 → S6 PDF/CBZ`。

现有能力不能在更换编辑器时回退：

- 大纲模式先由 S1 LLM 扩写；已有正文模式直接分格，酒馆写作仍有独立入口。
- 一键任务 `auto_comic`、进度/SSE、错误弹窗、取消、中断续跑、已完成成果复用及人工修改检查点。
- 正负面预设项目优先/全局回退，可选择其他项目预设；提交时固定文本和 LoRA，续跑沿用原快照。
- ComfyUI 本机/云端、上传 JSON 工作流、`%prompt%` / `%negative%`、LoRA、每格参数、提示词版本固定。
- 候选比较、采用、上传、移除、下载；出图结果必须回到发起任务的原项目和原格。
- 总览实际漫画形态、版式预览、状态筛选、下一步页格定位。
- 编辑草稿保护、切项目与迟到响应保护、失败重试，以及配置“保存并返回一键生成”。

### 4.2 数据身份和版本

- `project_id` 是项目边界；`page:2`、`panel:2.3` 是业务身份，不是画布数组下标。
- `Artifact` 当前涉及 `prose`、`page_script`、`panel_prompt`、`image`、`med_doc`、`page_image`、`book`。
- 所有正式保存继续经过 `backend/app/artifacts.py` 创建新版本、建立 `ArtifactEdge`、使下游失效；不能直接覆盖旧图或原 JSON。
- `image.payload.selected_index` 与图片候选版本是采用结果的来源；不能只在浏览器偷偷换图。
- 生成图按候选 API 引用，服务端文件继续受 `backend/app/storage.py` 项目路径边界约束。
- `page_image` 是审核、总览和成册导出的关键产物。新编辑器只保存自己的项目包却不产生可审核整页图，不算适配完成。

### 4.3 代码入口

| 本地文件 | 现有职责 / 将来接入点 |
|---|---|
| `backend/static/ui/editor-workbench.js` | 页选择、编辑会话、iframe 桥、保存/脏状态、独立窗口；需要改为新组件宿主 |
| `backend/static/ui/editor_bridge/index.html`、`med_bridge.js` | MED 加载、模板、贴图、画布存档及消息桥 |
| `backend/app/med/base.py`、`composer.py` | 通过 Playwright 驱动 MED 的后台合成器 |
| `backend/app/stages/compose.py` | S5 自动拼页、输入完整性、取消检查、整页产物和血缘 |
| `backend/app/api/routes/pipeline.py` | 模板/分格、compose-board、MED 存档、预览、导出视图及一键提交/续跑 |
| `backend/app/api/routes/comfy.py` | 按原格提交生成；继续复用现有 ComfyUI 管线 |
| `backend/app/api/routes/artifacts.py` | 版本、审核、采用、候选图与文件下载 |
| `backend/app/overview.py` | 总览汇总；当前还会收集 `med_doc` |
| `backend/app/stages/auto_comic.py` | 连续编排，直接调用 S5 处理器；不能让新 S5 等待用户打开编辑页面 |
| `backend/app/stages/book.py`、`backend/static/ui/export-center.js` | 基于已选整页产物导出 PDF/CBZ 与历史下载 |
| `backend/app/main.py` | 当前挂载 `/editor` 和 `/ui`，最终清理 MED 入口时要同步 |
| `backend/app/models.py`、`artifacts.py`、`storage.py` | 数据模型、版本血缘和项目文件边界 |
| `backend/static/ui/app.js` | 页/格工作台与编辑器入口、配置返回及项目切换 |

常用现有接口（实施时逐项核对字段，保留旧调用兼容）：

```text
GET  /api/templates
GET  /api/templates/{template_id}/svg
POST /api/projects/{project_id}/pages/{page_ref}/template
POST /api/projects/{project_id}/pages/{page_ref}/script
GET  /api/projects/{project_id}/compose-board
GET/POST /api/projects/{project_id}/med-doc/{page_ref}
GET  /api/projects/{project_id}/image-board
PATCH /api/projects/{project_id}/panel-prompt/{panel_ref}
POST /api/projects/{project_id}/panels/{panel_ref}/generate
POST /api/artifacts/{artifact_id}/select
GET  /api/artifacts/{artifact_id}/candidate/{index}
POST /api/artifacts/{artifact_id}/review
POST /api/projects/{project_id}/run/S5
POST /api/projects/{project_id}/auto-comic
POST /api/projects/{project_id}/auto-comic/resume
GET  /api/jobs/events?project_id=...
```

## 5. 保留现有模板的关键要求

本次只读核对当前 `/api/templates`：**69 个模板，竖版 41、横版 28**。以后以实际数据库和 SVG 为准，不凭数量重新生成一套模板。

- `Template` 保存 `id / dir / panels_count / layout_desc / svg_path / geometry`；S2 页脚本也保存 `template_id` 和几何快照。
- 原模板来源由 `backend/scripts/fetch_editor.*`、`parse_med_templates.mjs`、`build_template_menu.py` 管理。
- 当前第三方说明记录的 MED 来源提交是 `04e0cf3de1f3677682f6d1831f2713db70e441ba`。
- 当前 `geometry.panels` 主要是百分比外接矩形；**并不足以还原斜切 polygon 的完整顶点**。原 SVG 仍然重要。
- 新适配器需要读取原 SVG 的实际多边形、变换矩阵、画布和裁剪，保留真实外形、空隙、遮盖与边框；不能把所有格子矩形化。
- SVG 中的对象顺序不一定等于业务阅读顺序。现桥调用 MED 的 `sortPanelsInReadingOrder`；迁移时必须建立并验证 `template polygon ↔ panel_order ↔ panel_ref` 对应关系。
- 将模板 SVG 和必要元数据独立保存到受管理模板资源中，使最终系统不必依赖整个 `backend/static/editor/` 才能找到模板；保留 ID、快照与许可来源。
- 禁用/替换参考组件所有默认选模板入口，不只是把模板按钮藏起来。新建页、导入、恢复草稿、跨页和推荐模板也不能偷偷套用上游内置模板。
- 若允许用户手工切割/增删画框，须另行维护稳定元素 ID 与业务格绑定；不要通过重排数组让现有 `panel:页.格` 静默指向另一张图。

## 6. 建议迁移架构（待实现，不是现有接口）

### 6.1 小范围移植组件，保留主项目

建议将参考编辑器核心作为单独构建的 React 组件区嵌入现有编辑页，由原生前端负责项目、页选择和保存状态。复用上游代码和适用依赖，替换其 i18n、网络、图库、模板和存储适配。

参考前端本身依赖 Next/React/MUI，当前项目没有这套构建链。优先建立独立、锁版本的静态 bundle，后端继续同源提供；避免为了一个编辑器全面改写现有站点或引入必须常驻的第二套服务器。具体构建方案在验证依赖后确定，不在交接中虚报已可直接运行。

不引入上游 NovelAI 登录、Anlas、模型限制及其 Flask 服务来替换本项目 ComfyUI；已有一键编排、供应商和预设保持权威来源。

### 6.2 编辑文档与后端存储

新文档需要有独立格式版本和编辑器标识，建议引入通用 `editor_doc`，而不是把新 JSON 冒充 Fabric/MED 文档。具体字段与数据库迁移方式由实施批次确定。

至少保存：项目/页身份、基于的分格版本、模板 ID 与几何快照、画布尺寸、元素稳定 ID、业务格绑定、图片产物版本/候选引用、图片变换与裁剪、图层、手动文字/气泡/笔画、字体资源引用、schemaVersion。

建议接口方向：按项目和页读取/保存编辑文档，保存带基准版本的文档与 PNG 预览，返回新文档/整页产物 ID 和版本。**这些通用编辑文档接口目前不存在，需新建并测试。**

服务端是正式存档来源；浏览器存储只用于草稿缓存和崩溃恢复。不能直接照搬上游 IndexedDB 为唯一正式数据源，否则换浏览器、端口或电脑后项目会像丢失一样。

### 6.3 统一渲染与后台 S5

优先复用同一套页面渲染核心给手动预览、PNG 保存与后台拼页，避免两套裁剪/图层算法出现偏差。

S5 必须在用户没打开编辑器时也能生成整页；可继续用 Playwright 驱动一个本项目自己的纯渲染页面，但不能再启动 MED 或依赖 MED 全局对象。换成其他服务端渲染方式也要达到相同几何与导出效果。

后台的默认输入仅为版式与已采用图片；手工图层只在明确的编辑文档保存/导出路径中处理。保存新文档与新 `page_image` 时维持版本、审核及血缘，失败或取消不发布不完整成品。

### 6.4 老 MED 文档兼容

旧 `med_doc.payload.doc` 是 MED/Fabric 画布 JSON，不等于参考项目的新页面格式。

- 保留全部旧 JSON、图片、产物与历史版本；迁移写新版本和来源关联，不原地覆盖。
- 分别调查画框、贴图/裁剪、图层、气泡、文字、字体、旋转/变换与组合对象的转换能力。
- 不能把旧整页 PNG 当一张背景图导入，就宣称旧项目已完整可编辑；这只能算视觉回退。
- 无法转换的元素须明确列出，不得悄悄丢掉；转换器和兼容读取方案覆盖之前，阶段性保留旧入口作回滚。
- 最终移除 MED 运行依赖前，必须满足约定旧样本的可读、可编辑、保存重开和导出兼容；尚有依赖 MED 才能打开的存档时，不能宣布“已经去掉 MED”。

## 7. 功能适配和验收优先级

下表是本项目的实施目标；具体能从上游直接复用多少，应以源码调查与验证为准。

| 优先级 | 功能 | 本项目适配验收 |
|---|---|---|
| P0 | 同页选页、自动贴图、保存重开 | 从总览/合成页进入对应项目页，切页不串图，刷新读回正式存档 |
| P0 | MED 模板与裁剪 | 现有模板形状和阅读顺序正确；斜格、跨格、重叠格不被矩形化 |
| P0 | 图片拖动/缩放/裁切 | 以采用图版本为基础编辑构图，参数保存后重开一致 |
| P0 | 统一渲染 | 无浏览器交互的一键 S5 可拼页，输出可审核和 PDF/CBZ 导出 |
| P0 | 版本和历史兼容 | 旧文档不丢失，修改使下游 stale，旧图与旧导出可继续下载 |
| P1 | 图层、元素变换 | 显隐、锁定、顺序、选择与移动不改变业务格身份 |
| P1 | 手动气泡、文字、贴纸、字体 | 仅主动添加；文档、预览与导出一致，字体资源可找回 |
| P1 | 撤销重做、快捷键、缩放平移 | 输入框/弹窗不被快捷键抢占，手机可操作 |
| P1 | 逐格参数、图库和生成 | 接本项目 PN/预设/LoRA 与任务 API；结果回原格，删除原格后仍保留候选 |
| P1 | 可编辑项目包 | 导出再导入可继续编辑；资源完整，导入为副本，避免覆盖其他项目 |
| P2 | 自由切割、叠加框、笔画等 | 接入格绑定与失效规则后逐项启用，不能破坏已有图格对应 |
| P2 | 上游额外 AI 漫画工具 | 与现有编排有价值的部分再接入，不额外复制一套生成队列和账号配置 |

不能把 P0/P1 中的气泡和文字编辑误解成“一键自动加字”；当前默认拼页不加这些内容的要求继续有效。

## 8. 分批落地建议

| 批次 | 可交付结果 | 本批完成条件 |
|---|---|---|
| M0 调查与移植基线 | 固定上游提交、许可/依赖来源清单、旧存档样本、模板快照 | 明确可复用模块和适配边界，不动真实历史数据 |
| M1 独立编辑组件 | 同页打开新编辑画布，读本项目模板和候选图 | 真正使用新组件；现有其他工作台正常；编辑器仍可按开关回退 |
| M2 模板与渲染核心 | 69 个原模板映射、新渲染输出 | 几何、阅读顺序、图片裁剪与手动/后台输出一致 |
| M3 存档与旧文档 | 通用文档 API、版本血缘、MED 转换/兼容 | 保存/重开/旧样本兼容、并发冲突和路径边界通过 |
| M4 手工编辑工具 | 图层、构图、文字/气泡、撤销与快捷键 | 每个工具与保存、导出和触摸操作一起验收 |
| M5 工作流整合 | 逐格参数、预设、候选与本项目生成任务衔接 | 固定原格、保存失败保护、取消和切项目无竞态 |
| M6 去 MED 收尾 | S5、新编辑器、旧数据、构建与文档全链路 | 清理运行依赖和旧主入口，保留模板来源、历史资料与必要兼容 API |

每批：说明改动 → 实现 → 适当回归/视觉检查 → 本地 Git 提交 → 更新清单。不要将所有批次堆成一个难以回滚的大提交。

## 9. 验证和保护清单

至少覆盖：

1. 现有模板清单 ID、方向、格数不变；所有模板加载和基本渲染检查，斜切/重叠/整页大格等代表模板做图像对照。
2. 从正文到成册、总览预览、S5 自动拼页和旧 PDF/CBZ 下载无回退。
3. 旧 MED 文档样本迁入后编辑、保存、重开和导出；列出不支持类型及处理进度。
4. 正负面预设、LoRA 的 0 和独立 CLIP 权重、逐格尺寸/采样/种子、上传工作流占位符保持。
5. 图像引用保留原产物版本；采用/编辑/重生成后相关下游失效，历史文件不覆盖。
6. 生成时切格/切项目、原格删除、迟到响应、保存中新输入、网络失败重试、任务取消及一键续跑。
7. 切页、切项目、关闭和刷新时的未保存保护；切菜单后画布保留。
8. 项目存储边界、导入路径穿越、外部资源引用、字体/图片缺失与损坏文档；不能从前端提交任意本机文件路径。
9. 1440 / 768 / 390px：画布、工具栏、元素编辑、弹窗和保存入口可用，无横向页面溢出和控制台错误。
10. 新安装和构建：不安装 MED 时也能选现有模板、编辑、后台合成和导出。Playwright 如仍用于新渲染和酒馆桥，应保留正确安装说明。

已有可复用回归入口：

```powershell
.venv/Scripts/python.exe tests/test_auto_comic.py
.venv/Scripts/python.exe tests/test_configuration.py
.venv/Scripts/python.exe tests/test_data_safety.py
.venv/Scripts/python.exe tests/test_prompt_page_refs.py
.venv/Scripts/python.exe tests/test_storage_safety.py
```

本环境没有安装 pytest；上面是当前 unittest 脚本入口。`tests/test_editor_workbench.py` 是浏览器整链路脚本，`tests/test_med_bridge.py` 面向现桥，需先读其环境和副作用再选择运行；新编辑器实现后要迁移相应检查，不能靠删掉旧测试取得“通过”。

最近一次已完成回归是预设/编排 12 项、配置 6 项、数据安全 29 项及浏览器配置返回查看；**不是新编辑器的验证结果**。本交接编写没有跑新生成、没有导入上游代码，也没有执行迁移。

## 10. 数据、服务与操作注意

- 使用 UTF-8。不要输出 `.env`、供应商 Key、酒馆密钥或云端凭据。
- `data/`、配置、工作流、日志、模型和 MED vendor 大多不入 Git；提交代码不等于备份这些数据。迁移前需要可恢复的数据与模板备份。
- 不把真实应用启动当作无副作用的语法检查：启动有初始化、历史回填和中断任务处理。回归用临时数据库、配置和模拟外部服务。
- 真实服务此前已按用户要求启动。新对话先探测端口和任务，不重复启动或按进程名清理所有 Python/浏览器。
- 如必须重启，核对实际端口、命令行与父子进程，仅管理本项目服务；有活动项目任务时先处理其状态。不要误停其他项目。
- 当前一键运行针对单进程服务设计；不要把编辑器迁移顺便当成多实例队列改造。
- 本机 Git 可能提示 safe.directory，当前命令习惯：

```powershell
git -c safe.directory=E:/GeneralApp/zcodefile/.zcode/workspace/default/comic-pipeline status --short --branch
```

提交用明确文件列表。需要 `.git` 写权限时按现有工具权限流程操作，不修改全局安全配置来绕过限制。

## 11. 可直接粘贴到新对话的接手指令

```text
请先阅读 docs/漫画编辑器替换MED-新对话交接.md 和当前 Git 状态，然后按文档实施。

目标：直接复用和修改 YILING0013/novelai_local_web 的实用漫画编辑代码，按开源协议处理好来源、版权和许可，最终替换本项目 MED；漫画编辑在本项目页面内完成。

强制要求：
1. 使用本项目现有 MED 来源的 69 个分页分格模板，不换成参考项目自带模板；保留实际 SVG 形状、阅读顺序与稳定模板 ID。
2. 兼容所有现有项目、版本产物、旧 MED 存档、图层/文字编辑、候选图、正负面预设和 LoRA、工作流、审核、失效传播、总览、一键生成/续跑、PDF/CBZ 导出和保存保护。
3. 默认自动拼页只把图片拼入格子，不自动加线、字或装饰。
4. 手动编辑与后台 S5 自动拼页都要替换；不依赖用户开着页面才能合成。
5. 已允许直接复制上游代码，不需要再次询问是否能复制；按实际文件许可完成合规移植。
6. 分批实现、验证、提交本地 Git；保持 dev-adachi 工作，不自行合并 main 或推送。
7. 先做来源/依赖、模板几何和旧存档兼容调查，再落地独立编辑器与适配层；不要只替换外观或丢弃旧数据。

已有完整交接与源码路径，请先自行阅读并推进；每批完成更新清单并说明验证范围。
```
