"""ComfyUI 接口：连通性、资产列表（LoRA/checkpoint/采样器）、参数映射、触发出图。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ... import jobs as jobq
from ...comfy import service
from ...config import get_settings, load_workflow_params, save_workflow_params
from ...comfy.client import ComfyError
from ...comfy.workflow import WorkflowError, guess_mapping, is_api_format, load_workflow
from ...db import get_session
from ...models import Project

router = APIRouter(tags=["comfy"])


def _client(backend: str = "cloud"):
    return service.get_local_client() if backend == "local" else service.get_client()


@router.get("/comfy/status")
def status() -> dict:
    s = get_settings()
    cloud = _client("cloud")
    local = _client("local")
    return {
        "cloud": {"url": s.comfy_base_url, "reachable": cloud.ping()},
        "local": {"url": s.comfy_local_fallback_url, "reachable": local.ping()},
        "workflow_path": str(s.workflow_path),
        "workflow_exists": s.workflow_path.exists(),
    }


@router.get("/comfy/assets")
def assets(backend: str = Query("cloud", pattern="^(cloud|local)$")) -> dict:
    client = _client(backend)
    try:
        info = client.object_info()
    except ComfyError as e:
        raise HTTPException(502, str(e)) from e
    return {
        "backend": backend,
        "loras": client.list_loras(info),
        "checkpoints": client.list_checkpoints(info),
        "samplers": client.list_samplers(info),
        "schedulers": client.list_schedulers(info),
    }


@router.get("/comfy/workflow")
def workflow_info() -> dict:
    s = get_settings()
    if not s.workflow_path.exists():
        return {"exists": False, "path": str(s.workflow_path), "is_api_format": False}
    wf = load_workflow(s.workflow_path)
    return {
        "exists": True,
        "path": str(s.workflow_path),
        "is_api_format": is_api_format(wf),
        "node_count": len(wf),
        "class_types": sorted(
            {n.get("class_type") for n in wf.values() if isinstance(n, dict)}
        ),
    }


@router.get("/comfy/mapping")
def get_mapping() -> dict:
    return load_workflow_params().model_dump()


@router.post("/comfy/mapping/guess")
def guess_and_save() -> dict:
    """读工作流自动初猜参数映射并保存，返回映射表供前端确认/修改。"""
    s = get_settings()
    try:
        wf = load_workflow(s.workflow_path)
        params = guess_mapping(wf)
    except (WorkflowError, FileNotFoundError) as e:
        raise HTTPException(400, str(e)) from e
    save_workflow_params(params)
    service.get_workflow_params(refresh=True)
    return params.model_dump()


@router.put("/comfy/mapping")
def put_mapping(body: dict) -> dict:
    """前端确认/修改后的映射表写回。"""
    from ...config import WorkflowParams

    params = WorkflowParams.model_validate(body)
    save_workflow_params(params)
    service.get_workflow_params(refresh=True)
    return params.model_dump()


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
    job = jobq.enqueue(
        "image", project_id=project_id, stage="S4", payload=payload
    )
    return {"job_id": job.id, "status": job.status}
