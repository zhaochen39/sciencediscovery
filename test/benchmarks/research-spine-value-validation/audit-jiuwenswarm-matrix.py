#!/usr/bin/env python3
"""Audit new JiuwenSwarm runs. Incomplete comparisons remain in the report."""
import argparse
import hashlib
import json
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def audit_arm(path, cohort, arm):
    exit_file = path / "exit-code.txt"
    result_file = path / "result.json"
    result = read_json(result_file) if result_file.is_file() else {}
    entry = {"exit": int(exit_file.read_text()) if exit_file.is_file() else None, "pass": False}
    if entry["exit"] != 0 or result.get("pass") is not True:
        entry["run_status"] = {name: item["run"]["status"] for name, item in result.get("measurements", {}).items()}
        return entry
    adapter = result["adapter"]
    assert adapter["executor"] == "jiuwenswarm" and adapter["jiuwenswarm"]["reachable"]
    assert (result["arm"] == "original") == (arm == "original")
    assert result["spineEnabled"] == (arm in ("candidate", "candidate-no-fold"))
    if cohort.startswith("tree-") and "fold" in result:
        assert result["foldEnabled"] == (arm == "candidate")
        data = Path((path / "data-dir.txt").read_text().strip())
        archive, = data.glob("projects/*/sessions/*/workspace/assay-archive.tsv")
        payload = archive.read_bytes()
        assert hashlib.sha256(payload).hexdigest() == result["fold"]["archiveSha256"]
        assert result["fold"]["actual"] == f"ASSAY/{2 * len(payload.splitlines())}"
    stream = []
    folded = []
    projection_ms = []
    driver = path / "driver.log"
    for line in driver.read_text(encoding="utf-8").splitlines():
        if line.startswith("[model-sse-summary] "):
            record = json.loads(line.removeprefix("[model-sse-summary] "))
            if record.get("purpose") == "task":
                stream.append(record)
        if line.startswith("[model-stream] "):
            record = json.loads(line.removeprefix("[model-stream] "))
            if record.get("phase") == "history_projection":
                projection_ms.append(record["projectionMs"])
        if line.startswith("[swarm-spine] "):
            record = json.loads(line.removeprefix("[swarm-spine] "))
            if record["event"] == "scope.closed_evidence.folded":
                folded.append(record)
    metrics = {}
    for name, measurement in result["measurements"].items():
        assert measurement["run"]["status"] == "completed"
        usage = measurement["usage"]["byRun"]
        records = measurement["usage"]["invocations"]
        assert all(row["usageStatus"] == "reported" for row in records)
        stage = {key: usage.get(key) for key in ("inputTokens", "outputTokens", "totalTokens", "cacheReadTokens")}
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            assert stage[key] == sum(row[key] for row in records)
        stage["modelRequests"] = sum(row.get("turnsRecorded", 1) for row in records)
        stage["shellExecutions"] = len(measurement["executions"])
        stage["elapsedMs"] = measurement["elapsedMs"]
        metrics[name] = stage
    if projection_ms:
        entry["projectionMs"] = projection_ms
    if "rollback" in result:
        assert result["rollback"] == {"completed": True, "oldScopeRetained": True}
        assert "scope-rollback" in metrics
        entry["rollbackVerified"] = True
    if "evolve" in result:
        entry["evolve"] = result["evolve"]
    if result.get("frozenFollowup"):
        entry["archiveHashes"] = sorted(result["sourceArchiveHashes"])
    if "scope-followup" in metrics and metrics["scope-followup"]["modelRequests"] == 1 and stream:
        entry["followupProvider"] = {key: stream[-1].get(key) for key in ("elapsedMs", "timeToFirstByteMs", "attempts", "retries", "retryErrors")}
    if "fold" in result:
        entry["foldedTurns"] = [row["turn"] for row in folded]
        entry["projectionVerified"] = bool(folded) == result["foldEnabled"]
        if result["modelMode"] == "controlled" and arm != "original":
            proof = result["foldPayload"]
            assert proof == {"folded": result["foldEnabled"], "retainedStdout": not result["foldEnabled"]}
            entry["modelPayloadVerified"] = True
            entry["controlledHistoryBytes"] = [row["messageBytes"] for row in result["observed"]]
    entry.update({"pass": True, "model": result["model"], "metrics": metrics})
    return entry


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("batch", type=Path)
args = parser.parse_args()
report = {}
for cohort in sorted(path for path in args.batch.iterdir() if path.is_dir()):
    arms = {arm.name: audit_arm(arm, cohort.name, arm.name) for arm in sorted(cohort.iterdir()) if arm.is_dir()}
    hashes = [arm["archiveHashes"] for arm in arms.values() if "archiveHashes" in arm]
    if hashes:
        assert all(row == hashes[0] for row in hashes)
    expected = {"original", "candidate", "candidate-no-fold" if "candidate-no-fold" in arms else "candidate-off"}
    report[cohort.name] = {
        "allArmsPassed": arms.keys() == expected and all(arm["pass"] and arm.get("projectionVerified", True) for arm in arms.values()),
        "arms": arms,
    }
print(json.dumps(report, indent=2))
