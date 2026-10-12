"""启动工具安全回归：所有进程、网络、浏览器入口使用 mock。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import start_all, tavern_bridge


class StartupSafetyTests(unittest.TestCase):
    def test_legacy_cleaners_never_scan_or_kill(self):
        with patch.object(start_all.subprocess, "run") as run, \
             patch.object(Path, "rglob") as scan, patch.object(Path, "unlink") as unlink:
            self.assertEqual(start_all.kill_existing(False), 0)
            self.assertEqual(start_all.kill_orphan_browsers(False), 0)
            self.assertEqual(tavern_bridge.clean_empty_chats(False), 0)
            run.assert_not_called()
            scan.assert_not_called()
            unlink.assert_not_called()

    def test_short_and_malformed_chats_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="safety-", dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            content = {"empty.jsonl": b"", "meta.jsonl": b'{"chat_metadata":{}}\n',
                       "bad.jsonl": b"invalid\xff", "message.jsonl": b'{"mes":"keep"}\n'}
            for name, data in content.items():
                (root / name).write_bytes(data)
            tavern_bridge.clean_empty_chats(False)
            self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, content)

    def test_stop_option_has_no_process_or_network_side_effects(self):
        with patch.object(sys, "argv", ["start_all.py", "--stop"]), \
             patch.object(start_all, "start_backend") as start, \
             patch.object(start_all, "wait_backend") as wait, \
             patch.object(start_all.subprocess, "run") as run:
            self.assertEqual(start_all.main(), 2)
            start.assert_not_called()
            wait.assert_not_called()
            run.assert_not_called()

    def test_existing_backend_is_left_alone(self):
        with patch.object(sys, "argv", ["start_all.py"]), \
             patch.object(start_all, "wait_backend", return_value=True), \
             patch.object(start_all, "start_backend") as backend, \
             patch.object(start_all, "start_bridge") as bridge:
            self.assertEqual(start_all.main(), 1)
            backend.assert_not_called()
            bridge.assert_not_called()

    def test_failure_only_stops_child_created_by_this_invocation(self):
        child, unrelated = Mock(), Mock()
        child.poll.return_value = None
        with patch.object(sys, "argv", ["start_all.py"]), \
             patch.object(start_all, "wait_backend", side_effect=[False, False]), \
             patch.object(start_all, "start_backend", return_value=child), \
             patch.object(start_all, "start_bridge") as bridge:
            self.assertEqual(start_all.main(), 1)
            child.terminate.assert_called_once()
            unrelated.terminate.assert_not_called()
            bridge.assert_not_called()

    def test_exited_child_is_not_signalled(self):
        child = Mock()
        child.poll.return_value = 0
        start_all.stop_owned([child])
        child.terminate.assert_not_called()
        child.kill.assert_not_called()

    def test_ctrl_c_only_stops_children_from_this_invocation(self):
        backend, bridge, unrelated = Mock(), Mock(), Mock()
        backend.poll.return_value = bridge.poll.return_value = None
        with patch.object(sys, "argv", ["start_all.py"]), \
             patch.object(start_all, "wait_backend", side_effect=[False, True]), \
             patch.object(start_all, "start_backend", return_value=backend), \
             patch.object(start_all, "start_bridge", return_value=bridge), \
             patch.object(start_all.time, "sleep", side_effect=KeyboardInterrupt):
            self.assertEqual(start_all.main(), 0)
        backend.terminate.assert_called_once()
        bridge.terminate.assert_called_once()
        unrelated.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
