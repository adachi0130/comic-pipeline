"""ComfyUI / 仙宫云 接口。

一块是「连接与工作流」：配置出图后端（仙宫云网址 / 本机）、导入并激活工作流、
维护参数映射、拉取 LoRA 列表、试跑一张图——对应 Manga Editor Desu 的
「外部 AI 设置」，但改由后端托管、可在自研前端编辑。

另一块是「按格出图」：把某格的出图丢进作业队列。
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...comfy import service, store
from ...comfy.client import ComfyClient, ComfyError
from ...comfy.ui_convert import ConvertError, is_ui_format, ui_to_api
from ...comfy.workflow import WorkflowError, describe_workflow, is_api_format
from ...config import WorkflowParams, get_settings
from ...db import get_session
from ...models import LoraSelection, Project

router = APIRouter(tags=["comfy"])

_SAFE_FILE = re.compile(r"[^0-9A-Za-z._-]")


def _client(backend: str = "cloud") -> ComfyClient:
    cfg = store.load_comfy_config()
    if backend == "local":
        return ComfyClient(cfg.local_url or get_settings().comfy_local_fallback_url,
                           timeout_s=get_settings().comfy_timeout_s)
    return service.get_client()


def _client_from(url: str, api_key: str = "") -> ComfyClient:
    return ComfyClient(url, timeout_s=get_settings().comfy_timeout_s, api_key=api_key)


def _resolve_backend(body: dict) -> tuple[str, str, str]:
    """从请求体解析 ``(backend, url, api_key)``，缺省用已保存的配置。"""
    cfg = store.load_comfy_config()
    backend = body.get("backend") or cfg.backend
    if backend == "local":
        url = (body.get("url") or "").strip() or cfg.local_url
        return backend, url, ""
    url = (body.get("url") or "").strip() or cfg.cloud_url
    key = body.get("api_key")
    if key is None:
        key = cfg.cloud_api_key
    return backend, url, (key or "").strip()


def _fetch_and_convert(client: ComfyClient, name: str) -> tuple[dict, list[str], bool]:
    """取一个工作流并按需转 API 格式，返回 (api, warnings, was_ui)。"""
    raw = client.get_workflow(name)
    if is_ui_format(raw):
        info = client.object_info()
        api, warnings = ui_to_api(raw, info)
        return api, warnings, True
    return raw, [], False


# ==========================================================================
# 连接（第一步：POST 一次，拿到这台后端有哪些工作流 / LoRA）
# ==========================================================================
@router.post("/comfy/connect")
def connect(body: dict) -> dict:
    """按给定（或已存）的地址探测出图后端，保存配置，并返回工作流 / 模型清单。"""
    backend, url, api_key = _resolve_backend(body or {})
    cfg = store.load_comfy_config()
    cfg.backend = backend
    if backend == "local":
        cfg.local_url = url
    else:
        cfg.cloud_url = url
        if (body or {}).get("api_key"):
            cfg.cloud_api_key = api_key
    store.save_comfy_config(cfg)

    client = _client(backend)
    out: dict = {
        "ok": False, "backend": backend, "url": url, "reachable": False,
        "workflows": [], "loras": [], "checkpoints": [], "vaes": [],
        "samplers": [], "schedulers": [], "error": "",
    }
    if not url:
        out["error"] = "还没填地址"
        return out
    if not url.startswith(("http://", "https://")):
        out["error"] = f"地址要形如 http://127.0.0.1:8188 或 https://xxx.com（你填的是「{url}」，看起来不是网址）"
        return out
    if not client.ping(timeout_s=8):
        out["error"] = "连不上（检查地址 / 隧道 / 密钥）"
        return out
    out["reachable"] = True
    out["ok"] = True
    try:
        out["workflows"] = client.list_workflows()
    except ComfyError as e:
        out["error"] = f"读工作流列表失败：{e}"
    try:
        out["loras"] = client.list_models("loras")
        out["checkpoints"] = client.list_models("checkpoints")
        out["vaes"] = client.list_models("vae")
        out["samplers"] = client.list_models("sampler_name")
        out["schedulers"] = client.list_models("scheduler")
    except Exception:  # noqa: BLE001 - 老版本 ComfyUI 可能没有 /models
        pass
    return out


@router.get("/comfy/models/{kind}")
def models(kind: str, backend: str = Query("", pattern="^(|cloud|local)$")) -> dict:
    """``kind`` 取 loras / checkpoints / vae / sampler_name / scheduler 等。"""
    cfg = store.load_comfy_config()
    client = _client(backend or cfg.backend)
    if not client.ping(timeout_s=5):
        raise HTTPException(502, "出图后端连不上")
    return {"backend": backend or cfg.backend, "kind": kind, "items": client.list_models(kind)}


# ==========================================================================
# 点某个工作流 → 看它有哪些参数（提示词 / 采样 / LoRA 槽）
# ==========================================================================
@router.post("/comfy/server-workflow")
def server_workflow(body: dict) -> dict:
    """读某台后端上的工作流原始文件并体检：可编辑参数、LoRA 槽、缺失节点。"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "缺少工作流名")
    client = _client(_resolve_backend(body)[0])
    try:
        api, warnings, was_ui = _fetch_and_convert(client, name)
    except (ComfyError, ConvertError) as e:
        raise HTTPException(502, str(e)) from e
    try:
        info = client.object_info()
    except ComfyError:
        info = {}
    desc = describe_workflow(api, info)
    return {
        "name": name,
        "ui_format": was_ui,
        "warnings": warnings,
        "describe": desc,
        "node_ids": list(api.keys()),
    }


@router.post("/comfy/import-from-server")
def import_from_server(body: dict) -> dict:
    """把后端上的某个工作流导入生产线并设为当前（顺带自动映射参数）。"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "缺少工作流名")
    reg_name = name[:-5] if name.lower().endswith(".json") else name
    client = _client(_resolve_backend(body)[0])
    try:
        api, warnings, _ = _fetch_and_convert(client, name)
    except (ComfyError, ConvertError) as e:
        raise HTTPException(400, str(e)) from e
    if not api:
        raise HTTPException(400, "转换后工作流为空，无法导入")
    store.save_workflow_json(reg_name, api)
    try:
        params = store.guess_and_save_params(reg_name)
    except WorkflowError as e:
        warnings.append(f"参数自动映射失败（可手动改）：{e}")
        params = WorkflowParams()
    cfg = store.load_comfy_config()
    cfg.workflow_name = reg_name
    store.save_comfy_config(cfg)
    service.get_workflow_params(refresh=True)
    return {
        "ok": True, "name": reg_name, "warnings": warnings,
        "summary": _wf_summary(reg_name), "params": params.model_dump(mode="json"),
    }


# ==========================================================================
# 连接配置
# ==========================================================================
def _config_dto(cfg: store.ComfyConfig, *, reveal: bool = False) -> dict:
    d = cfg.model_dump(mode="json")
    if not reveal and d.get("cloud_api_key"):
        d["cloud_api_key"] = ""
        d["has_api_key"] = True
    else:
        d["has_api_key"] = bool(cfg.cloud_api_key)
    d["active_url"] = cfg.active_url()
    d["workflows"] = store.list_workflows()
    return d


@router.get("/comfy/config")
def get_config(reveal: bool = False) -> dict:
    return _config_dto(store.load_comfy_config(), reveal=reveal)


@router.put("/comfy/config")
def put_config(body: dict) -> dict:
    """保存连接配置。``cloud_api_key`` 为空字符串时保留原有密钥（避免误清空）。"""
    cur = store.load_comfy_config()
    data = {**cur.model_dump(mode="json")}
    for k, v in (body or {}).items():
        if k in ("has_api_key", "active_url", "workflows"):
            continue
        if k == "cloud_api_key" and (v is None or v == ""):
            continue  # 留空 = 不改
        data[k] = v
    try:
        cfg = store.ComfyConfig.model_validate(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"配置不合法：{e}") from e
    store.save_comfy_config(cfg)
    return _config_dto(cfg)


@router.get("/comfy/status")
def status() -> dict:
    s = get_settings()
    cfg = store.load_comfy_config()
    # 探测给短超时：前端打开设置面板时会调它，不能卡住（连不上就快速返回未连接）
    cloud = _client("cloud")
    local = _client("local")
    return {
        "backend": cfg.backend,
        "cloud": {
            "url": cfg.cloud_url,
            "configured": bool(cfg.cloud_url),
            "reachable": cloud.ping(timeout_s=2.5) if cfg.cloud_url else False,
        },
        "local": {"url": cfg.local_url, "reachable": local.ping(timeout_s=2.5)},
        "workflow_name": cfg.workflow_name,
        "workflows": store.list_workflows(),
        "legacy_workflow_path": str(s.workflow_path),
    }


# ==========================================================================
# 工作流登记（导入 / 激活 / 删除 / 查看）
# ==========================================================================
def _wf_summary(name: str) -> dict:
    try:
        wf = store.load_workflow_json(name)
    except Exception as e:  # noqa: BLE001
        return {"name": name, "error": str(e)}
    params = store.load_params(name)
    st = params.lora_stacker
    return {
        "name": name,
        "node_count": len(wf),
        "api_format": is_api_format(wf),
        "class_types": sorted({n.get("class_type") for n in wf.values() if isinstance(n, dict)}),
        "has_prompt_placeholder": bool(params.prompt_placeholder),
        "prompt_placeholder": params.prompt_placeholder,
        "lora_mode": (
            f"堆加载（{st.class_type or 'stacker'} × {len(st.slots)} 槽 · {'对象式' if st.style == 'dict' else '扁平式'}）"
            if st
            else (f"串联 × {len(params.lora_slots)}" if params.lora_slots else "无")
        ),
        "bindings_count": len(params.bindings),
    }


@router.get("/comfy/workflows")
def list_workflows() -> dict:
    cfg = store.load_comfy_config()
    return {
        "active": cfg.workflow_name,
        "workflows": [_wf_summary(n) for n in store.list_workflows()],
    }


@router.post("/comfy/workflows")
def import_workflow(body: dict) -> dict:
    """导入工作流。

    body: ``{name, workflow}``，``workflow`` 可以是 JSON 对象、JSON 字符串或整段文本。
    - API 格式：直接存；
    - UI 格式：尝试用后端 ``/object_info`` 自动转成 API 格式（失败则报错并给出原因）。
    """
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "请给工作流起个名字")
    raw = body.get("workflow")
    if raw is None:
        raise HTTPException(400, "缺少 workflow 内容")

    import json

    if isinstance(raw, str):
        try:
            wf = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"JSON 解析失败：{e}") from e
    elif isinstance(raw, dict):
        wf = raw
    else:
        raise HTTPException(400, "workflow 必须是对象或 JSON 文本")

    warnings: list[str] = []
    if is_ui_format(wf):
        # 需要 object_info 才能把位置对应到输入名
        try:
            info = _client("cloud" if store.load_comfy_config().backend == "cloud" else "local").object_info()
        except ComfyError as e:
            raise HTTPException(
                400,
                f"这是 ComfyUI UI 格式工作流，转 API 格式需要连上出图后端拉 /object_info，但拉取失败：{e}。"
                "请先在「连接」里把仙宫云（或本机）地址调通，或在 ComfyUI 里用「保存（API 格式）」导出后上传。",
            ) from e
        try:
            wf, warnings = ui_to_api(wf, info)
        except ConvertError as e:
            raise HTTPException(400, str(e)) from e
        if not wf:
            raise HTTPException(400, "转换后工作流为空，请改用 API 格式导出")
    elif not is_api_format(wf):
        raise HTTPException(400, "无法识别的格式：既不是 API 格式也不是 UI 格式")

    store.save_workflow_json(name, wf)
    # 顺手初猜一次参数映射并落盘
    try:
        params = store.guess_and_save_params(name)
    except WorkflowError as e:
        warnings.append(f"参数自动映射失败（可手动改）：{e}")
        params = WorkflowParams()

    # 若还没有活动工作流，就把这个设为活动
    cfg = store.load_comfy_config()
    if not cfg.workflow_name:
        cfg.workflow_name = name
        store.save_comfy_config(cfg)

    return {
        "ok": True,
        "name": name,
        "warnings": warnings,
        "summary": _wf_summary(name),
        "params": params.model_dump(mode="json"),
    }


@router.post("/comfy/workflows/{name}/activate")
def activate_workflow(name: str) -> dict:
    if name not in store.list_workflows():
        raise HTTPException(404, f"工作流不存在：{name}")
    cfg = store.load_comfy_config()
    cfg.workflow_name = name
    store.save_comfy_config(cfg)
    service.get_workflow_params(refresh=True)
    return {"ok": True, "active": name}


@router.delete("/comfy/workflows/{name}")
def delete_workflow(name: str) -> dict:
    cfg = store.load_comfy_config()
    store.delete_workflow_json(name)
    if cfg.workflow_name == name:
        remaining = store.list_workflows()
        cfg.workflow_name = remaining[0] if remaining else ""
        store.save_comfy_config(cfg)
    return {"ok": True, "active": cfg.workflow_name}


@router.get("/comfy/workflows/{name}/raw")
def workflow_raw(name: str) -> dict:
    try:
        return {"name": name, "workflow": store.load_workflow_json(name)}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e


# ==========================================================================
# 参数映射
# ==========================================================================
@router.get("/comfy/workflows/{name}/mapping")
def get_mapping(name: str) -> dict:
    if name not in store.list_workflows():
        raise HTTPException(404, f"工作流不存在：{name}")
    return store.load_params(name).model_dump(mode="json")


@router.put("/comfy/workflows/{name}/mapping")
def put_mapping(name: str, body: dict) -> dict:
    if name not in store.list_workflows():
        raise HTTPException(404, f"工作流不存在：{name}")
    try:
        params = WorkflowParams.model_validate(body)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"映射不合法：{e}") from e
    store.save_params(name, params)
    service.get_workflow_params(refresh=True)
    return params.model_dump(mode="json")


@router.post("/comfy/workflows/{name}/mapping/guess")
def guess_mapping_route(name: str) -> dict:
    if name not in store.list_workflows():
        raise HTTPException(404, f"工作流不存在：{name}")
    try:
        params = store.guess_and_save_params(name)
    except WorkflowError as e:
        raise HTTPException(400, str(e)) from e
    service.get_workflow_params(refresh=True)
    return params.model_dump(mode="json")


# ==========================================================================
# 资产（LoRA / checkpoint / 采样器）
# ==========================================================================
@router.get("/comfy/assets")
def assets(backend: str = Query("", pattern="^(|cloud|local)$")) -> dict:
    cfg = store.load_comfy_config()
    backend = backend or cfg.backend
    client = _client(backend)
    try:
        info = client.object_info()
    except ComfyError as e:
        raise HTTPException(502, str(e)) from e
    return {
        "backend": backend,
        "url": cfg.cloud_url if backend == "cloud" else cfg.local_url,
        "loras": client.list_loras(info),
        "checkpoints": client.list_checkpoints(info),
        "samplers": client.list_samplers(info),
        "schedulers": client.list_schedulers(info),
    }


# ==========================================================================
# 试跑一张图（不落产物，仅验证工作流 + 参数 + LoRA 是否通）
# ==========================================================================
TEST_DIRNAME = "comfy_tests"


@router.post("/comfy/test-run")
def test_run(body: dict) -> dict:
    """按当前活动工作流跑一张测试图，存盘并返回可预览的 URL。"""
    from ...comfy.service import GenRequest, generate, save_images

    prompt_pos = (body.get("prompt_pos") or "").strip() or "1girl, solo, masterpiece, best quality"
    prompt_neg = (body.get("prompt_neg") or "").strip()
    loras = body.get("loras") or []
    params = body.get("params") or {}
    cfg = store.load_comfy_config()

    if not cfg.workflow_name:
        raise HTTPException(400, "还没有选中的工作流，请先导入并激活一个工作流")

    req = GenRequest(
        prompt_pos=prompt_pos,
        prompt_neg=prompt_neg,
        seed=body.get("seed"),
        steps=params.get("steps"),
        cfg=params.get("cfg"),
        sampler=params.get("sampler"),
        scheduler=params.get("scheduler"),
        width=params.get("width"),
        height=params.get("height"),
        ckpt_name=params.get("ckpt_name"),
        denoise=params.get("denoise"),
        loras=list(loras),
        count=1,
    )
    try:
        images = generate(req)
    except (ComfyError, WorkflowError, RuntimeError) as e:
        raise HTTPException(502, f"试跑失败：{e}") from e
    if not images:
        raise HTTPException(502, "试跑没有返回图片（检查工作流是否有 SaveImage/PreviewImage 输出节点）")

    import time

    out_dir = get_settings().data_dir / TEST_DIRNAME
    stem = f"test_{int(time.time())}"
    paths = save_images(images, out_dir, stem=stem)
    name = paths[0].name
    return {"ok": True, "file": name, "url": f"/api/comfy/test-image/{name}", "count": len(paths)}


@router.get("/comfy/test-image/{filename}")
def test_image(filename: str):
    safe = _SAFE_FILE.sub("", filename)
    p = get_settings().data_dir / TEST_DIRNAME / safe
    if not p.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(str(p))


# ==========================================================================
# 项目级 LoRA 选择（真正落到出图的 LoRA）
# ==========================================================================
@router.get("/projects/{project_id}/loras")
def list_loras(project_id: int, session: Session = Depends(get_session)) -> dict:
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    rows = session.scalars(
        select(LoraSelection)
        .where(LoraSelection.project_id == project_id)
        .order_by(LoraSelection.scope, LoraSelection.order_index)
    ).all()
    return {
        "rows": [
            {
                "id": r.id,
                "scope": r.scope,
                "panel_ref": r.panel_ref,
                "lora_name": r.lora_name,
                "weight": r.weight,
                "enabled": r.enabled,
                "order_index": r.order_index,
            }
            for r in rows
        ]
    }


@router.put("/projects/{project_id}/loras")
def set_loras(project_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """整体替换某项目的 LoRA 列表（scope=project 的那一组）。"""
    if session.get(Project, project_id) is None:
        raise HTTPException(404, "项目不存在")
    items = body.get("loras") or []
    scope = body.get("scope") or "project"
    project_rows = session.scalars(
        select(LoraSelection).where(
            LoraSelection.project_id == project_id, LoraSelection.scope == scope
        )
    ).all()
    for r in project_rows:
        if r.panel_ref == (body.get("panel_ref") or ""):
            session.delete(r)
    for i, it in enumerate(items):
        session.add(
            LoraSelection(
                project_id=project_id,
                scope=scope,
                panel_ref=body.get("panel_ref") or "",
                lora_name=it.get("lora_name") or it.get("name") or "",
                weight=float(it.get("weight", 0.8)),
                enabled=bool(it.get("enabled", True)),
                order_index=i,
            )
        )
    session.commit()
    return {"ok": True, "count": len(items)}


# ==========================================================================
# 按格出图
# ==========================================================================
@router.post("/projects/{project_id}/artifacts/{artifact_id}/open-workflow")
def open_workflow(project_id: int, artifact_id: int, body: dict, session: Session = Depends(get_session)) -> dict:
    """「工作流」按钮：把这张图上传到 ComfyUI，并把生成它的**完整工作流快照**
    写到 ComfyUI 的用户工作流目录，然后返回可打开的 ComfyUI 地址。

    这样你打开 ComfyUI 就能在侧栏看到这个名字的工作流（等于把这张图的工作流"打开"）。
    """
    import json as _json
    from pathlib import Path

    import httpx

    from ...comfy import store as comfy_store
    from ...models import Artifact

    art = session.get(Artifact, artifact_id)
    if art is None:
        raise HTTPException(404, "产物不存在")
    idx = int(body.get("index", 0))
    cands = (art.payload or {}).get("candidates") or []
    if not (0 <= idx < len(cands)):
        raise HTTPException(400, "候选序号越界")
    src = Path(cands[idx].get("path", ""))
    if not src.exists():
        raise HTTPException(404, "候选文件缺失")

    cfg = comfy_store.load_comfy_config()
    base = (cfg.active_url() or "").rstrip("/")
    if not base:
        raise HTTPException(400, "还没配出图后端地址（出图设置里填）")
    headers = {"Authorization": f"Bearer {cfg.active_api_key()}"} if cfg.active_api_key() else {}

    uploaded = ""
    try:
        with open(src, "rb") as f:
            r = httpx.post(f"{base}/upload/image", files={"image": (src.name, f, "image/png")},
                           data={"overwrite": "true", "type": "input"}, headers=headers, timeout=30.0)
        r.raise_for_status()
        uploaded = (r.json() or {}).get("name") or src.name
    except Exception as e:  # noqa: BLE001 - 上传失败也算部分成功，继续
        uploaded = ""

    # 工作流快照写到 ComfyUI 的用户工作流目录（best-effort）
    workflow = (art.payload or {}).get("workflow")
    wf_name = f"{art.ref.replace(':', '_')}"
    saved = False
    if workflow:
        try:
            r = httpx.post(f"{base}/userdata/workflows%2F{wf_name}.json",
                           content=_json.dumps(workflow, ensure_ascii=False).encode("utf-8"),
                           headers={**headers, "Content-Type": "application/json"}, timeout=30.0)
            saved = r.status_code < 400
        except Exception:  # noqa: BLE001
            saved = False

    return {
        "ok": True, "uploaded": uploaded, "workflow_saved": saved,
        "workflow_name": wf_name if saved else "",
        "comfy_url": base + "/",
    }


def _comfy_base() -> str:
    from ...comfy import store as comfy_store

    cfg = comfy_store.load_comfy_config()
    return (cfg.active_url() or "").rstrip("/")


# ==========================================================================
# 按格出图
# ==========================================================================
@router.post("/projects/{project_id}/panels/{panel_ref}/generate")
def generate_panel(
    project_id: int,
    panel_ref: str,
    body: dict,
    session: Session = Depends(get_session),
) -> dict:
    """把一格的出图丢进作业队列。body: {prompt_pos, prompt_neg, count, params, loras, seed}"""
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "项目不存在")
    payload = {"project_id": project_id, "panel_ref": panel_ref, **body}
    job = jobq.enqueue("image", project_id=project_id, stage="S4", payload=payload)
    return {"job_id": job.id, "status": job.status}
