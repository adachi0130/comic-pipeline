"""常驻酒馆桥：用后台无头浏览器开着一个酒馆页面，让 comic-bridge 扩展一直活着。

为什么需要它：SillyTavern 扩展只运行在浏览器标签页里（角色卡/世界书/prompt 组装都在
前端）。所以“不开酒馆也能用”= 我们替你把酒馆页面开在一个隐藏的浏览器里常驻。

它做的事，就是替你保持一个酒馆标签页：
- 扩展会持续把「对话列表 / 当前对话 / 生成依据」推给后端；
- 后端入队的写作任务会被这个后台标签页领取并生成。

用法：
    .venv/Scripts/python.exe tools/tavern_bridge.py            # 前台运行
    .venv/Scripts/python.exe tools/tavern_bridge.py --headless # 默认就是无头

停止：Ctrl+C（或结束该进程）。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

DEFAULT_TAVERN = "http://127.0.0.1:8000"



def _tavern_chats_root() -> Path | None:
    """定位酒馆的 chats 目录（SillyTavern < 版本 > /data/default-user/chats）。"""
    import glob as _glob
    for base in ("E:/jiuguan", "E:/", str(Path.home())):
        for root in _glob.glob(f"{base}/*SillyTavern*"):
            sub = _glob.glob(f"{root}/SillyTavern-*")
            for st in sub:
                d = Path(st) / "data" / "default-user" / "chats"
                if d.is_dir():
                    return d
    return None


def clean_empty_chats(verbose: bool = True) -> int:
    """删除“空会话”文件（只有 1 行元数据、没有消息）。

    背景：酒馆在切换角色时可能自动新建 `<角色名> - 时间戳.jsonl` 的空会话，
    这些空文件会干扰“最新会话”的判断。它们没有任何内容，删除是安全的。
    """
    root = _tavern_chats_root()
    if root is None:
        return 0
    n = 0
    for f in root.rglob("*.jsonl"):
        try:
            lines = [l for l in f.read_text(encoding="utf-8", errors="ignore").splitlines() if l.strip()]
        except OSError:
            continue
        if len(lines) <= 1:           # 只有元数据行 -> 空会话
            try:
                f.unlink()
                n += 1
                if verbose:
                    print(f"  [清理空会话] {f.parent.name}/{f.name}")
            except OSError:
                pass
    return n

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tavern", default=DEFAULT_TAVERN, help="酒馆地址")
    ap.add_argument("--headful", action="store_true", help="显示浏览器窗口（调试用）")
    ap.add_argument("--check-interval", type=float, default=20.0, help="健康检查间隔（秒）")
    args = ap.parse_args()

    print("清理空会话：")
    n = clean_empty_chats()
    print(f"  清理 {n} 个" if n else "  无")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headful)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.on("console", lambda m: print(f"[酒馆页] {m.type}: {m.text[:120]}", flush=True)
                if ("comic-bridge" in m.text or m.type == "error") else None)

        while True:
            try:
                print(f"打开酒馆：{args.tavern}", flush=True)
                page.goto(args.tavern, wait_until="load", timeout=60000)
                page.wait_for_timeout(8000)  # 等扩展脚本加载
                # 自动启用 comic-bridge 扩展（酒馆退出时会把设置写回 false，故每次启动都确保打开）
                state = page.evaluate(
                    """() => {
                        const ctx = window.SillyTavern?.getContext?.();
                        if (!ctx) return null;
                        ctx.extensionSettings.comicBridge = ctx.extensionSettings.comicBridge || {};
                        const s = ctx.extensionSettings.comicBridge;
                        s.enabled = true;
                        s.backend = s.backend || 'http://127.0.0.1:8770';
                        ctx.saveSettingsDebounced?.();
                        // 同步勾上界面开关，触发扩展内部的轮询/镜像循环
                        const cb = document.querySelector('#cb-enabled');
                        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
                        return s;
                    }"""
                )
                if state and state.get("enabled"):
                    print(f"扩展已启用（backend={state.get('backend')}），开始常驻", flush=True)
                else:
                    print("未检测到扩展设置，可能酒馆未就绪；稍后重试", flush=True)

                # 常驻：定期检查页面是否还活着
                while True:
                    time.sleep(args.check_interval)
                    try:
                        page.evaluate("() => 1")  # 页面失联会抛错
                    except Exception as e:  # noqa: BLE001
                        print(f"页面失联，准备重开：{e}", flush=True)
                        break
            except KeyboardInterrupt:
                print("已停止", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"打开酒馆失败（{e}），10 秒后重试", flush=True)
                time.sleep(10)

        try:
            browser.close()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
