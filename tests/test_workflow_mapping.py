"""工作流参数映射与应用的自测（离线，用固定夹具）。

覆盖：
- ``guess_mapping`` 能按 class_type 找到正/负提示词、采样、尺寸、checkpoint、LoRA 链、输出节点
- ``apply`` 能写入提示词/seed/尺寸
- LoRA 串联能扩展槽位；``loras=[]`` 能整条旁路
- ``%prompt%`` 占位符模式；LoRA 堆加载（rgthree）模式的识别与写入
- UI 格式 → API 格式转换

运行：``.venv/Scripts/python.exe tests/test_workflow_mapping.py``
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.comfy.ui_convert import is_ui_format, ui_to_api  # noqa: E402
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


# LoRA 堆加载（rgthree 的 Lora Loader Stack）夹具
STACK_FIXTURE = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}},
    "22": {
        "class_type": "Lora Loader Stack (rgthree)",
        "inputs": {
            "model": ["1", 0], "clip": ["1", 1],
            "lora_01": "None", "strength_01": 1.0,
            "lora_02": "None", "strength_02": 1.0,
            "lora_03": "None", "strength_03": 1.0,
            "lora_04": "None", "strength_04": 1.0,
        },
    },
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%", "clip": ["22", 1]}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "%negative%", "clip": ["22", 1]}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    "6": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 0, "steps": 28, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal",
            "denoise": 1.0, "model": ["22", 0], "positive": ["3", 0], "negative": ["4", 0],
            "latent_image": ["5", 0],
        },
    },
    "8": {"class_type": "SaveImage", "inputs": {"filename_prefix": "anima", "images": ["6", 0]}},
}


def test_placeholder_detection() -> None:
    p = guess_mapping(STACK_FIXTURE)
    assert p.prompt_placeholder == "%prompt%", p.prompt_placeholder
    assert p.negative_placeholder == "%negative%", p.negative_placeholder
    print("  [ok] 识别 %prompt% / %negative% 占位符模式")


def test_lora_stacker() -> None:
    p = guess_mapping(STACK_FIXTURE)
    st = p.lora_stacker
    assert st is not None and st.node_id == "22", st
    assert [s.name_input for s in st.slots] == ["lora_01", "lora_02", "lora_03", "lora_04"], st.slots
    assert st.empty_token == "None"

    out = apply(
        STACK_FIXTURE, p,
        {"prompt_pos": "1girl, city", "prompt_neg": "lowres"},
        loras=[
            {"name": r"风格\style.safetensors", "weight": 0.7},
            {"name": r"角色\hero.safetensors", "weight": 1.1},
        ],
    )
    inp = out["22"]["inputs"]
    # 占位符被整体替换
    assert out["3"]["inputs"]["text"] == "1girl, city"
    assert out["4"]["inputs"]["text"] == "lowres"
    # 前两个槽写入，后两个槽空置
    assert inp["lora_01"] == r"风格\style.safetensors" and inp["strength_01"] == 0.7
    assert inp["lora_02"] == r"角色\hero.safetensors" and inp["strength_02"] == 1.1
    assert inp["lora_03"] == "None" and inp["lora_04"] == "None"
    assert STACK_FIXTURE["22"]["inputs"]["lora_01"] == "None", "原工作流不应被就地修改"
    print("  [ok] LoRA 堆加载：按槽写入 + 空槽回填 None + 占位符替换")


def test_ui_to_api() -> None:
    ui_wf = {
        "nodes": [
            {"id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["base.safetensors"]},
            {"id": 2, "type": "EmptyLatentImage", "widgets_values": [1024, 1536, 1]},
            {
                "id": 3, "type": "KSampler",
                "widgets_values": [123, "randomize", 26, 6, "euler", "karras", 1],
                "inputs": [{"name": "model", "link": 10}],
            },
            {"id": 4, "type": "SaveImage", "widgets_values": ["ComfyUI"],
             "inputs": [{"name": "images", "link": 11}]},
        ],
        "links": [
            [10, 1, 0, 3, 0, "MODEL"],
            [11, 3, 0, 4, 0, "IMAGE"],
        ],
    }
    assert is_ui_format(ui_wf)
    # object_info 的真实形状：["INT", {}] 标量、[["a","b"], {}] 下拉、"MODEL" 连线
    object_info = {
        "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["base.safetensors"], {}]}}},
        "EmptyLatentImage": {"input": {"required": {
            "width": ["INT", {}], "height": ["INT", {}], "batch_size": ["INT", {}]}}},
        "KSampler": {"input": {"required": {
            "model": "MODEL", "seed": ["INT", {}], "steps": ["INT", {}], "cfg": ["FLOAT", {}],
            "sampler_name": [["euler"], {}], "scheduler": [["normal"], {}],
            "positive": "CONDITIONING", "negative": "CONDITIONING",
            "latent_image": "LATENT", "denoise": ["FLOAT", {}],
        }}},
        "SaveImage": {"input": {"required": {"images": "IMAGE", "filename_prefix": ["STRING", {}]}}},
    }
    api, warnings = ui_to_api(ui_wf, object_info)
    assert warnings == [], warnings
    # seed 后的 control_after_generate 被跳过，后面的值不串位
    assert api["3"]["inputs"]["seed"] == 123
    assert api["3"]["inputs"]["steps"] == 26
    assert api["3"]["inputs"]["cfg"] == 6
    assert api["3"]["inputs"]["sampler_name"] == "euler"
    assert api["3"]["inputs"]["scheduler"] == "karras"
    assert api["3"]["inputs"]["denoise"] == 1
    assert api["3"]["inputs"]["model"] == ["1", 0], api["3"]["inputs"]
    assert api["1"]["inputs"]["ckpt_name"] == "base.safetensors"
    assert api["4"]["inputs"]["filename_prefix"] == "ComfyUI"
    assert is_api_format(api), "转换结果应被识别为 API 格式"
    print("  [ok] UI 格式 → API 格式：控件对位、seed 后 JS 控件跳过、连线保留")


def test_power_lora_loader() -> None:
    """Power Lora Loader（对象式槽）：识别槽数、写入、关掉的槽保留名字。"""
    wf = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "b.safetensors"}},
        "9": {
            "class_type": "Power Lora Loader (rgthree)",
            "inputs": {
                "model": ["1", 0], "clip": ["1", 1],
                "lora_1": {"on": False, "lora": "画风/A.safetensors", "strength": 0.9, "strengthTwo": None},
                "lora_2": {"on": True, "lora": "画风/B.safetensors", "strength": 0.5, "strengthTwo": None},
            },
        },
        "6": {"class_type": "KSampler", "inputs": {"seed": 1, "model": ["9", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["6", 0]}},
    }
    p = guess_mapping(wf)
    st = p.lora_stacker
    assert st is not None and st.style == "dict", st
    assert [s.name_input for s in st.slots] == ["lora_1", "lora_2"], st.slots

    out = apply(wf, p, {"prompt_pos": "x", "prompt_neg": "y"}, loras=[{"name": "角色/C.safetensors", "weight": 1.2}])
    inp = out["9"]["inputs"]
    assert inp["lora_1"] == {"on": True, "lora": "角色/C.safetensors", "strength": 1.2, "strengthTwo": None}, inp["lora_1"]
    # 多余槽关闭，但保留作者原来的 lora 名
    assert inp["lora_2"]["on"] is False and inp["lora_2"]["lora"] == "画风/B.safetensors", inp["lora_2"]
    print("  [ok] Power Lora Loader：对象式槽按序写入，多余槽关掉且保留名字")


if __name__ == "__main__":
    print("工作流参数映射自测：")
    test_guess_mapping()
    test_apply_values()
    test_lora_bypass()
    test_lora_multi()
    test_placeholder_detection()
    test_lora_stacker()
    test_power_lora_loader()
    test_ui_to_api()
    print("全部通过 ✅")
