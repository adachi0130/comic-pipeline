"""Manga Editor Desu 适配器：用 Playwright 驱动同源 iframe 里的 MED。

原理：MED 是纯静态 PWA，无自动化 API。我们用无头 Chromium 打开 ``/editor/``，
把 ``med_bridge.js``（同源、运行在 MED 全局作用域）注入进去，得到 ``window.__MED``
门面，再由本适配器调用它完成：装模板 → 落提示词 → 贴图 → 加技法 → 导出 PNG。

无头模式需要预置浏览器存储（MED 的 ComfyUI 地址 / 导入的工作流在 localStorage /
IndexedDB 里）。M0 我们只用它做“装模板 + 贴图 + 导出”，不依赖 MED 自己出图，
因此无需预置任何存储；那部分留到 M2 的自动驾驶。
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path

from .base import ComposeResult, PanelArt, ToneOp


class MedComposerError(RuntimeError):
    pass


def _data_url(png_path: str) -> str:
    p = Path(png_path)
    if not p.exists():
        raise MedComposerError(f"成图不存在：{png_path}")
    b = p.read_bytes()
    ext = p.suffix.lower().lstrip(".") or "png"
    return f"data:image/{'jpeg' if ext in ('jpg', 'jpeg') else ext};base64," + base64.b64encode(b).decode("ascii")


class MedComposer:
    """Playwright 驱动的 MED 分页合成器。"""

    def __init__(
        self,
        base_url: str,
        *,
        editor_path: str = "/editor/",
        bridge_path: str = "/ui/editor_bridge/med_bridge.js",
        headless: bool = True,
        user_data_dir: str | None = None,
        timeout_ms: int = 30000,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.editor_url = self.base_url + editor_path
        self.bridge_url = self.base_url + bridge_path
        self.headless = headless
        self.user_data_dir = user_data_dir
        self.timeout_ms = timeout_ms
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._bridge_src: str | None = None

    # ---------------- 生命周期 ----------------
    def open(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:  # pragma: no cover
            raise MedComposerError(
                "未安装 playwright。安装：pip install playwright && playwright install chromium"
            ) from e

        self._pw = sync_playwright().start()
        launch_kwargs: dict = {"headless": self.headless}
        if self.user_data_dir:
            self._context = self._pw.chromium.launch_persistent_context(
                self.user_data_dir, **launch_kwargs
            )
            self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
        else:
            self._browser = self._pw.chromium.launch(**launch_kwargs)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()
        self._page.set_default_timeout(self.timeout_ms)

        self._page.goto(self.editor_url, wait_until="load")
        # 等 MED 的 canvas 出现（脚本都 defer，load 后即可）
        self._page.wait_for_function("() => typeof window.canvas !== 'undefined'", timeout=self.timeout_ms)

        # 取桥源码并注入到 MED 文档作用域
        self._bridge_src = self._page.evaluate(
            "async (u) => { const r = await fetch(u); return await r.text(); }", self.bridge_url
        )
        self._page.evaluate("(src) => { const s = document.createElement('script'); s.textContent = src; document.body.appendChild(s); }", self._bridge_src)
        self._page.wait_for_function("() => !!window.__MED")
        ready = self._page.evaluate("() => window.__MED.ready()")
        if not ready.get("ok"):
            raise MedComposerError(f"桥不可用，缺失全局：{ready.get('missing')}")

    def close(self) -> None:
        for closer in (self._context, self._browser):
            try:
                if closer:
                    closer.close()
            except Exception:  # noqa: BLE001
                pass
        if self._pw:
            try:
                self._pw.stop()
            except Exception:  # noqa: BLE001
                pass
        self._pw = self._browser = self._context = self._page = None

    def __enter__(self) -> "MedComposer":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------------- 操作 ----------------
    def install_template(self, svg: str, is_landscape: bool) -> int:
        res = self._page.evaluate(
            "async ({svg, isLand}) => await window.__MED.installTemplate(svg, isLand)",
            {"svg": svg, "isLand": is_landscape},
        )
        return int(res.get("panels", 0))

    def reading_order(self, right_to_left: bool = True) -> list[dict]:
        return self._page.evaluate("(rtl) => window.__MED.readingOrder(rtl)", right_to_left)

    def apply_prompts(self, prompts: list[str], *, right_to_left: bool = True) -> int:
        res = self._page.evaluate(
            "({p, rtl}) => window.__MED.applyPrompts(p, {rightToLeft: rtl, append: false})",
            {"p": prompts, "rtl": right_to_left},
        )
        return int(res.get("applied", 0))

    def place_image(self, order: int, image_path: str, *, right_to_left: bool = True) -> None:
        self._page.evaluate(
            "async ({o, url, rtl}) => await window.__MED.placeImage(o, url, {rightToLeft: rtl})",
            {"o": order, "url": _data_url(image_path), "rtl": right_to_left},
        )

    def add_tone(self, op: ToneOp) -> dict:
        return self._page.evaluate(
            "({kind, opts}) => window.__MED.addTone(kind, opts)",
            {"kind": op.kind, "opts": {**op.options, "panel_order": op.panel_order, "rightToLeft": True}},
        )

    def export_png_dataurl(self, multiplier: int = 1) -> str:
        return self._page.evaluate("(m) => window.__MED.exportPNG(m)", multiplier)

    # ---------------- 组合 ----------------
    def compose(
        self,
        *,
        template_svg: str,
        is_landscape: bool,
        prompts: list[str],
        arts: list[PanelArt],
        tones: list[ToneOp] | None = None,
        right_to_left: bool = True,
        multiplier: int = 1,
    ) -> ComposeResult:
        warnings: list[str] = []
        try:
            n = self.install_template(template_svg, is_landscape)
            if n == 0:
                return ComposeResult(ok=False, error="装模板后未检测到分镜框")
            if len(prompts) != n:
                warnings.append(f"提示词 {len(prompts)} 条与格数 {n} 不一致")

            applied = self.apply_prompts(prompts, right_to_left=right_to_left)

            placed = 0
            for art in arts:
                try:
                    self.place_image(art.order, art.image_path, right_to_left=right_to_left)
                    placed += 1
                except Exception as e:  # noqa: BLE001
                    warnings.append(f"贴图失败 order={art.order}：{e}")

            for op in tones or []:
                r = self.add_tone(op)
                if not r.get("ok"):
                    warnings.append(f"技法 {op.kind} 未叠加：{r.get('error')}")

            dataurl = self.export_png_dataurl(multiplier)
            png = _decode_dataurl(dataurl)
            return ComposeResult(
                ok=True,
                png_path="",  # 由调用方决定落盘位置
                panels=n,
                applied_prompts=applied,
                placed=placed,
                warnings=warnings,
            ), png  # type: ignore[return-value]
        except Exception as e:  # noqa: BLE001
            return ComposeResult(ok=False, error=str(e), warnings=warnings)


def _decode_dataurl(dataurl: str) -> bytes:
    if not dataurl.startswith("data:"):
        raise MedComposerError("导出结果不是 dataURL")
    _, _, b64 = dataurl.partition(",")
    try:
        return base64.b64decode(b64)
    except (binascii.Error, ValueError) as e:
        raise MedComposerError(f"dataURL 解码失败：{e}") from e
