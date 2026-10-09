"""工作流参数映射与应用。

职责：
1. ``guess_mapping`` —— 读一份 API 格式工作流，按 ``class_type`` 自动初猜
   “参数 → 节点/字段”，产出一张可人工修改的映射表。
2. ``apply``        —— 往工作流副本里写入参数值、替换占位符、挂载 LoRA
   （支持“多 LoraLoader 串联”与“LoRA 堆加载节点”两种写法），
   返回可直接 POST 给 ComfyUI 的 API 工作流。

支持两种参数注入方式（可共存）：
- **占位符**：工作流里写着 ``%prompt%`` / ``%negative%``（沿用 MED 的写法），整体替换；
- **字段映射**：把 ``CLIPTextEncode.text`` 这类具体节点字段按映射表写入。

换工作流只改映射表/配置，不动代码。
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from ..config import LoraSlot, LoraStackSlot, LoraStacker, ParamBinding, WorkflowParams

# KSampler 家族（取第一个作为采样参数来源）
SAMPLER_CLASSES = ("KSampler", "KSamplerAdvanced", "KSamplerSelect")
LATENT_CLASSES = ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyLatentImagePresets", "EmptyLatentSDXL")
CKPT_CLASSES = ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader")
LORA_CLASSES = ("LoraLoader", "LoraLoaderModelOnly")
OUTPUT_CLASSES = ("SaveImage", "PreviewImage", "SaveImageWebsocket")

# 已知的“LoRA 堆加载”节点：一个节点内并排 N 个槽。
# rgthree 的 `Lora Loader Stack (rgthree)` 输入形如 lora_01 + strength_01（'None' 为空槽）。
LORA_STACKER_HINT = (
    "lora loader stack",
    "lora stack",
    "lorastack",
    "power lora loader",
    "lora堆",
)

# 槽名匹配：lora_01 / lora_1 / lora_name_1 / lora1 ...
_STACK_NAME_RE = re.compile(r"^(?:lora|lora_name|lora_loader)_?0*(\d+)$", re.IGNORECASE)
# 对应的权重名：strength_01 / strength_1 / weight_1 ...
_STACK_STRENGTH_RE = re.compile(r"^(?:strength|weight|model_weight|strength_model)_?0*(\d+)$", re.IGNORECASE)

# MED 的占位符写法（见编辑器的 comfyui-util.js）
PLACEHOLDER_PROMPT = "%prompt%"
PLACEHOLDER_NEGATIVE = "%negative%"


class WorkflowError(RuntimeError):
    pass


def load_workflow(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise WorkflowError(f"工作流文件不存在：{p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    return data


def is_api_format(wf: dict[str, Any]) -> bool:
    """API 格式：顶层是 {node_id: {class_type, inputs}}，没有 ``nodes`` 列表。"""
    if "nodes" in wf and isinstance(wf.get("nodes"), list):
        return False
    if not wf:
        return False
    first = next(iter(wf.values()))
    return isinstance(first, dict) and "class_type" in first


def _nodes_by_class(wf: dict[str, Any], classes: tuple[str, ...]) -> list[tuple[str, dict]]:
    return [(nid, n) for nid, n in wf.items() if n.get("class_type") in classes]


def _link_target(wf: dict[str, Any], link: Any) -> tuple[str, dict] | None:
    """把 ``[node_id, slot]`` 链接解析为 (node_id, node)。"""
    if not (isinstance(link, list) and len(link) >= 2):
        return None
    nid = str(link[0])
    node = wf.get(nid)
    if node is None:
        return None
    return nid, node


def detect_lora_stacker(wf: dict[str, Any]) -> LoraStacker | None:
    """找出 LoRA **堆加载**节点（一个节点里并排 N 个槽），如 rgthree 的 LoRA Loader Stack。

    判定：节点里有 ``lora_01`` 这类槽名，且不是普通 ``LoraLoader``。
    """
    for nid, node in wf.items():
        inputs = node.get("inputs") or {}
        pairs: dict[int, dict[str, str]] = {}
        for key in inputs:
            m = _STACK_NAME_RE.match(str(key))
            if not m:
                continue
            pairs.setdefault(int(m.group(1)), {})["name_input"] = str(key)
        for key in inputs:
            m = _STACK_STRENGTH_RE.match(str(key))
            if not m:
                continue
            pairs.setdefault(int(m.group(1)), {})["strength_input"] = str(key)
        if not pairs:
            continue
        # 填上缺失的权重名（按槽号推默认写法）
        slots: list[LoraStackSlot] = []
        for idx in sorted(pairs):
            p = pairs[idx]
            if "name_input" not in p:
                continue
            slots.append(
                LoraStackSlot(
                    name_input=p["name_input"],
                    strength_input=p.get("strength_input", ""),
                )
            )
        if not slots:
            continue
        empty = "None"
        for s in slots:
            v = inputs.get(s.name_input)
            if isinstance(v, str) and v.strip() == "":
                empty = ""
                break
        return LoraStacker(
            node_id=str(nid),
            class_type=str(node.get("class_type") or ""),
            slots=slots,
            empty_token=empty,
        )
    return None


def guess_mapping(wf: dict[str, Any]) -> WorkflowParams:
    """按 class_type 自动初猜参数映射，并识别占位符 / LoRA 堆加载。"""
    if not is_api_format(wf):
        raise WorkflowError(
            "工作流不是 ComfyUI API 格式（顶层应为 {node_id: {class_type, inputs}}）。"
            "请在 ComfyUI 里用「保存（API 格式）」重新导出，或先跑 scripts/convert_workflow.py 转换。"
        )

    params = WorkflowParams()
    bindings: dict[str, ParamBinding] = {}
    output_ids: list[str] = []

    # ---- 采样器：seed/steps/cfg/sampler/scheduler/denoise ----
    samplers = _nodes_by_class(wf, SAMPLER_CLASSES)
    if samplers:
        sid, snode = samplers[0]
        sinp = snode.get("inputs", {})
        # (工作流里的输入名, 我们的统一参数名)
        for wf_input, key in (
            ("seed", "seed"),
            ("steps", "steps"),
            ("cfg", "cfg"),
            ("sampler_name", "sampler"),
            ("scheduler", "scheduler"),
            ("denoise", "denoise"),
        ):
            if wf_input in sinp:
                vtype = "float" if key in ("cfg", "denoise") else ("int" if key in ("seed", "steps") else "str")
                bindings[key] = ParamBinding(node_id=str(sid), input_name=wf_input, value_type=vtype)

        # 正/负向提示词：顺着采样器的 positive / negative 链接找 CLIPTextEncode
        for cond_key, target in (("positive", "prompt_pos"), ("negative", "prompt_neg")):
            link = sinp.get(cond_key)
            resolved = _link_target(wf, link)
            if resolved:
                nid, node = resolved
                if "text" in (node.get("inputs") or {}):
                    bindings[target] = ParamBinding(node_id=str(nid), input_name="text")

    # 兜底：若没从链接找到，就按文本节点顺序挑两个
    if "prompt_pos" not in bindings:
        texts = [
            (nid, n)
            for nid, n in wf.items()
            if isinstance(n.get("inputs", {}).get("text"), str)
        ]
        if texts:
            bindings["prompt_pos"] = ParamBinding(node_id=str(texts[0][0]), input_name="text")
            if len(texts) > 1:
                bindings["prompt_neg"] = ParamBinding(node_id=str(texts[1][0]), input_name="text")

    # ---- 尺寸：latent 节点，或采样器的 latent_image 指向 ----
    latents = _nodes_by_class(wf, LATENT_CLASSES)
    if not latents and samplers:
        resolved = _link_target(wf, samplers[0][1].get("inputs", {}).get("latent_image"))
        if resolved and "width" in (resolved[1].get("inputs") or {}):
            latents = [resolved]
    if latents:
        lid, lnode = latents[0]
        linp = lnode.get("inputs", {})
        if "width" in linp:
            bindings["width"] = ParamBinding(node_id=str(lid), input_name="width", value_type="int")
        if "height" in linp:
            bindings["height"] = ParamBinding(node_id=str(lid), input_name="height", value_type="int")

    # ---- checkpoint ----
    for nid, node in _nodes_by_class(wf, CKPT_CLASSES):
        if "ckpt_name" in (node.get("inputs") or {}):
            bindings["ckpt_name"] = ParamBinding(node_id=str(nid), input_name="ckpt_name")
            break

    # ---- LoRA：优先识别堆加载节点，其次是多 LoraLoader 串联 ----
    stacker = detect_lora_stacker(wf)
    lora_slots = _detect_lora_chain(wf)

    # ---- 占位符：工作流里写了 %prompt% / %negative% 就记为占位符模式 ----
    if _contains_value(wf, PLACEHOLDER_PROMPT):
        params.prompt_placeholder = PLACEHOLDER_PROMPT
    if _contains_value(wf, PLACEHOLDER_NEGATIVE):
        params.negative_placeholder = PLACEHOLDER_NEGATIVE

    # ---- 输出节点 ----
    for nid, _ in _nodes_by_class(wf, OUTPUT_CLASSES):
        output_ids.append(str(nid))

    params.bindings = bindings
    params.lora_slots = lora_slots
    params.lora_stacker = stacker
    params.output_node_ids = output_ids
    return params


def _contains_value(wf: dict[str, Any], needle: str) -> bool:
    """工作流里是否有任意字符串字段包含 ``needle``（占位符探测）。"""
    def walk(obj: Any) -> bool:
        if isinstance(obj, str):
            return needle in obj
        if isinstance(obj, dict):
            return any(walk(v) for v in obj.values())
        if isinstance(obj, list):
            return any(walk(v) for v in obj)
        return False

    return walk(wf)


def _detect_lora_chain(wf: dict[str, Any]) -> list[LoraSlot]:
    """按 model 链接顺序找出 LoRA 串联链。"""
    lora_nodes = {nid: n for nid, n in wf.items() if n.get("class_type") in LORA_CLASSES}
    if not lora_nodes:
        return []

    # 每个 lora 的 model 输入若指向另一个 lora，则存在先后关系
    next_of: dict[str, str] = {}
    has_pred: set[str] = set()
    for nid, node in lora_nodes.items():
        link = (node.get("inputs") or {}).get("model")
        if isinstance(link, list) and str(link[0]) in lora_nodes:
            next_of[str(link[0])] = nid
            has_pred.add(nid)

    heads = [nid for nid in lora_nodes if nid not in has_pred]
    chain_ids: list[str] = []
    for head in heads:
        cur: str | None = head
        while cur is not None:
            if cur in chain_ids:
                break
            chain_ids.append(cur)
            cur = next_of.get(cur)

    slots: list[LoraSlot] = []
    for nid in chain_ids:
        node = lora_nodes[nid]
        inp = node.get("inputs", {})
        slots.append(
            LoraSlot(
                node_id=nid,
                name_input="lora_name",
                strength_model_input="strength_model" if "strength_model" in inp else "strength",
                strength_clip_input="strength_clip" if "strength_clip" in inp else "strength",
            )
        )
    return slots


# --------------------------------------------------------------------------
# 应用参数
# --------------------------------------------------------------------------
def _coerce(value: Any, value_type: str) -> Any:
    if value is None:
        return None
    if value_type == "int":
        return int(value)
    if value_type == "float":
        return float(value)
    if value_type == "bool":
        return bool(value)
    return str(value)


def _consumers_of(wf: dict[str, Any], link: list) -> list[tuple[str, str]]:
    """找出所有把 ``link`` 当作输入的 (node_id, input_name)。"""
    target_nid, target_slot = str(link[0]), link[1]
    out: list[tuple[str, str]] = []
    for nid, node in wf.items():
        for name, val in (node.get("inputs") or {}).items():
            if isinstance(val, list) and len(val) >= 2 and str(val[0]) == target_nid and val[1] == target_slot:
                out.append((nid, name))
    return out


def _next_node_id(wf: dict[str, Any]) -> int:
    ids = [int(k) for k in wf.keys() if str(k).isdigit()]
    return (max(ids) + 1) if ids else 1


def apply_loras(wf: dict[str, Any], loras: list[dict[str, Any]], slots: list[LoraSlot]) -> None:
    """就地把 LoRA 链写进工作流（原地修改传入的副本）。

    - ``loras`` 为空 -> 旁路整条 LoRA 链（模型/CLIP 直连）
    - 数量少于/等于现有槽 -> 复用并截断
    - 数量多于现有槽 -> 克隆节点续接
    """
    if not slots:
        if loras:
            raise WorkflowError("工作流里没有可用的 LoRA 节点，无法挂载 LoRA；请改用带 LoraLoader 的工作流")
        return

    chain = [s.node_id for s in slots]
    first = wf[chain[0]]
    model_entry = (first.get("inputs") or {}).get("model")
    clip_entry = (first.get("inputs") or {}).get("clip")
    tail = chain[-1]
    final_model_link = [tail, 0]
    final_clip_link = [tail, 1]

    # 记录 LoRA 链的最终消费者的“原引用”，便于旁路/截断时改写
    model_consumers = _consumers_of(wf, final_model_link)
    clip_consumers = _consumers_of(wf, final_clip_link)

    if not loras:
        # 旁路：消费者直连入口
        for nid, name in model_consumers:
            if model_entry is not None:
                wf[nid]["inputs"][name] = copy.deepcopy(model_entry)
        for nid, name in clip_consumers:
            if clip_entry is not None:
                wf[nid]["inputs"][name] = copy.deepcopy(clip_entry)
        for nid in chain:  # 移除整条链
            wf.pop(nid, None)
        return

    # 需要复用/扩展的 LoRA 槽
    needed = len(loras)
    # 槽不够就克隆最后一个节点续接
    while len(chain) < needed:
        prev = chain[-1]
        new_id = str(_next_node_id(wf))
        base = copy.deepcopy(wf[prev])
        wf[new_id] = base
        chain.append(new_id)
        slots.append(
            LoraSlot(
                node_id=new_id,
                name_input=slots[-1].name_input,
                strength_model_input=slots[-1].strength_model_input,
                strength_clip_input=slots[-1].strength_clip_input,
            )
        )

    # 槽多余就截断，并把消费者指到截断后的尾部
    if len(chain) > needed:
        removed = chain[needed:]
        for nid in removed:
            wf.pop(nid, None)
        chain = chain[:needed]
        new_tail = chain[-1]
        for nid, name in model_consumers:
            wf[nid]["inputs"][name] = [new_tail, 0]
        for nid, name in clip_consumers:
            wf[nid]["inputs"][name] = [new_tail, 1]

    # 写入每个槽的名称与权重，并重连链内上下游
    for i, lora in enumerate(loras):
        slot = slots[i]
        node = wf[slot.node_id]
        node.setdefault("inputs", {})
        node["inputs"][slot.name_input] = lora["name"]
        weight = lora.get("weight", 0.8)
        if slot.strength_model_input in node["inputs"] or slot.strength_model_input not in ("", None):
            node["inputs"][slot.strength_model_input] = weight
        if slot.strength_clip_input and slot.strength_clip_input != slot.strength_model_input:
            node["inputs"][slot.strength_clip_input] = weight
        # 链内连接
        if i == 0:
            if model_entry is not None:
                node["inputs"]["model"] = copy.deepcopy(model_entry)
            if clip_entry is not None and "clip" in node["inputs"]:
                node["inputs"]["clip"] = copy.deepcopy(clip_entry)
        else:
            node["inputs"]["model"] = [chain[i - 1], 0]
            if "clip" in node["inputs"]:
                node["inputs"]["clip"] = [chain[i - 1], 1]

    # 尾部消费者的引用修正（若之前因截断已改，这里保证一次正确）
    tail = chain[-1]
    for nid, name in model_consumers:
        if name in (wf[nid].get("inputs") or {}):
            wf[nid]["inputs"][name] = [tail, 0]
    for nid, name in clip_consumers:
        if name in (wf[nid].get("inputs") or {}):
            wf[nid]["inputs"][name] = [tail, 1]


def apply_lora_stacker(
    wf: dict[str, Any], loras: list[dict[str, Any]], stacker: LoraStacker
) -> None:
    """就地把 LoRA 写进「堆加载」节点：第 i 个 LoRA -> 第 i 个槽，空槽填 ``empty_token``。

    数量超过槽位时只取前 N 个（并在调用方提示）。
    """
    node = wf.get(str(stacker.node_id))
    if node is None:
        raise WorkflowError(f"LoRA 堆加载节点不存在：{stacker.node_id}")
    inputs = node.setdefault("inputs", {})
    for i, slot in enumerate(stacker.slots):
        if i < len(loras):
            lora = loras[i]
            inputs[slot.name_input] = lora["name"]
            if slot.strength_input:
                inputs[slot.strength_input] = lora.get("weight", 0.8)
        else:
            inputs[slot.name_input] = stacker.empty_token
            if slot.strength_input:
                inputs[slot.strength_input] = 0


def _replace_placeholders(obj: Any, mapping: dict[str, str]) -> None:
    """把 ``%prompt%`` / ``%negative%`` 这类占位符整体替换成实际文本（就地）。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                for token, text in mapping.items():
                    if token and token in v:
                        v = v.replace(token, text)
                obj[k] = v
            else:
                _replace_placeholders(v, mapping)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                for token, text in mapping.items():
                    if token and token in v:
                        v = v.replace(token, text)
                obj[i] = v
            else:
                _replace_placeholders(v, mapping)


def apply(
    wf: dict[str, Any],
    params: WorkflowParams,
    values: dict[str, Any],
    loras: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """生成可直接入队的工作流副本。

    ``values`` 键用统一词汇：prompt_pos / prompt_neg / seed / steps / cfg /
    sampler / scheduler / width / height / ckpt_name / denoise。

    注入顺序：
    1. 占位符替换（``%prompt%`` / ``%negative%``）；
    2. 字段映射写入（覆盖同名输入）；
    3. LoRA：优先堆加载节点，其次多 LoraLoader 串联。
    """
    out = copy.deepcopy(wf)

    # 1. 占位符
    repl: dict[str, str] = {}
    if params.prompt_placeholder and "prompt_pos" in values and values["prompt_pos"] is not None:
        repl[params.prompt_placeholder] = str(values["prompt_pos"])
    if params.negative_placeholder and "prompt_neg" in values and values["prompt_neg"] is not None:
        repl[params.negative_placeholder] = str(values["prompt_neg"])
    if repl:
        _replace_placeholders(out, repl)

    # 2. 字段映射
    for key, binding in params.bindings.items():
        if key not in values:
            continue
        val = values[key]
        if val is None:
            continue
        node = out.get(str(binding.node_id))
        if node is None:
            raise WorkflowError(f"映射表指向的节点不存在：{binding.node_id}（参数 {key}）")
        node.setdefault("inputs", {})
        node["inputs"][binding.input_name] = _coerce(val, binding.value_type)

    # 3. LoRA
    if params.lora_stacker is not None:
        apply_lora_stacker(out, loras or [], params.lora_stacker)
    else:
        apply_loras(out, loras or [], params.lora_slots)
    return out

