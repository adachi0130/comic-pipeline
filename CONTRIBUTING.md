# 参与开发（CONTRIBUTING）

感谢你愿意帮忙喵～ 本文说明本地环境、代码约定与提交流程。

## 一、开发环境

按 [README 的「5 步跑起来」](README.md#5-步跑起来克隆--打开前端) 搭好环境即可。
关键点：

- Python 3.11–3.13，用项目根的 `.venv`。
- 跑 `tests/test_med_bridge.py` 需要先 `fetch_editor.*` 拉取 MED。
- 出图需要可访问的 ComfyUI；正文需要 SillyTavern——**不做这两块也能开发大部分代码**。

## 二、目录与职责

| 目录 | 负责什么 |
|---|---|
| `backend/app/` | 后端主体：模型、配置、artifacts 版本化、LLM 客户端、ComfyUI 客户端、阶段处理器、REST + SSE |
| `backend/app/stages/` | S1..S7 各阶段的作业处理器 |
| `backend/app/med/` | `PageComposer` 抽象 + MED 适配器（**第三方交互都收在这一层**） |
| `backend/prompts/` | 版本化的阶段提示词资产（S1/S3/S4） |
| `backend/scripts/` | 一次性/运维脚本：拉 MED、生成模板菜单、灌技法库、无头自动驾驶 |
| `backend/static/ui/` | 自研前端 + `editor_bridge/`（MED 驱动桥） |
| `extensions/comic-bridge/` | SillyTavern 扩展 |
| `tests/` | 离线自测 |
| `tools/` | 本地启动脚本 |

## 三、代码约定

- **提示词不要硬编码进代码**：放 `backend/prompts/*.md`，代码只做渲染。
- **换出图工作流不改代码**：改 `config/workflow_params.yaml`（参数映射表）。
- **MED 的调用只出现在 `backend/app/med/` 与 `editor_bridge/`**：其它地方不得直接碰 MED 内部函数。
- 注释写"为什么"，不写"做了什么"；面向的是未来的读者。
- 保持每个改动能独立回滚。

## 四、提交前自测

```bash
.venv/Scripts/python.exe tests/test_workflow_mapping.py
.venv/Scripts/python.exe tests/test_artifacts.py
# 改了 MED 桥或升级 MED 后必须跑：
.venv/Scripts/python.exe tests/test_med_bridge.py
```

## 五、提交与 PR

- 提交信息用 **Conventional Commits**，中文标题：
  `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `test:`，例：`fix(分页合成): 换模板后记住当前页`。
- 一个提交只做一件事，方便回滚。
- **不要提交**：`data/`、`*.db`、`config/comfy.yaml`、`config/workflow_params.yaml`、`config/workflows/*.json`、
  `backend/static/editor/`、`.env`、密钥、模型/LoRA 大文件（`.gitignore` 已排除，请勿用 `-f` 强行加入）。
- 提 PR 时说明：改了什么、为什么、怎么验证的。

## 六、许可证

- 本项目自研部分：以根目录 `LICENSE` 为准（**当前尚未定稿，待项目所有者选定后补齐**）。
- **`backend/static/ui/editor_bridge/` 下的桥代码按 GPL-3.0 对待**（它与 MED 紧耦合、调用其内部函数）。
  改动这块请知悉其传染性。
- 第三方组件与边界说明详见 `THIRD_PARTY_NOTICES.md`。
