# Manga Editor Desu! —— vendor 版本锁定

本项目的分页合成/精修工作台使用开源项目 **Manga Editor Desu!**（作者 new-sankaku），
按下面的 commit 锁定版本，通过 `backend/scripts/fetch_editor.ps1` 或 `fetch_editor.sh`
拉取到 `backend/static/editor/`（**不入 git**，因为含约 99MB 字体与素材）。

- 仓库：https://github.com/new-sankaku/manga-editor-desu
- 许可证：GPL-3.0（本项目自研代码与 MED 隔离；MED 以其原始许可使用）
- 锁定 commit：`04e0cf3de1f3677682f6d1831f2713db70e441ba`
- 该 commit 日期：2026-08-30
- 说明：MED 没有官方自动化 API（无 postMessage / 无 URL 参数 / 无全局导出对象），
  本项目通过**同源 iframe + 注入桥脚本**调用其全局内部函数驱动它；
  内部函数无版本保证，故升级前必须跑桥的冒烟测试（`tests/` 内）。

## 为什么锁版本

MED 的全局函数（`loadSVGPlusReset` / `getPanelObjectList` / `sortPanelsInReadingOrder` /
`promptApplyToOrderedPanels` / `putImageInFrame` / `ImageUtil.canvas2DataURL` 等）属于内部接口，
升级可能改名或改签名。锁定版本 + 桥只依赖这几个函数 + 冒烟测试，是控制风险的三件套。

## 升级步骤

1. 改 `fetch_editor.*` 里的 `COMMIT` 为新 commit；
2. 重新拉取；
3. 跑 `node backend/static/editor_bridge/smoke.mjs`（无头验证桥函数仍存在）；
4. 通过后更新本文件的锁定 commit 与日期。
