"""后台执行正文到漫画整页，逐页保存以便失败后继续。"""
from types import SimpleNamespace
import hashlib
import json

from sqlalchemy import select

from .. import artifacts as A, jobs
from ..models import Artifact, Project
from ..overview import available
from . import compose, image, prompt, script

KIND = 'auto_comic'


def checkpoint(session, project_id):
    rows = session.scalars(select(Artifact).where(Artifact.project_id == project_id, Artifact.is_current.is_(True))).all()
    return {f'{a.kind}/{a.ref}': hashlib.sha256(json.dumps([a.id, a.status, a.path, a.payload], sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest() for a in rows}


def handle(session, job):
    data = job.payload
    project_id, run_id = job.project_id, data['auto_run']
    target, text = data['target_pages'], data['text']

    def check(ignore=()):
        if jobs.is_cancelled(job.id):
            return False
        session.expire_all()
        project = session.get(Project, project_id)
        prose = A.current(session, project_id, 'prose', 'seg:1')
        if not project or project.target_pages != target or not prose or (prose.payload or {}).get('text') != text or (prose.payload or {}).get('auto_run') != run_id:
            raise ValueError('项目正文或目标页数在运行中发生变化，请检查后重试。')
        actual = checkpoint(session, project_id)
        if any(actual.get(key) != value for key, value in (job.payload.get('checkpoint') or {}).items() if key not in ignore):
            raise ValueError('自动生成期间项目产物已被修改，请检查后使用新项目重新生成。')
        return True

    def child(handler, **fields):
        if not check():
            return False
        # 同步调用阶段处理器，不创建并等待子作业，避免占满作业线程池。
        fake = SimpleNamespace(id=job.id, project_id=project_id, payload={'project_id': project_id, 'auto_approve': True, 'auto_run': run_id, **fields}, progress=0, total=0, message='')
        handler(session, fake)
        allowed = []
        if handler is image.handle:
            allowed = [f"image/{fields['panel_ref']}"]
        elif handler is compose.handle:
            allowed = [f"page_image/{fields['page_ref']}"]
        elif handler is prompt.handle and fields.get('panel_ref'):
            allowed = [f"panel_prompt/{fields['panel_ref']}"]
        if not check(allowed):
            return False
        session.refresh(job)
        job.payload = {**job.payload, 'checkpoint': checkpoint(session, project_id)}
        session.commit()
        return True

    def update(message, progress=None, total=None):
        if not check():
            return
        session.refresh(job)
        job.message = message
        if progress is not None:
            job.progress = progress
        if total is not None:
            job.total = total
        job.payload = {**job.payload, 'checkpoint': checkpoint(session, project_id)}
        session.commit()

    update('正在将正文分成漫画页', 0, target * 3 + 1)
    if not child(script.handle):
        return {'cancelled': True}
    pages = []
    for i in range(1, target + 1):
        page = A.current(session, project_id, 'page_script', f'page:{i}')
        if not page or page.status != 'approved' or (page.payload or {}).get('auto_run') != run_id or not (page.payload or {}).get('panels'):
            raise ValueError(f'模型未生成有效的第 {i} 页分格，请重试。')
        pages.append(page.ref)
    update('分格完成，开始逐页生成提示词', 1)
    for i, ref in enumerate(pages, 1):
        page = A.current(session, project_id, 'page_script', ref)
        refs = [f"panel:{i}.{p['panel_order']}" for p in page.payload['panels']]
        missing = [r for r in refs if not (a := A.current(session, project_id, 'panel_prompt', r)) or a.status != 'approved' or (a.payload or {}).get('auto_run') != run_id]
        if len(missing) == len(refs):
            update(f'正在生成第 {i} 页提示词')
            if not child(prompt.handle, page_ref=ref):
                return {'cancelled': True}
            missing = []
            for panel_ref in refs:
                a = A.current(session, project_id, 'panel_prompt', panel_ref)
                if not a or a.status != 'approved' or (a.payload or {}).get('auto_run') != run_id:
                    raise ValueError(f'模型未生成 {panel_ref} 的有效提示词，请重试。')
        for panel_ref in missing:
            update(f'正在生成 {panel_ref} 的提示词')
            if not child(prompt.handle, page_ref=ref, panel_ref=panel_ref):
                return {'cancelled': True}
            a = A.current(session, project_id, 'panel_prompt', panel_ref)
            if not a or a.status != 'approved' or (a.payload or {}).get('auto_run') != run_id:
                raise ValueError(f'模型未生成 {panel_ref} 的有效提示词，请重试。')
        update(f'已完成第 {i}/{target} 页提示词', 1 + i)
    for i, ref in enumerate(pages, 1):
        page = A.current(session, project_id, 'page_script', ref)
        for panel in page.payload['panels']:
            panel_ref = f"panel:{i}.{panel['panel_order']}"
            art = A.current(session, project_id, 'image', panel_ref)
            p = (art.payload or {}) if art else {}
            idx, candidates = p.get('selected_index'), p.get('candidates') or []
            valid = art and art.status == 'approved' and p.get('auto_run') == run_id and type(idx) is int and 0 <= idx < len(candidates) and available(candidates[idx].get('path'), project_id)
            if not valid:
                update(f'正在生成第 {i} 页第 {panel["panel_order"]} 格画面')
                if not child(image.handle, panel_ref=panel_ref, count=1):
                    return {'cancelled': True}
                art = A.current(session, project_id, 'image', panel_ref)
                p = (art.payload or {}) if art else {}
                idx, candidates = p.get('selected_index'), p.get('candidates') or []
                if not art or art.status != 'approved' or type(idx) is not int or not 0 <= idx < len(candidates) or not available(candidates[idx].get('path'), project_id):
                    raise ValueError(f'{panel_ref} 没有可采用的画面，请检查出图服务后重试。')
        update(f'已完成第 {i}/{target} 页画面', 1 + target + i)
    for i, ref in enumerate(pages, 1):
        art = A.current(session, project_id, 'page_image', ref)
        if not art or art.status != 'approved' or (art.payload or {}).get('auto_run') != run_id or not available(art.path, project_id):
            update(f'正在拼合第 {i}/{target} 页')
            if not child(compose.handle, page_ref=ref):
                return {'cancelled': True}
            art = A.current(session, project_id, 'page_image', ref)
            if not art or art.status != 'approved' or not available(art.path, project_id):
                raise ValueError(f'{ref} 合成失败，请检查漫画编辑器服务后重试。')
        update(f'已拼合第 {i}/{target} 页', 1 + target * 2 + i)
    return {'pages': pages, 'message': '漫画页已生成，可以查看和导出。'}
