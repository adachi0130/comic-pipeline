"""ComfyUI / 仙宫云 接口。

一块是「连接与工作流」：配置出图后端（仙宫云网址 / 本机）、导入并激活工作流、
维护参数映射、拉取 LoRA 列表、试跑一张图——对应 Manga Editor Desu 的
「外部 AI 设置」，但改由后端托管、可在自研前端编辑。

另一块是「按格出图」：把某格的出图丢进作业队列。
"""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...comfy import service, store
from ...comfy.client import ComfyClient, ComfyError
from ...comfy.subgraph import expand_subgraphs_ui
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
    return ComfyClient(cfg.cloud_url or get_settings().comfy_base_url,
                       timeout_s=get_settings().comfy_timeout_s, api_key=cfg.cloud_api_key)


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
    """取一个工作流并按需转 API 格式，返回 (api, warnings, was_ui)。

    UI 格式若含「子图」，会先展开子图再转 API——否则顶层看不到 KSampler 等节点。
    """
    raw = client.get_workflow(name)
    if is_ui_format(raw):
        info = client.object_info()
        flat, sw = expand_subgraphs_ui(raw)
        api, warnings = ui_to_api(flat, info)
        return api, (sw + warnings), True
    return raw, [], False


def _uploaded_workflow(body: dict) -> tuple[dict, list[str], bool, dict]:
    """预览和保存共用转换，API 文件可离线解析，UI 文件需要真实节点定义。"""
    raw = body.get("workflow")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw.lstrip("\ufeff"))
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"JSON 解析失败：{e}") from e
    if not isinstance(raw, dict):
        raise HTTPException(400, "workflow 必须是 JSON 对象")
    was_ui = is_ui_format(raw)
    info: dict = {}
    warnings: list[str] = []
    if was_ui or body.get("check_nodes"):
        try:
            _, url, key = _resolve_backend(body)
            info = _client_from(url, key).object_info()
        except ComfyError as e:
            if was_ui:
                raise HTTPException(
                    400, "这是 ComfyUI UI 格式工作流，解析需要连接 ComfyUI 读取节点定义。"
                    f"请先连接，或改用「保存（API 格式）」导出的 JSON：{e}",
                ) from e
            warnings.append("暂时无法读取后端节点定义，已解析 API 工作流；出图前请确认所需节点已安装")
    if was_ui:
        try:
            raw, subgraph_warnings = expand_subgraphs_ui(raw)
            raw, conversion_warnings = ui_to_api(raw, info)
            warnings.extend(subgraph_warnings + conversion_warnings)
        except (ConvertError, TypeError, ValueError, KeyError, AttributeError) as e:
            raise HTTPException(400, f"UI 工作流转换失败：{e}") from e
    if not is_api_format(raw):
        raise HTTPException(400, "无法识别的工作流：API 格式的每个节点必须有 class_type 和 inputs，或上传有效的 UI 格式 JSON")
    return raw, warnings, was_ui, info


def _workflow_details(name: str, workflow: dict, *, warnings=None, was_ui=False, info=None) -> dict:
    desc = describe_workflow(workflow, info)
    resolved = _resolve_sampler_prompts(workflow, desc)
    # 占位符定义了实际注入位置，复杂拼装链路也无需猜正负文本节点。
    for key, token in (("prompt_pos", "%prompt%"), ("prompt_neg", "%negative%")):
        fields = [
            {"node_id": nid, "class_type": node["class_type"], "input": field, "value": value}
            for nid, node in workflow.items()
            for field, value in node["inputs"].items()
            if isinstance(value, str) and token in value
        ]
        if fields:
            resolved[key] = ({**fields[0], "placeholder": token} if len(fields) == 1 else
                             {"dynamic": True, "chunks": fields, "placeholder": token})
            resolved["reason"] = ""
    return {
        "name": name, "workflow": workflow, "ui_format": was_ui,
        "warnings": warnings or [], "describe": desc, "resolved": resolved,
        "node_ids": list(workflow),
    }


@router.post("/comfy/workflows/preview")
def preview_workflow(body: dict) -> dict:
    """上传仅解析预览，选用后才保存；同名文件默认建议一个新名称。"""
    name = (body.get("name") or "上传的工作流").strip()
    if name.lower().endswith(".json"):
        name = name[:-5]
    try:
        name = store.safe_workflow_name(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    stem, index = name, 2
    existing = set(store.list_workflows())
    while name in existing:
        name = store.safe_workflow_name(f"{stem[:70]}_{index}")
        index += 1
    workflow, warnings, was_ui, info = _uploaded_workflow(body)
    return _workflow_details(name, workflow, warnings=warnings, was_ui=was_ui, info=info)


def _source_text_chunks(api: dict, start: Any, depth: int = 0, seen: set | None = None) -> list[dict]:
    """顺着一条 text 输入，收集其背后所有「静态文本块」。

    正向提示词常由 StringFunction / PromptCleaningMaid / WildcardProcessor 动态拼装，
    无法还原成一个字符串；这里把参与拼装的各个文本块列出来，供用户了解与手动指定。
    """
    seen = seen if seen is not None else set()
    if depth > 5 or not isinstance(start, list) or len(start) < 2:
        return []
    nid = str(start[0])
    if nid in seen:
        return []
    seen.add(nid)
    node = api.get(nid)
    if not isinstance(node, dict):
        return []
    out: list[dict] = []
    ins = node.get("inputs") or {}
    for key, val in ins.items():
        if isinstance(val, str) and key.lower() in ("text", "value", "string", "prompt", "text_b", "text_c", "wildcard", "populated"):
            out.append({"node_id": nid, "class_type": node.get("class_type") or "", "input": key, "value": val})
        elif isinstance(val, list):
            out.extend(_source_text_chunks(api, val, depth + 1, seen))
    return out


def _resolve_cond(api: dict, link: Any, _depth: int = 0) -> tuple[dict | None, bool]:
    """把一条条件链接解析成 ``(信息, 是否动态拼装)``；解析不到返回 (None, False)。"""
    from ...comfy.workflow import _link_target

    resolved = _link_target(api, link)
    if not resolved or _depth > 5:
        return None, False
    nid, node = resolved
    cls = node.get("class_type") or ""
    text = (node.get("inputs") or {}).get("text")
    if isinstance(text, str):
        return {"node_id": str(nid), "class_type": cls, "value": text}, False
    # 动态拼装：收集参与的文本块
    chunks = _source_text_chunks(api, text if isinstance(text, list) else [str(nid), 0])
    return {"node_id": str(nid), "class_type": cls, "value": "", "dynamic": True, "chunks": chunks}, True


def _resolve_sampler_prompts(api: dict, desc: dict) -> dict:
    """从 KSampler 的 positive/negative 解析正/负提示词。

    复杂工作流里常有多个采样器（有的只做高修/重绘、条件走 GetCond 取不到文本），
    这里对**每个采样器**都试一遍，按「能取到多少文本」打分，取最好的那个。
    """
    from ...comfy.workflow import SAMPLER_CLASSES

    def score(res: tuple, dyn: bool) -> int:
        if not res:
            return 0
        if not dyn:
            return 2 if (res.get("value") or "").strip() else 1     # 静态文本
        return 1 if res.get("chunks") else 0                          # 动态但有文本块

    best = None
    for nid, n in api.items():
        if not (isinstance(n, dict) and n.get("class_type") in SAMPLER_CLASSES):
            continue
        ins = n.get("inputs") or {}
        if not (isinstance(ins.get("positive"), list) or isinstance(ins.get("negative"), list)):
            continue
        p, pdyn = _resolve_cond(api, ins.get("positive"))
        q, qdyn = _resolve_cond(api, ins.get("negative"))
        total = score(p, pdyn) + score(q, qdyn)
        if best is None or total > best[0]:
            best = (total, str(nid), p, q)
    if best is None:
        return {"prompt_pos": None, "prompt_neg": None, "chunks": [],
                "reason": "工作流里没有带条件输入的采样器（KSampler）"}
    total, sid, p, q = best
    out: dict = {"prompt_pos": p, "prompt_neg": q, "chunks": [], "reason": "", "sampler_id": sid}
    if total == 0:
        out["reason"] = f"采样器 {sid} 的正/负条件无法解析出文本（可能经过 Get/Set 间接引用）"
    return out


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
    if not is_api_format(api):
        raise HTTPException(400, "工作流转换结果无效，请检查节点或改用 API 格式")
    return _workflow_details(name, api, warnings=warnings, was_ui=was_ui, info=info)


@router.get("/comfy/server-workflow-download")
def server_workflow_download(
    name: str,
    backend: str = "cloud",
    fmt: str = Query("raw", alias="format"),
):
    """把出图后端上的某个工作流导出成本地文件下载。

    ``format=raw`` → 后端上的原始文件（原样）；
    ``format=api`` → 转成 API 格式后的版本（子图等无法转换的部分会被列出警告）。
    """
    import json as _json
    from urllib.parse import quote

    from fastapi.responses import Response

    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "缺少工作流名")
    client = _client(_resolve_backend({"backend": backend})[0])
    try:
        raw = client.get_workflow(name)
    except ComfyError as e:
        raise HTTPException(502, str(e)) from e

    if fmt == "api":
        if is_ui_format(raw):
            try:
                info = client.object_info()
            except ComfyError:
                info = {}
            api, _w = ui_to_api(raw, info)
            data = api
        else:
            data = raw
    else:
        data = raw

    text = _json.dumps(data, ensure_ascii=False, indent=2)
    stem = name[:-5] if name.lower().endswith(".json") else name
    fname = f"{stem}.api.json" if fmt == "api" else f"{stem}.json"
    return Response(
        content=text,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
    )


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
    if name.lower().endswith(".json"):
        name = name[:-5]
    try:
        name = store.safe_workflow_name(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if body.get("overwrite") is False and name in store.list_workflows():
        raise HTTPException(409, "已有同名工作流，请重新上传以生成新名称")
    wf, warnings, _, _ = _uploaded_workflow(body)
    store.save_workflow_json(name, wf)
    # 顺手初猜一次参数映射并落盘
    try:
        params = store.guess_and_save_params(name)
    except WorkflowError as e:
        warnings.append(f"参数自动映射失败（可手动改）：{e}")
        params = WorkflowParams()

    # 若还没有活动工作流，就把这个设为活动
    cfg = store.load_comfy_config()
    if not cfg.workflow_name or body.get("activate"):
        cfg.workflow_name = name
        store.save_comfy_config(cfg)
    service.get_workflow_params(refresh=True)

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


@router.get("/comfy/workflows/{name}/inspect")
def inspect_saved_workflow(name: str) -> dict:
    """本地已保存的工作流可在未连接 ComfyUI 时重新打开。"""
    try:
        wf = store.load_workflow_json(name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return _workflow_details(name, wf)


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
