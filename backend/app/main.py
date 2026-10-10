"""FastAPI 入口。

启动时：建表（M0）/ 启动作业队列 / 挂静态资源。
- ``/api/*``   业务接口
- ``/editor/`` vendor 的 Manga Editor Desu（同源托管，供桥驱动）
- ``/ui/``     自研前端
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import jobs
from .config import BACKEND_DIR, get_settings
from .db import init_db
from .api.routes import artifacts as artifacts_routes
from .api.routes import assets as assets_routes
from .api.routes import bridge as bridge_routes
from .api.routes import comfy as comfy_routes
from .api.routes import jobs as jobs_routes
from .api.routes import meta as meta_routes
from .api.routes import pipeline as pipeline_routes
from .api.routes import projects as projects_routes
from .api.routes import prompts as prompts_routes
from .api.routes import providers as providers_routes
from .comfy.tunnel import SshTunnel
from .stages import register_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("comic")

settings = get_settings()
_tunnel: SshTunnel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    init_db()
    register_all()
    jobs.start(max_workers=max(2, settings.comfy_max_concurrency + 2))

    # 一次性回填：把已有提示词产物的宽高按画框重算（早期版本长边算错）
    try:
        from .db import SessionLocal
        from .stages import prompt as prompt_stage

        _s = SessionLocal()
        try:
            _n = prompt_stage.backfill_panel_sizes(_s)
            if _n:
                log.info("回填提示词宽高：%s 条", _n)
        finally:
            _s.close()
    except Exception as e:  # noqa: BLE001 - 回填失败不影响启动
        log.warning("回填提示词宽高失败：%s", e)

    global _tunnel
    if settings.tunnel.enabled and settings.tunnel.ssh_host:
        _tunnel = SshTunnel(
            ssh_host=settings.tunnel.ssh_host,
            ssh_port=settings.tunnel.ssh_port,
            ssh_user=settings.tunnel.ssh_user,
            local_port=settings.tunnel.local_port,
            remote_port=settings.tunnel.remote_port,
            ssh_key_path=settings.tunnel.ssh_key_path,
        )
        st = _tunnel.start()
        log.info("SSH 隧道：running=%s local=%s err=%s", st.running, st.local_port, st.error)

    log.info("后端就绪：%s", settings.app_name)
    try:
        yield
    finally:
        if _tunnel is not None:
            _tunnel.stop()
        jobs.shutdown()


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

# 放行酒馆页面（扩展桥）与其他本地前端的跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

app.include_router(meta_routes.router, prefix="/api")
app.include_router(projects_routes.router, prefix="/api")
app.include_router(artifacts_routes.router, prefix="/api")
app.include_router(providers_routes.router, prefix="/api")
app.include_router(prompts_routes.router, prefix="/api")
app.include_router(comfy_routes.router, prefix="/api")
app.include_router(jobs_routes.router, prefix="/api")
app.include_router(pipeline_routes.router, prefix="/api")
app.include_router(bridge_routes.router, prefix="/api")
app.include_router(assets_routes.router, prefix="/api")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "app": settings.app_name}


@app.get("/")
def root():
    """根路径跳转到自研前端。"""
    from fastapi.responses import RedirectResponse

    return RedirectResponse("/ui/")


# 静态资源（若目录已有内容才挂载，避免空目录报错）
_editor_dir = BACKEND_DIR / "static" / "editor"
_ui_dir = BACKEND_DIR / "static" / "ui"
if _editor_dir.exists():
    app.mount("/editor", StaticFiles(directory=str(_editor_dir), html=True), name="editor")
if _ui_dir.exists():
    # 自研前端：加 no-cache，避免浏览器缓存旧 app.js 导致“按钮点了没反应”这类假故障。
    # （本地开发工具，性能无关紧要，正确性优先。）
    from starlette.middleware.base import BaseHTTPMiddleware

    class _NoCacheUI(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):  # noqa: ANN001
            resp = await call_next(request)
            if request.url.path.startswith("/ui"):
                resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
                resp.headers["Pragma"] = "no-cache"
                resp.headers["Expires"] = "0"
            return resp

    app.add_middleware(_NoCacheUI)
    app.mount("/ui", StaticFiles(directory=str(_ui_dir), html=True), name="ui")


@app.exception_handler(Exception)
async def _unhandled(request, exc):  # noqa: ANN001
    log.exception("未处理异常：%s", exc)
    return JSONResponse(status_code=500, content={"error": str(exc)})


def run() -> None:  # pragma: no cover - 命令行入口
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8770, reload=settings.debug)
