"""启动后端 + 常驻酒馆桥，仅管理本次启动取得的子进程句柄。

用法：
    .venv/Scripts/python.exe tools/start_all.py            # 后端 + 桥
    .venv/Scripts/python.exe tools/start_all.py --no-bridge # 只起后端
    Ctrl+C 停止本次启动的子进程；已有进程请在其原终端停止。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
PY = str(VENV_PY if VENV_PY.exists() else sys.executable)

def kill_existing(verbose: bool = True) -> int:
    """保留旧调用名，禁止按名称或 PID 扫描结束进程。"""
    if verbose:
        print("自动清理已有进程已禁用；请在原启动终端停止。")
    return 0


def kill_orphan_browsers(verbose: bool = True) -> int:
    """保留旧调用名，禁止全局清理浏览器。"""
    if verbose:
        print("自动清理浏览器已禁用。")
    return 0


def stop_owned(procs: list[subprocess.Popen]) -> None:
    """仅操作本次 Popen 返回的句柄，避免名称匹配及 PID 重用误伤。"""
    for proc in reversed(procs):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def start_backend() -> subprocess.Popen:
    print("启动后端 http://127.0.0.1:8770 ...")
    return subprocess.Popen(
        [PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8770",
         "--log-level", "warning"],
        cwd=str(ROOT / "backend"),
    )


def start_bridge() -> subprocess.Popen:
    print("启动常驻酒馆桥（无头浏览器）...")
    return subprocess.Popen([PY, "tools/tavern_bridge.py"], cwd=str(ROOT))


def wait_backend(timeout_s: float = 30.0) -> bool:
    import urllib.request

    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8770/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.8)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop", action="store_true", help="提示如何停止已有进程（自动清理已禁用）")
    ap.add_argument("--no-bridge", action="store_true", help="不启动酒馆桥")
    args = ap.parse_args()

    if args.stop:
        print("自动清理已禁用。请回到原启动终端按 Ctrl+C 停止。")
        return 2
    if wait_backend(timeout_s=0.1):
        print("已有后端占用 :8770；请在原启动终端管理，当前启动已退出。")
        return 1
    procs = []
    try:
        procs.append(start_backend())
        if not wait_backend() or procs[0].poll() is not None:
            print("后端启动失败或超时，请检查日志。")
            return 1
        print("后端就绪 ✓")
        if not args.no_bridge:
            procs.append(start_bridge())
            print("桥已启动（需要酒馆在 :8000 运行）")
        print("\n全部就绪：")
        print("  前端  http://127.0.0.1:8770/ui/")
        print("  编辑器 http://127.0.0.1:8770/editor/")
        print("停止：在本终端按 Ctrl+C")
        while all(p.poll() is None for p in procs):
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        stop_owned(procs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
