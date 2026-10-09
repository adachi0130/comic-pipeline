"""一键启动（干净版）：先清掉旧的同名进程，再启动后端 + 常驻酒馆桥。

为什么需要：反复手动启动会留下多个进程（多个桥同时推镜像、多个后端抢同一个端口），
之前就因此出现过“聊天记录一闪一闪”和重复写入对话文件的问题。

用法：
    .venv/Scripts/python.exe tools/start_all.py            # 后端 + 桥
    .venv/Scripts/python.exe tools/start_all.py --no-bridge # 只起后端
    .venv/Scripts/python.exe tools/start_all.py --stop      # 只清理进程
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
PY = str(VENV_PY if VENV_PY.exists() else sys.executable)

MARKERS = ("tavern_bridge.py", "uvicorn app.main:app", "mock_llm.py")


def list_python_procs() -> list[tuple[int, str]]:
    """返回 (pid, cmdline) 列表。"""
    try:
        out = subprocess.run(
            ["wmic", "process", "where", "name='python.exe'", "get", "ProcessId,CommandLine"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        ).stdout
    except OSError:
        return []
    procs: list[tuple[int, str]] = []
    for line in out.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("commandline"):
            continue
        # 末尾是 pid
        parts = line.rsplit(None, 1)
        if len(parts) != 2 or not parts[1].isdigit():
            continue
        procs.append((int(parts[1]), parts[0]))
    return procs


def kill_existing(verbose: bool = True) -> int:
    """杀掉本项目相关的旧 python 进程（后端 / 桥 / mock），返回清理数量。"""
    n = 0
    me = os.getpid()
    for pid, cmd in list_python_procs():
        if pid == me:
            continue
        if any(m in cmd for m in MARKERS):
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, text=True)
            n += 1
            if verbose:
                kind = next((m for m in MARKERS if m in cmd), "?")
                print(f"  [清理] pid={pid} ({kind})")
    if n:
        time.sleep(2)  # 等端口释放
    return n


def kill_orphan_browsers(verbose: bool = True) -> int:
    """杀掉残留的无头浏览器。

    关键：桥的 python 进程被 taskkill /F 强杀时，它启动的 chrome-headless-shell
    不会跟着退出，会成为“孤儿进程”继续留着页面推镜像。多个孤儿浏览器同时推，
    前端的聊天记录就会在两个状态间来回跳（闪烁）。所以每次启动前一并清理。
    """
    n = 0
    for image in ("chrome-headless-shell.exe",):
        try:
            out = subprocess.run(
                ["wmic", "process", "where", f"name='{image}'", "get", "ProcessId"],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
            ).stdout
        except OSError:
            continue
        for line in out.splitlines():
            line = line.strip()
            if not line.isdigit():
                continue
            subprocess.run(["taskkill", "/F", "/PID", line], capture_output=True, text=True)
            n += 1
            if verbose:
                print(f"  [清理孤儿浏览器] pid={line}")
    if n:
        time.sleep(1)
    return n


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
    ap.add_argument("--stop", action="store_true", help="只清理进程，不启动")
    ap.add_argument("--no-bridge", action="store_true", help="不启动酒馆桥")
    args = ap.parse_args()

    print("清理旧进程：")
    cleared = kill_existing()
    orphans = kill_orphan_browsers()
    print(f"  进程 {cleared} 个 / 孤儿浏览器 {orphans} 个" if (cleared or orphans) else "  无")

    if args.stop:
        print("已停止。")
        return 0

    procs = [start_backend()]
    if not wait_backend():
        print("后端启动超时，请检查日志。")
        return 1
    print("后端就绪 ✓")

    if not args.no_bridge:
        procs.append(start_bridge())
        print("桥已启动（需要酒馆在 :8000 运行）")

    print("\n全部就绪：")
    print("  前端  http://127.0.0.1:8770/ui/")
    print("  编辑器 http://127.0.0.1:8770/editor/")
    print("停止：Ctrl+C，或另开窗口跑 tools/start_all.py --stop")
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
