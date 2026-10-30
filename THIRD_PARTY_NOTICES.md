# 第三方组件说明（THIRD PARTY NOTICES）

本文件列出本项目使用/依赖的第三方组件及其许可证，供分发与协作时参考。

---

## 0. novelai_local_web（漫画编辑器来源）

- **项目**：YILING0013/novelai_local_web
- **上游**：https://github.com/YILING0013/novelai_local_web
- **许可证**：**AGPL-3.0**（根目录与 `next_nai_web/LICENSE` 均为 AGPL-3.0）
- **移植基线提交**：`4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3`
- **随本仓库分发**：是。代码在 `backend/static/ui/editor/`（前端模块）与
  `backend/app/comic/`（按上游算法重写的后端渲染）。
- **许可文本**：`backend/static/ui/editor/licenses/AGPL-3.0.txt`
- **逐文件来源与改动**：`docs/漫画编辑器移植来源清单.md`

### 分发注意

- 上述文件按 **AGPL-3.0** 使用，不是 MIT/BSD。保留文件头的 SPDX 标识与来源注释，不得删除。
- AGPL-3.0 第 13 条：通过网络向用户提供本服务时，须向使用者提供获取对应源码的方式。
  本仓库即源码；若要分发二进制或镜像，须一并提供源码与许可文本。

---

## 1. Manga Editor Desu（**仅模板来源，运行依赖已移除**）

- **项目**：Manga Editor Desu!（作者 **new-sankaku**）
- **上游**：https://github.com/new-sankaku/manga-editor-desu
- **许可证**：**GPL-3.0**（GNU General Public License v3.0）
- **本项目锁定版本**：commit `04e0cf3de1f3677682f6d1831f2713db70e441ba`（2026-08-30）

### 现状：不再运行 MED

漫画编辑与分页合成已改为本项目自研实现（`backend/app/comic/` 渲染核心 +
`backend/static/ui/editor/` 编辑器），**S5 自动拼页与手动编辑都不再启动 MED**，
也不再需要 `backend/static/editor/` 才能工作。

仍然保留的是 MED 的**版式模板 SVG**：69 个模板（竖版 41、横版 28）已导出到
`data/templates/`，由 `backend/app/comic/template_geometry.py` 解析真实多边形与阅读顺序。
这些模板文件来自 MED，**GPL-3.0 许可继续适用**，其来源与许可不得移除。

- 模板获取与解析脚本：`backend/scripts/fetch_editor.*`、`parse_med_templates.mjs`、`build_template_menu.py`
- 历史存档兼容：旧 `med_doc`（fabric JSON）仍可读取并转换为新文档（`backend/app/comic/legacy.py`）；
  无法转换的元素会列在转换摘要里；当前旧组合对象等尚未完整兼容，不能视为历史存档已全部迁移，见 `docs/漫画编辑器验收记录-2026-10-30.md`。

### 分发注意

- 只分发本项目自研代码 + `data/templates/` 里的模板 SVG 时，模板部分按 GPL-3.0 处理。
- 旧的桥代码 `backend/static/ui/editor_bridge/` 与 `backend/app/med/` 属于历史兼容层，
  按 GPL-3.0 对待（`med_bridge.js` 内含 SPDX 标识）。新流程不依赖它们。

---

## 2. 运行期依赖（Python）

见 `requirements.txt`。主要项：FastAPI、uvicorn、SQLAlchemy、Alembic、pydantic、httpx、
APScheduler、Paramiko、PyYAML、Jinja2、img2pdf、Playwright、Pillow。
各自遵循其开源许可证（多为 MIT / BSD / Apache-2.0 系）。

> 说明：Playwright 现在只用于**酒馆常驻桥**（`tools/tavern_bridge.py`）；
> MED 合成桥已不再需要无头浏览器。

## 3. 外部服务（不由本仓库分发）

- **SillyTavern**（https://github.com/SillyTavern/SillyTavern ）—— 用于正文生成，按它自己的许可使用。
- **ComfyUI**（https://github.com/comfyanonymous/ComfyUI ）—— 出图后端，按它自己的许可使用。
