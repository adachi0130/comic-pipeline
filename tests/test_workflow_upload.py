"""本地上传与真实参数应用回归：临时配置、内存数据库，不启动应用或访问 ComfyUI。"""
from __future__ import annotations

import atexit
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
_import_tmp = tempfile.TemporaryDirectory(prefix="upload-import-", dir=Path(__file__).parent)
atexit.register(_import_tmp.cleanup)
with patch.dict(os.environ, {"COMIC_DATA_DIR": str(Path(_import_tmp.name) / "data"),
                             "COMIC_DB_URL": "sqlite:///:memory:"}):
    from app.api.routes import comfy as routes
    from app.comfy import service, store
    from app.comfy.client import ComfyError
    from app.comfy.workflow import apply, describe_workflow, guess_mapping

from fastapi import FastAPI
from fastapi.testclient import TestClient

WORKFLOW = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}},
    "2": {"class_type": "LoraLoader", "inputs": {
        "model": ["1", 0], "clip": ["1", 1], "lora_name": "角色.safetensors",
        "strength_model": 0.7, "strength_clip": 0.4,
    }},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 1], "text": "masterpiece, %prompt%, comic"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 1], "text": "lowres, %negative%"}},
    "5": {"class_type": "KSampler", "inputs": {
        "positive": ["3", 0], "negative": ["4", 0], "model": ["2", 0], "seed": 1,
    }},
    "6": {"class_type": "SaveImage", "inputs": {"images": ["5", 0], "filename_prefix": "comic"}},
}


class WorkflowUploadTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="workflow-upload-", dir=Path(__file__).parent)
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for target, value in (("WORKFLOW_DIR", self.root / "workflows"),
                              ("COMFY_CONFIG_PATH", self.root / "comfy.yaml")):
            patched = patch.object(store, target, value)
            patched.start()
            self.addCleanup(patched.stop)
        service._params_cache = None
        self.addCleanup(setattr, service, "_params_cache", None)
        # 网络必须显式 mock；API 格式上传和重新打开都不应触发调用。
        network = patch.object(routes, "_client_from", side_effect=AssertionError("不允许访问网络"))
        network.start()
        self.addCleanup(network.stop)
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_preview_is_offline_and_does_not_save(self):
        response = self.client.post("/api/comfy/workflows/preview", json={"name": "我的 工作流.json", "workflow": WORKFLOW})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["name"], "我的_工作流")
        self.assertEqual(data["resolved"]["prompt_pos"]["placeholder"], "%prompt%")
        self.assertEqual(data["resolved"]["prompt_neg"]["node_id"], "4")
        self.assertEqual(data["describe"]["lora"]["slots"][0]["lora"], "角色.safetensors")
        self.assertEqual(store.list_workflows(), [])
        self.assertFalse(store.COMFY_CONFIG_PATH.exists())

    def test_invalid_json_and_node_shapes_are_rejected(self):
        for workflow in ([], None, "{", "[]", {}, {"1": {"class_type": "CLIPTextEncode"}},
                         {**WORKFLOW, "broken": 123}):
            with self.subTest(workflow=workflow):
                response = self.client.post("/api/comfy/workflows/preview", json={"workflow": workflow})
                self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(store.list_workflows(), [])

    def test_save_activate_reload_and_submit_edited_template(self):
        response = self.client.post("/api/comfy/workflows", json={
            "name": "我的 工作流.json", "workflow": WORKFLOW, "activate": True,
        })
        self.assertEqual(response.status_code, 200, response.text)
        name = response.json()["name"]
        self.assertEqual(name, "我的_工作流")
        self.assertEqual(store.load_comfy_config().workflow_name, name)
        reopened = self.client.get(f"/api/comfy/workflows/{name}/inspect").json()
        self.assertEqual(reopened["workflow"], WORKFLOW)
        client = Mock()
        client.collect_images.return_value = []
        service.generate(service.GenRequest(prompt_pos="rainy city", prompt_neg="blur",
                                            loras=[{"name": "新角色.safetensors", "weight": 0.9, "weight_clip": 0.3}]), client=client)
        submitted = client.queue_prompt.call_args.args[0]
        self.assertEqual(submitted["3"]["inputs"]["text"], "masterpiece, rainy city, comic")
        self.assertEqual(submitted["4"]["inputs"]["text"], "lowres, blur")
        self.assertEqual(submitted["2"]["inputs"]["strength_clip"], 0.3)
        self.assertEqual(store.load_workflow_json(name), WORKFLOW)

    def test_duplicate_upload_gets_new_name_and_preserves_existing(self):
        store.save_workflow_json("comic", WORKFLOW)
        preview = self.client.post("/api/comfy/workflows/preview", json={"name": "comic.json", "workflow": WORKFLOW})
        self.assertEqual(preview.json()["name"], "comic_2")
        response = self.client.post("/api/comfy/workflows", json={
            "name": "comic", "workflow": {"1": {"class_type": "New", "inputs": {}}}, "overwrite": False,
        })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(store.load_workflow_json("comic"), WORKFLOW)

    def test_ui_upload_uses_node_definitions_and_preserves_placeholders(self):
        ui = {"nodes": [{"id": 3, "type": "CLIPTextEncode", "inputs": [],
                         "widgets_values": ["fixed, %prompt%"]}], "links": []}
        info = {"CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}]}}}}
        with patch.object(routes, "_client_from", return_value=Mock(object_info=Mock(return_value=info))):
            response = self.client.post("/api/comfy/workflows/preview", json={"workflow": ui})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ui_format"])
        self.assertEqual(response.json()["workflow"]["3"]["inputs"]["text"], "fixed, %prompt%")
        with patch.object(routes, "_client_from", return_value=Mock(object_info=Mock(side_effect=ComfyError("offline")))):
            response = self.client.post("/api/comfy/workflows/preview", json={"workflow": ui})
        self.assertEqual(response.status_code, 400)
        self.assertIn("API 格式", response.json()["detail"])

    def test_embedded_multiple_placeholders_empty_negative_and_old_bindings(self):
        wf = copy.deepcopy(WORKFLOW)
        wf["3"]["inputs"]["text"] += ", %prompt%"
        params = guess_mapping(wf)
        # 旧的字段映射保留兼容性，但不能覆盖占位符周围的固定文本。
        self.assertIn("prompt_pos", params.bindings)
        out = apply(wf, params, {"prompt_pos": "city", "prompt_neg": ""}, [])
        self.assertEqual(out["3"]["inputs"]["text"], "masterpiece, city, comic, city")
        self.assertEqual(out["4"]["inputs"]["text"], "lowres, ")
        self.assertEqual(wf["3"]["inputs"]["text"], "masterpiece, %prompt%, comic, %prompt%")

    def test_replacement_does_not_interpret_tokens_in_user_input(self):
        out = apply(WORKFLOW, guess_mapping(WORKFLOW), {"prompt_pos": "literal %negative%", "prompt_neg": "blur"}, [])
        self.assertEqual(out["3"]["inputs"]["text"], "masterpiece, literal %negative%, comic")

    def test_chain_loras_and_power_loader_are_described_together(self):
        wf = copy.deepcopy(WORKFLOW)
        wf["7"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["2", 0], "lora_name": "style.safetensors", "strength_model": 0,
        }}
        slots = describe_workflow(wf)["lora"]["slots"]
        self.assertEqual([slot["node_id"] for slot in slots], ["2", "7"])
        self.assertFalse(slots[1]["on"])
        wf["2"]["inputs"]["strength_model"] = 0
        self.assertTrue(describe_workflow(wf)["lora"]["slots"][0]["on"])
        wf = {"1": {"class_type": "Power Lora Loader (rgthree)", "inputs": {
            "lora_1": {"on": True, "lora": "a.safetensors", "strength": 0.7, "strengthTwo": 0.2},
        }}}
        self.assertEqual(describe_workflow(wf)["lora"]["slots"][0]["strength_clip"], 0.2)
        out = apply(wf, guess_mapping(wf), {}, [{"name": "b.safetensors", "weight": 0, "weight_clip": 0.1}])
        self.assertEqual(out["1"]["inputs"]["lora_1"]["strength"], 0)
        self.assertEqual(out["1"]["inputs"]["lora_1"]["strengthTwo"], 0.1)


if __name__ == "__main__":
    unittest.main()
