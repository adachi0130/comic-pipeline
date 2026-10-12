# 第三方组件说明（THIRD PARTY NOTICES）

本文件列出本项目使用/依赖的第三方组件及其许可证，供分发与协作时参考。

---

## 1. Manga Editor Desu（分页合成/精修工作台）

- **项目**：Manga Editor Desu!（作者 **new-sankaku**）
- **上游**：https://github.com/new-sankaku/manga-editor-desu
- **许可证**：**GPL-3.0**（GNU General Public License v3.0）
- **本项目锁定版本**：commit `04e0cf3de1f3677682f6d1831f2713db70e441ba`（2026-08-30）
- **获取方式**：**不随本仓库分发**。使用者运行 `backend/scripts/fetch_editor.*` 从上游按上述 commit 拉取到
  `backend/static/editor/`（该目录已加入 `.gitignore`）。

### 本项目与 MED 的边界

- MED 没有官方自动化 API（无 postMessage / 无 URL 参数 / 无全局导出对象）。
- 本项目通过**同源 iframe + 注入桥脚本**（`backend/static/ui/editor_bridge/med_bridge.js`）调用
  MED 的顶层内部函数来驱动它。
- 该桥脚本与 MED 的全局作用域紧耦合、直接调用其内部函数，因此
  **`backend/static/ui/editor_bridge/` 下的代码按 GPL-3.0 对待**（`med_bridge.js` 内含 SPDX 标识）。
- 本仓库其余自研代码与 MED 保持隔离。

### 分发注意（重要）

- 只要**不把 MED 本体打包进你的分发物**，本仓库的自研部分不因 MED 而承担 GPL 分发义务。
- 若你把 MED 一起分发（打进压缩包 / 放进仓库），则须遵守 GPL-3.0：
  保留版权声明与 LICENSE、标注修改、提供完整对应源码等。MED 自带的 `third/` 目录下
  （Fabric.js、three.js、pixi、jszip、localforage 等）与字体还有各自的许可证，也需一并保留。

---

## 2. 运行期依赖（Python）

见 `requirements.txt`。主要项：FastAPI、uvicorn、SQLAlchemy、Alembic、pydantic、httpx、
APScheduler、Paramiko、PyYAML、Jinja2、img2pdf、Playwright、Pillow。
各自遵循其开源许可证（多为 MIT / BSD / Apache-2.0 系）。

## 3. 外部服务（不由本仓库分发）

- **SillyTavern**（https://github.com/SillyTavern/SillyTavern ）—— 用于正文生成，按它自己的许可使用。
- **ComfyUI**（https://github.com/comfyanonymous/ComfyUI ）—— 出图后端，按它自己的许可使用。
