"""Audit finalized JiuwenSwarm comparison arms and compute paired changes."""
import argparse
import json
import re
import statistics
import unicodedata
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def normalized(text):
    return " ".join(unicodedata.normalize("NFKC", text).lower().split())


def expected(fixture):
    metadata = read_json(fixture / "doi_metadata.json")
    bibliography = read_json(fixture / "bibliography.json")
    sources = {row["doi"].lower(): row for row in metadata}
    audit = []
    for entry in bibliography:
        doi = entry["doi"].lower()
        source = sources.get(doi)
        title = normalized(entry["title"]) == normalized(source["title"]) if source else None
        year = entry["year"] == source["year"] if source else None
        status = "unresolved" if source is None else "match" if title and year else "mismatch"
        audit.append(dict(doi=doi, title_match=title, year_match=year, status=status))
    summary = {"total": len(audit)}
    summary.update({key: sum(row["status"] == key for row in audit) for key in ("match", "mismatch", "unresolved")})
    return audit, summary


def audit_receipt(result):
    children = result["children"]
    children_by_id = {child["id"]: child for child in children}
    assert len(children) == len(children_by_id) == 2
    completed = sorted(child["structuredResult"]["value"] for child in children if child["status"] == "completed")
    assert result["receiptModelInvocationsAdded"] == 0
    if result["modelMode"] == "controlled":
        assert completed == [14]
        assert all("must be number" in child["error"] for child in children if child["status"] == "failed")
        assert sorted(child["status"] for child in children) == ["completed", "failed"]
        assert "fail" in result["receiptParentAnswer"].lower()
    else:
        assert completed == [14, 21]
        assert "21" in result["receiptParentAnswer"]
    assert "14" in result["receiptParentAnswer"]
    if result["arm"] == "candidate":
        assert result["receiptCasVerified"] and result["receipt"]["ref"]["digest"]
        branches = {branch["childId"]: branch for branch in result["receipt"]["branches"]}
        assert set(branches) == set(children_by_id)
        for child_id, child in children_by_id.items():
            branch = branches[child_id]
            assert branch["status"] == child["status"]
            if child["status"] == "completed":
                assert branch["resultRef"]["digest"]
            else:
                assert branch["error"] == child["error"]
    else:
        assert "childRecordsReopenedMs" in result


def read_trajectory(directory, run_id):
    """Follow request -> revision -> model-call snapshots without using benchmark assertions."""
    root = Path((directory / "data-dir.txt").read_text().strip())
    pool = root / "versioning" / "agent-state" / "blobs" / "sha256"
    records = []
    for path in pool.iterdir():
        try:
            record = read_json(path)
        except (ValueError, UnicodeError):
            continue
        if isinstance(record, dict) and "kind" in record and "value" in record:
            records.append(record)
    trajectory, = {record["value"]["trajectoryId"] for record in records
                   if record["kind"] == "AgentRevision" and record["value"].get("requestExecutionId") == run_id}
    steps = sorted((record["value"] for record in records if record["kind"] == "TrajectoryStep"
                    and record["value"]["trajectoryId"] == trajectory), key=lambda step: step["turn"])
    assert steps
    snapshots = [read_json(pool / step["modelContext"]["digest"].split(":", 1)[1])["value"]["input"] for step in steps]
    return trajectory, snapshots


def context_evidence(directory, result, is_scope, fixture):
    stage = "scope-followup" if is_scope else "continuation"
    run_id = result["measurements"][stage]["run"]["id"]
    trajectory, snapshots = read_trajectory(directory, run_id)
    spine = result.get("spineEnabled", False)
    if is_scope:
        needle = "ROUND_ONE_ARCHIVE_ROW_31"
    else:
        rows = read_json(fixture / "doi_metadata.json")
        needle = "doi\ttitle\tyear\n" + "\n".join(f"{row['doi'].lower()}\t{row['title']}\t{row['year']}" for row in rows)
    details = []
    for request in snapshots:
        history = request["history"]
        visible = "\n".join(message["content"] for message in history if isinstance(message.get("content"), str))
        raw_evidence = any(needle in (message.get("content") or "") for message in history if message["role"] == "tool")
        projection = "<scope_node_memory " in visible
        if is_scope:
            assert "FROZEN" in visible and "Give the exact code prefix" in visible
            assert projection == spine and raw_evidence != spine
        details.append({"messages": len(history), "historyBytes": len(json.dumps(history, ensure_ascii=False).encode()),
                        "toolDefinitions": len(request["tools"]), "archiveEvidenceInToolOutput": raw_evidence,
                        "scopeProjection": projection})
    if not is_scope and spine:
        driver = (directory / "driver.log").read_text(encoding="utf-8")
        recovery = [json.loads(line.removeprefix("[swarm-spine] ")) for line in driver.splitlines() if line.startswith("[swarm-spine] ")]
        assert recovery and all(event["runId"] == trajectory for event in recovery)
        if result.get("recoveryMode") == "full":
            assert all(request["archiveEvidenceInToolOutput"] for request in details)
        else:
            assert not details[-1]["archiveEvidenceInToolOutput"]
        inline_id = result["measurements"]["inline"]["run"]["id"]
        _, inline_requests = read_trajectory(directory, inline_id)
        assert all(not any(re.match(r"^(?:task(?:_tool)?$|subagent_)", tool["name"]) for tool in request["tools"])
                   for request in inline_requests)
    return details


def audit_arm(directory, fixture, is_scope=False, scope_product=None):
    result = read_json(directory / "result.json")
    assert result["pass"] and (directory / "exit-code.txt").read_text().strip() == "0"
    assert result["adapter"]["executor"] == "jiuwenswarm" and result["adapter"]["jiuwenswarm"]["reachable"]
    driver = (directory / "driver.log").read_text(encoding="utf-8")
    spine = result.get("spineEnabled", False)
    spine_events = [json.loads(line.removeprefix("[swarm-spine] ")) for line in driver.splitlines() if line.startswith("[swarm-spine] ")]
    if scope_product in {"idea", "evolve"}:
        proof = result[scope_product]
        if spine:
            assert proof["linked"] and proof["restartStable"] and proof["foreignRejected"]
        if scope_product == "idea":
            assert proof["researchStatus"] == "completed" and proof["candidates"]
            root = Path((directory / "data-dir.txt").read_text().strip()) / "idea-engine" / "idea-research"
            state_file, = list(root.glob(f"*/{proof['sessionId']}/{proof['researchId']}.json"))
            persisted = read_json(state_file)
            assert persisted["status"] == "completed"
            candidates = [{key: node.get(key) for key in ("id", "score", "status")}
                          for node in persisted["nodes"] if node["kind"] == "candidate"]
            assert candidates == proof["candidates"]
            if result["modelMode"] == "controlled":
                assert candidates[0]["score"] == 7
        else:
            assert proof["status"] == "succeeded"
            root = Path((directory / "data-dir.txt").read_text().strip()) / "evolution" / "runs" / proof["searchId"]
            search = read_json(root / "run.json")
            assert search["sessionId"] == proof["sessionId"] and search["status"] == "succeeded"
            events = [json.loads(line)["event"] for line in (root / "events.ndjson").read_text().splitlines() if line]
            assert any(event["type"] == "seeded" and event["baselineScore"] == 0.4 for event in events)
            assert max(event["score"] for event in events if event["type"] == "expanded" and event["valid"]) == proof["best"]
            if result["modelMode"] == "controlled":
                assert proof["best"] == 0.54 and proof["searchRequests"] == 4
    elif scope_product:
        proof = result["tree"]
        assert proof["expected"] == proof["actual"] == "ASSAY/36"
        if spine:
            assert proof["restartStable"]
            if scope_product == "tree":
                assert proof["sequence"] == 3 and proof["childScopes"] == 2 and proof["unknownNodeRejected"]
            if scope_product in {"observe", "graph"}:
                assert proof["observedToolCount"] == (2 if scope_product == "graph" else 1)
            if scope_product == "graph":
                assert result["scopeGraph"]["edgeValidated"] and result["scopeGraph"]["reverseChecked"]
            if scope_product == "native-receipt":
                child, = proof["receipt"]["branches"]
                assert child["status"] == "completed" and child["executor"] == "jiuwenswarm" and child["resultRef"]["digest"]
        root = Path((directory / "data-dir.txt").read_text().strip())
        message_id, = [item["run"]["assistantMessageId"] for item in result["measurements"].values()]
        messages = read_json(root / "messages" / f"{proof['sessionId']}.json")
        message, = [item for item in messages if item["id"] == message_id]
        assert message["content"].strip() == "ASSAY/36"
    elif is_scope:
        assert result["scope"]["filesRead"] == 5 and result["scope"]["expectedScopeAnswer"] == "FROZEN/155"
        events = [event for event in spine_events if event["event"] == "scope.projection.applied"]
        assert len(events) == int(spine)
        if spine:
            assert events[0]["savedCharacters"] > 0 and events[0]["turn"] == 0
            assert events[0]["sessionId"] == result["scope"]["sessionId"]
        if result["modelMode"] == "controlled":
            payload, = [item for item in result["observed"] if item["stage"] == "scope-followup"]
            assert payload["projectionSeen"] == spine and payload["oldEvidenceSeen"] != spine
    elif fixture is None:
        audit_receipt(result)
    else:
        audit, summary = expected(fixture)
        assert result["audit"]["shortAnswer"] == 14
        assert result["audit"]["audit"] == audit and result["audit"]["summary"] == summary
        assert len(result["displayEvidence"]) == 1
        if spine:
            assert result["nodeMemory"]["wrongRunRejected"] and result["nodeMemory"]["versionId"]
            assert result["inline"]["childRuns"] == 0
            recovery = [event for event in spine_events if event["event"] == "research.recovery.input"]
            assert recovery and len({event["runId"] for event in recovery}) == 1
            assert [event["turn"] for event in recovery] == list(range(len(recovery)))
            if result.get("recoveryMode") != "full":
                assert recovery[0]["modelMessages"] < recovery[0]["originalMessages"]
        elif "gates" in result:
            gates = result["gates"]
            assert "Native" in gates["resume"]["error"] and "Native" in gates["inline"]["error"]
            assert "unavailable or stale" in gates["memory"]["error"]
            assert gates["modelInvocationsAdded"] == gates["runsAdded"] == 0
    stats = {}
    for name, measurement in result["measurements"].items():
        assert measurement["run"]["status"] == "completed" and measurement["run"]["assistantMessageId"]
        usage = measurement["usage"]
        bucket = usage["byRun"]
        invocation_records = usage["invocations"]
        assert all(row["usageStatus"] == "reported" for row in invocation_records)
        turns = sum(row.get("turnsRecorded", 1) for row in invocation_records)
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            assert sum(row[key] for row in invocation_records) == bucket[key]
        stats[name] = [bucket["inputTokens"], bucket["outputTokens"], bucket["totalTokens"], turns,
                       len(measurement["executions"]), measurement["elapsedMs"]]
    summaries = [json.loads(match) for match in re.findall(r"\[model-sse-summary\] (\{[^\n]+\})", driver)]
    gateway = [summary for summary in summaries if summary.get("gatewayRequestId") and summary.get("purpose") == "task"]
    assert len(gateway) == sum(row[3] for row in stats.values())
    if scope_product:
        pass
    elif is_scope and result["modelMode"] == "controlled":
        assert stats["scope-source"][:5] == [1500, 300, 1800, 6, 5]
        assert stats["scope-followup"][:5] == [250, 50, 300, 1, 0]
    elif fixture is None and result["modelMode"] == "controlled":
        assert stats["receipt"][:5] == [1000, 200, 1200, 4, 0]
    elif result["modelMode"] == "controlled":
        assert stats["question"][:5] == [250, 50, 300, 1, 0]
        assert stats["source"][:5] == stats["continuation"][:5] == [750, 150, 900, 3, 2]
        assert all(item["historySeen"] for item in result["observed"] if item["stage"] == "continuation")
    return stats, sum(summary["retries"] for summary in gateway)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("results", type=Path)
parser.add_argument("cohorts", nargs="+", choices=["controlled-1", "controlled-2", "real-1", "real-2", "receipt-controlled", "receipt-real", "scope-controlled", "scope-real", "tree-controlled", "tree-real", "observe-controlled", "observe-real", "graph-controlled", "graph-real", "native-receipt-controlled", "native-receipt-real", "idea-controlled", "idea-real", "evolve-controlled", "evolve-real"])
parser.add_argument("--retry-real-1-candidate", type=Path, help="Include the independently rerun candidate, preserving the first attempt separately")
parser.add_argument("--context-evidence", action="store_true", help="Read model-context CAS snapshots from this WSL machine")
parser.add_argument("--record-failures", action="store_true", help="Retain first-attempt failures with their measured status and suppress incomplete pairs from aggregates")
args = parser.parse_args()
fixtures = Path(__file__).parent / "fixtures" / "citations"
comparisons = {"fields": ["inputTokens", "outputTokens", "totalTokens", "modelRequests", "shellExecutions", "deliveryMs"], "cohorts": {}}
for cohort in args.cohorts:
    entry = {}
    for arm in ("original", "candidate"):
        directory = args.results / cohort / arm
        if cohort == "real-1" and arm == "candidate" and args.retry_real_1_candidate:
            assert read_json(directory / "result.json").get("pass") is not True
            assert (directory / "exit-code.txt").read_text().strip() != "0"
            entry["candidateIsRetry"] = True
            directory = args.retry_real_1_candidate
        exit_code = (directory / "exit-code.txt").read_text().strip()
        is_receipt = cohort.startswith("receipt-")
        is_scope = cohort.startswith("scope-")
        prefix = cohort.rsplit("-", 1)[0]
        scope_product = prefix if prefix in {"tree", "observe", "graph", "native-receipt", "idea", "evolve"} else None
        result_file = directory / "result.json"
        if args.record_failures and exit_code != "0":
            failed = read_json(result_file) if result_file.exists() else {}
            entry[f"{arm}Failure"] = {
                "exitCode": int(exit_code), "error": failed.get("error"), "stages": {
                    name: {"status": measurement["run"]["status"], "elapsedMs": measurement["elapsedMs"]}
                    for name, measurement in failed.get("measurements", {}).items()
                }, "adapter": failed.get("adapter"), "gates": failed.get("gates"),
            }
            continue
        stats, retries = audit_arm(directory, None if is_receipt or is_scope or scope_product else fixtures / f"case-{cohort[-1]}" / "workspace", is_scope, scope_product)
        if is_scope:
            result = read_json(result_file)
            entry[f"{arm}Evidence"] = {"scope": result["scope"], "modelPayloads": [item for item in result["observed"] if item["stage"] == "scope-followup"]}
        elif scope_product:
            result = read_json(result_file)
            entry[f"{arm}Evidence"] = {key: result[key] for key in ("tree", "scopeGraph", "idea", "evolve") if key in result}
        elif not is_receipt:
            result = read_json(result_file)
            entry[f"{arm}Evidence"] = {key: result[key] for key in ("inline", "nodeMemory", "recoveryMode", "staleMemoryRejected", "recoveryScopes") if key in result}
        if is_receipt:
            result = read_json(result_file)
            entry[f"{arm}Evidence"] = {key: result[key] for key in (
                "childRecordsReadMs", "childRecordsReopenedMs", "receiptCreatedMs", "receiptReopenedMs",
                "receiptModelInvocationsAdded", "receiptCasVerified", "children", "receipt",
            ) if key in result}
        if args.context_evidence and not is_receipt and not scope_product:
            fixture = None if is_scope else fixtures / f"case-{cohort[-1]}" / "workspace"
            entry[f"{arm}Evidence"]["context"] = context_evidence(directory, read_json(result_file), is_scope, fixture)
        entry[arm] = stats
        entry[f"{arm}Retries"] = retries
    comparisons["cohorts"][cohort] = entry
for kind in ("controlled", "real"):
    cohorts = [item for name, item in comparisons["cohorts"].items() if name.startswith(kind) and "original" in item and "candidate" in item]
    if not cohorts:
        continue
    comparisons[kind] = {}
    for stage in ("question", "source", "continuation", "research-total"):
        def values(arm, entry):
            if stage == "research-total":
                return list(map(sum, zip(entry[arm]["source"], entry[arm]["continuation"])))
            return entry[arm][stage]
        original = list(map(sum, zip(*(values("original", item) for item in cohorts))))
        candidate = list(map(sum, zip(*(values("candidate", item) for item in cohorts))))
        differences = [round(100 * (b / a - 1), 2) if a else None for a, b in zip(original, candidate)]
        timing = round(100 * (statistics.median(values("candidate", item)[-1] / values("original", item)[-1] for item in cohorts) - 1), 2)
        comparisons[kind][stage] = {"originalSum": original, "candidateSum": candidate, "deltaPct": differences, "pairedMedianLatencyPct": timing}
print(json.dumps(comparisons, indent=2, ensure_ascii=False))
