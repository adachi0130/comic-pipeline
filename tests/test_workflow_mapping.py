"""工作流参数映射与应用的自测（离线，用固定夹具）。

覆盖：
- ``guess_mapping`` 能按 class_type 找到正/负提示词、采样、尺寸、checkpoint、LoRA 链、输出节点
- ``apply`` 能写入提示词/seed/尺寸
- LoRA 串联能扩展槽位；``loras=[]`` 能整条旁路

运行：``.venv/Scripts/python.exe tests/test_workflow_mapping.py``
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.comfy.workflow import apply, guess_mapping, is_api_format  # noqa: E402

FIXTURE = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "animaBase.safetensors"}},
    "2": {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": "protagonist.safetensors",
            "strength_model": 0.8,
            "strength_clip": 0.8,
        },
    },
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%", "clip": ["2", 1]}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "%negative%", "clip": ["2", 1]}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    "6": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 0,
            "steps": 28,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
            "model": ["2", 0],
            "positive": ["3", 0],
            "negative": ["4", 0],
            "latent_image": ["5", 0],
        },
    },
    "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
    "8": {"class_type": "SaveImage", "inputs": {"filename_prefix": "anima", "images": ["7", 0]}},
}


def test_guess_mapping() -> None:
    assert is_api_format(FIXTURE), "夹具应被识别为 API 格式"
    p = guess_mapping(FIXTURE)
    b = p.bindings
    assert b["prompt_pos"].node_id == "3", b.get("prompt_pos")
    assert b["prompt_neg"].node_id == "4", b.get("prompt_neg")
    assert b["seed"].node_id == "6" and b["seed"].input_name == "seed"
    assert b["steps"].value_type == "int"
    assert b["sampler"].input_name == "sampler_name"
    assert b["width"].node_id == "5" and b["height"].node_id == "5"
    assert b["ckpt_name"].node_id == "1"
    assert [s.node_id for s in p.lora_slots] == ["2"], p.lora_slots
    assert p.output_node_ids == ["8"], p.output_node_ids
    print("  [ok] guess_mapping 找到全部关键节点")


def test_apply_values() -> None:
    p = guess_mapping(FIXTURE)
    out = apply(
        FIXTURE,
        p,
        {
            "prompt_pos": "1girl, night city",
            "prompt_neg": "lowres",
            "seed": 12345,
            "steps": 30,
            "width": 1024,
            "height": 1536,
        },
        loras=[],
    )
    assert out["3"]["inputs"]["text"] == "1girl, night city"
    assert out["4"]["inputs"]["text"] == "lowres"
    assert out["6"]["inputs"]["seed"] == 12345
    assert out["6"]["inputs"]["steps"] == 30
    assert out["5"]["inputs"]["width"] == 1024 and out["5"]["inputs"]["height"] == 1536
    # 原夹具未被就地污染
    assert FIXTURE["3"]["inputs"]["text"] == "%prompt%"
    print("  [ok] apply 写入提示词/seed/尺寸，且不修改原工作流")


def test_lora_bypass() -> None:
    p = guess_mapping(FIXTURE)
    out = apply(FIXTURE, p, {"prompt_pos": "x", "prompt_neg": "y"}, loras=[])
    assert "2" not in out, "旁路时应移除 LoRA 节点"
    assert out["6"]["inputs"]["model"] == ["1", 0], out["6"]["inputs"]["model"]
    assert out["3"]["inputs"]["clip"] == ["1", 1], out["3"]["inputs"]["clip"]
    assert out["4"]["inputs"]["clip"] == ["1", 1]
    print("  [ok] loras=[] 整条旁路，模型/CLIP 直连 checkpoint")


def test_lora_multi() -> None:
    p = guess_mapping(FIXTURE)
    out = apply(
        FIXTURE,
        p,
        {"prompt_pos": "x", "prompt_neg": "y"},
        loras=[
            {"name": "protagonist.safetensors", "weight": 0.75},
            {"name": "style.safetensors", "weight": 1.0},
        ],
    )
    assert out["2"]["inputs"]["lora_name"] == "protagonist.safetensors"
    assert out["2"]["inputs"]["strength_model"] == 0.75
    # 新增的第二个 LoRA 槽
    extra = [nid for nid in out if out[nid]["class_type"] == "LoraLoader" and nid != "2"]
    assert len(extra) == 1, f"应新增 1 个 LoRA 节点，实际 {extra}"
    new_id = extra[0]
    assert out[new_id]["inputs"]["lora_name"] == "style.safetensors"
    # 链尾接续：KSampler 的 model 与 CLIP 的 clip 都指向新节点
    assert out["6"]["inputs"]["model"] == [new_id, 0], out["6"]["inputs"]["model"]
    assert out["3"]["inputs"]["clip"] == [new_id, 1]
    print("  [ok] 多 LoRA 串联：复用+新增槽位并重连链路")


if __name__ == "__main__":
    print("工作流参数映射自测：")
    test_guess_mapping()
    test_apply_values()
    test_lora_bypass()
    test_lora_multi()
    print("全部通过 ✅")
