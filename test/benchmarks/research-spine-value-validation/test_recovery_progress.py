"""Regression tests for review ordering in the offline recovery audit."""

import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


spec = importlib.util.spec_from_file_location("report_paired", Path(__file__).with_name("report-paired.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class RecoveryProgressTest(unittest.TestCase):
    table = "site_id,valid_days\nsite-1,3"

    def audit(self, *calls, reviewed=False):
        with TemporaryDirectory() as directory:
            directory = Path(directory)
            run = directory / "run"
            workspace = run / "workspace"
            workspace.mkdir(parents=True)
            (workspace / "site_qc.csv").write_bytes(self.table.replace("\n", "\r\n").encode())
            (directory / "started-epoch-ms.txt").write_text("1000", encoding="utf-8")
            events = []
            for i, (changed, stdout, exit_code) in enumerate(calls, 2):
                timestamp = f"1970-01-01T00:00:0{i}+00:00"
                if exit_code is None:
                    events += [{"type": "tool_execution_start", "toolCallId": str(i), "toolName": "run_shell",
                                "args": {"scriptPath": "stage2.py"}},
                               {"type": "tool_execution_end", "toolCallId": str(i), "toolName": "run_shell",
                                "isError": True, "at": timestamp, "result": {"details": {"ok": False,
                                    "error": {"code": "TOOL_EXECUTION_FAILED", "message": stdout}}}}]
                    continue
                events += [{"type": "tool_execution_start", "toolCallId": str(i)},
                           {"type": "recovery_tool_artifacts", "toolCallId": str(i), "changedArtifacts": changed,
                            "exitCode": exit_code},
                           {"type": "tool_execution_end", "toolCallId": str(i), "at": timestamp,
                            "isError": exit_code != 0, "result": {"content": [{"text": stdout}]}}]
            (run / "events.jsonl").write_text("\n".join(map(json.dumps, events)), encoding="utf-8")
            return report.recovery_progress(directory, {"id": "run"}, reviewed)

    def test_pending_review_accepts_the_current_table_before_grouping(self):
        result = self.audit(([], self.table, 0), (["groups.json"], "", 0))
        self.assertEqual(result["first_tool"], "QC display")
        self.assertTrue(result["first_tool_progress"])
        self.assertEqual(result["extra_calls"], 0)
        self.assertEqual(result["progress_s"], 1)

    def test_rejects_late_combined_outdated_or_failed_display(self):
        group = (["groups.json"], "", 0)
        for calls in ((group, ([], self.table, 0)), ((["groups.json"], self.table, 0),),
                      (([], self.table.replace("site-1,3", "site-1,30"), 0), group),
                      (([], self.table, 1), group)):
            with self.subTest(calls=calls), self.assertRaisesRegex(ValueError, "earlier successful display"):
                self.audit(*calls)

    def test_counts_duplicate_probe_only_once(self):
        result = self.audit(([], self.table, 0), (["groups.json"], "", 0), reviewed=True)
        self.assertEqual((result["probe_calls"], result["duplicate_reads"], result["extra_calls"]), (1, 1, 1))
        self.assertEqual(result["progress_s"], 2)
        self.assertFalse(result["first_tool_progress"])

    def test_combined_grouping_and_repeated_display_counts_both_effects(self):
        result = self.audit((["groups.json"], self.table, 0), reviewed=True)
        self.assertEqual(result["first_tool"], "grouping write + QC display")
        self.assertTrue(result["first_tool_progress"])
        self.assertEqual((result["probe_calls"], result["duplicate_reads"], result["extra_calls"]), (0, 1, 1))

    def test_failed_grouping_write_does_not_count_as_first_tool_progress(self):
        result = self.audit((["groups.json"], "", 1), (["groups.json"], "", 0), reviewed=True)
        self.assertFalse(result["first_tool_progress"])
        self.assertEqual(result["progress_s"], 2)

    def test_rejected_script_path_counts_as_no_progress_with_strict_evidence(self):
        missing = "scriptPath does not exist in an authorized mount: stage2.py"
        group = (["groups.json"], "", 0)
        result = self.audit(([], missing, None), group, reviewed=True)
        self.assertFalse(result["first_tool_progress"])
        self.assertEqual(result["extra_calls"], 1)
        with self.assertRaisesRegex(ValueError, "tool receipt ledger"):
            self.audit(([], "A generic error after execution", None), group, reviewed=True)
