import argparse
from collections import Counter
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re

from solar_audit import audit as audit_solar

spec = importlib.util.spec_from_file_location("report_paired", Path(__file__).with_name("report-paired.py"))
paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paired)


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


def duration(start, end):
    if start and end:
        return round((stamp(end) - stamp(start)) * 1000)


def union_ms(intervals):
    total = 0.0
    cursor = None
    for start, end in sorted((stamp(a), stamp(b)) for a, b in intervals if a and b):
        if end >= start:
            total += max(0.0, end - (max(start, cursor) if cursor is not None else start))
            cursor = max(end, cursor) if cursor is not None else end
    return round(total * 1000)


def timing_report(result, envelopes, requests):
    started = {}
    tools = []
    milestones = {}
    delivery = []
    for envelope in envelopes:
        event = envelope["event"]
        kind, at = event["type"], envelope["createdAt"]
        if kind == "tool.started":
            started[event["trace"]["id"]] = at
        elif kind == "tool.completed":
            trace = event["trace"]
            details = trace.get("details") or {}
            runner = details.get("result") if isinstance(details.get("result"), dict) else details
            tools.append({"id": trace["id"], "name": trace["name"], "status": trace.get("status"),
                          "start": started.get(trace["id"]), "end": at, "runnerStart": runner.get("startedAt"),
                          "runnerFinish": runner.get("finishedAt"), "executionId": runner.get("executionId"),
                          "runnerState": runner.get("state"), "sequence": envelope["sequence"]})
        elif kind == "research.recovery":
            delivery.append({"at": at, "action": event["action"], "reason": event.get("reason"), "sequence": envelope["sequence"]})
        elif kind == "run.status" and event.get("status") == "interrupted":
            milestones.setdefault("run.interrupted", at)
        elif kind in ("run.queued", "run.started", "run.completed", "run.cancelled", "run.failed"):
            milestones.setdefault(kind, at)
    model = [{key: row.get(key) for key in ("requestId", "purpose", "startedAt", "dispatchedAt", "firstByteAt", "completedAt",
                                             "elapsedMs", "timeToFirstByteMs", "retries")} for row in requests]
    timing = result.get("timing", {})
    model_intervals = [(row["startedAt"], row["completedAt"]) for row in model]
    tool_intervals = [(row["start"], row["end"]) for row in tools]
    shell = [row for row in tools if row["name"] == "run_shell"]
    tool_union = union_ms(tool_intervals)
    model_union = union_ms(model_intervals)
    observed = union_ms(model_intervals + tool_intervals)
    run = result["run"]
    return {"model": model, "tools": tools, "milestones": milestones, "researchEvents": delivery, "client": timing,
            "modelUnionMs": model_union, "toolUnionMs": tool_union, "modelToolOverlapMs": model_union + tool_union - observed,
            "clientUnattributedMs": result["elapsedMs"] - observed,
            "modelFirstByteSumMs": sum(row["timeToFirstByteMs"] or 0 for row in model),
            "shellPreRunnerSumMs": sum(duration(row["start"], row["runnerStart"]) or 0 for row in shell),
            "shellRunnerWindowUnionMs": union_ms([(row["runnerStart"], row["runnerFinish"]) for row in shell]),
            "shellPostRunnerSumMs": sum(duration(row["runnerFinish"], row["end"]) or 0 for row in shell),
            "shellWithRunnerFinish": sum(bool(row["runnerFinish"]) for row in shell),
            "lastModelToRunFinishedMs": duration(max((row["completedAt"] for row in model if row["completedAt"]), default=None), run.get("finishedAt")),
            "runFinishedToClientTerminalMs": duration(run.get("finishedAt"), timing.get("terminalObservedAt")),
            "clientUsageFetchMs": duration(timing.get("terminalObservedAt"), timing.get("usageReceivedAt"))}


def audit_citations(workspace, frozen):
    import hashlib
    import unicodedata

    def normalize(text):
        return " ".join(unicodedata.normalize("NFKC", text).lower().split())

    metadata = read(frozen / "doi_metadata.json")
    expected_table = "doi\ttitle\tyear\n" + "".join(f"{row['doi'].lower()}\t{row['title']}\t{row['year']}\n" for row in metadata)
    manifest = read(frozen.parent / "checkpoint.json")
    digest = hashlib.sha256((frozen / "doi_metadata.json").read_bytes()).hexdigest()
    if digest != manifest.get("metadata_file_sha256") or (frozen / "citation_sources.tsv").read_bytes() != expected_table.encode():
        return False
    sources = {row["doi"].lower(): row for row in metadata}
    expected = []
    for row in read(frozen / "bibliography.json"):
        doi = row["doi"].lower()
        source = sources.get(doi)
        title = normalize(source["title"]) == normalize(row["title"]) if source else None
        year = source["year"] == row["year"] if source else None
        status = "unresolved" if source is None else "match" if title and year else "mismatch"
        expected.append(dict(doi=doi, title_match=title, year_match=year, status=status))
    counts = Counter(row["status"] for row in expected)
    summary = dict(total=len(expected), **{status: counts[status] for status in ("match", "mismatch", "unresolved")})
    try:
        return read(workspace / "citation_audit.json") == expected and read(workspace / "citation_summary.json") == summary
    except (OSError, ValueError):
        return False


def audit_arm(arm):
    result = read(arm / "result.json")
    root_file = arm / "data-dir.txt"
    root = Path(root_file.read_text().strip()) if root_file.exists() else arm / "data"
    checkpoint = Path(result["checkpoint"])
    workspace = Path(result["workspace"])
    manifest = read(checkpoint / "checkpoint.json")
    solar = manifest["workload"] == "solar"
    citations = manifest["workload"] == "citations"
    table_name = "citation_sources.tsv" if citations else "site_qc.csv" if solar else "cleaned.csv"
    downstream = "citation_audit.json" if citations else "groups.json" if solar else "fits.json"
    table = (checkpoint / "workspace" / table_name).read_text(encoding="utf-8").strip()
    source_history = read(checkpoint / "final-messages.json")
    received_table = any(message.get("role") == "tool" and table in str(message.get("content", "")).replace("\r\n", "\n") for message in source_history)
    received_in_source = received_table
    run_id = result["run"]["id"]
    streams = [file for file in (root / "run-events").rglob("*.jsonl") if file.parent.name == run_id]
    assert streams, "No durable Run event streams"
    main = next(file for file in streams if file.name == "main.jsonl")
    envelopes = [json.loads(line) for line in main.open(encoding="utf-8")]
    records = [row["event"] for row in envelopes]
    tools = [event["trace"] for event in records if event["type"] == "tool.completed"]
    artifact_before = {file.name: file.read_bytes() for file in (checkpoint / "workspace").iterdir() if file.is_file()}
    protected = ({"sites.csv", "measurements.csv", "daily_clean.csv", "site_qc.csv"} if solar
                 else {"instrument.csv", "qc.json", "cleaned.csv"})
    if citations:
        protected = {"doi_metadata.json", "bibliography.json", "citation_sources.tsv"}
    assert protected <= artifact_before.keys(), "Frozen inputs missing"
    frozen_changes = sorted(name for name, data in artifact_before.items()
                            if not (workspace / name).is_file() or (workspace / name).read_bytes() != data)
    no_changes = not protected.intersection(frozen_changes)
    # The public event stream intentionally omits stdout. Join model-visible
    # evidence back to the same tool-call ID, then order it by the Run stream.
    display_calls = set()
    visible_results = {}
    for trace_file in (root / "context-traces").glob(result["sessionId"] + "_*/turn-*.json"):
        history = read(trace_file).get("llmInput", {}).get("history", [])
        for entry in history:
            content = entry.get("content")
            if entry.get("role") == "tool" and isinstance(content, str):
                visible_results[entry.get("tool_call_id")] = content
                if table in content.replace("\r\n", "\n"):
                    display_calls.add(entry.get("tool_call_id"))
    tool_args = {record["trace"]["id"]: record["trace"].get("args", {}) for record in records if record["type"] == "tool.started"}
    pending_shells = set()
    successful_shells = set()
    rewrites = set()
    downstream_seen = False
    review_order_ok = True
    repeat = 0
    for entry in tools:
        details = entry.get("details") or {}
        stdout = details.get("stdout", "")
        if "__detailsBoundary" in details:
            outputs = [e.get("chunk", "") for e in records if e["type"] == "tool.output" and e.get("toolCallId") == entry["id"]]
            if outputs and table in "".join(outputs).replace("\r\n", "\n"):
                stdout = table
        effects = details.get("result") if isinstance(details.get("result"), dict) else details
        names = set(effects.get("createdFiles", [])) | set(effects.get("modifiedFiles", []))
        rewrites |= names & protected
        if downstream in names and not downstream_seen:
            review_order_ok &= received_table
            downstream_seen = True
        execution = details.get("executionId")
        name, args = entry["name"], tool_args.get(entry["id"], {})
        if name == "run_shell" and execution and details.get("state") in ("queued", "running"):
            pending_shells.add(execution)
        if (name == "execution_status" and execution in pending_shells and execution == args.get("execution_id")
                and details.get("state") == "completed" and effects.get("exitCode") == 0 and not names):
            successful_shells.add(execution)
        full_table_display = entry.get("id") in display_calls or (isinstance(stdout, str) and table in stdout.replace("\r\n", "\n"))
        if name == "execution_logs" and args.get("execution_id") in successful_shells and args.get("cursor", 0) == 0:
            try:
                page = json.loads(visible_results.get(entry["id"], ""))
                readout = "".join(chunk["text"] for chunk in page["chunks"] if chunk["stream"] == "stdout")
                full_table_display |= (page.get("state") == "completed" and page.get("truncated") is False
                                       and page.get("retentionTruncated") is False and table in readout.replace("\r\n", "\n"))
            except (ValueError, TypeError, KeyError):
                pass
        if entry.get("status") == "completed" and full_table_display:
            repeat += received_table
            received_table = True
    natural = result["run"]["status"] == "completed" and sum(event["type"] == "run.completed" for event in records) == 1
    if citations:
        quality = audit_citations(workspace, checkpoint / "workspace")
    else:
        quality = not any(audit_solar(workspace)["errors"]) if solar else paired.calibration_matches_workspace(workspace, 72)
    child_usage = [event["usage"] for event in records if event["type"] == "subagent.usage"]
    model_usage = [event["usage"] for event in records if event["type"] == "model.usage"]
    usage = result["usage"]["totals"]
    keys = ("inputTokens", "outputTokens", "totalTokens")
    main_tokens = [sum(item.get(key) or 0 for item in model_usage) for key in keys]
    source_tokens = [0, 0, 0]
    if result.get("sourceRequests"):
        source = next(file for file in (root / "run-events").rglob("main.jsonl") if file.parent.name == result["sourceRunId"])
        source_usage = [event["usage"] for line in source.open(encoding="utf-8")
                        if (event := json.loads(line)["event"])["type"] == "model.usage"]
        source_tokens = [sum(item.get(key) or 0 for item in source_usage) for key in keys]
    reconcile = all(main_tokens[i] + source_tokens[i] == usage[key] for i, key in enumerate(keys))
    totals = [main_tokens[i] + sum(item.get(key) or 0 for item in child_usage) for i, key in enumerate(keys)]
    driver_text = (arm / "driver.log").read_text(encoding="utf-8", errors="replace").rsplit("[formal-measurement-start]", 1)[-1]
    model_requests = [json.loads(line.split("] ", 1)[1]) for line in driver_text.splitlines() if line.startswith("[model-sse-summary] ")]
    purposes = Counter(row.get("purpose") for row in model_requests)
    route_records = [event["action"] for event in records if event["type"] == "research.recovery"]
    run_log = (root / "logs" / "run.log").read_text(encoding="utf-8")
    if not route_records:
        route_records = re.findall(r"event=research_recovery_route [^\n]* route=([^\s]+)", run_log)
    fault = result.get("fault")
    fault_pass = None
    if fault:
        cancel_fault = fault in ("cancel-shell", "runner-unavailable")
        evidence = result["faultEvidence"]
        terminal_event = "run.cancelled" if cancel_fault else "run.completed" if fault == "retry-after-restart" else "run.status"
        statuses = [event for event in records if event["type"] == terminal_event]
        started = sum(event["type"] == "run.started" for event in records)
        expected_shells = {"cancel-shell": 1, "runner-unavailable": 1, "crash-before-commit": 1, "retry-after-restart": 3}[fault] + int(not received_in_source and not cancel_fault)
        fault_pass = (result["run"]["status"] == evidence["expectedFaultStatus"] and started == 1
                      and all(run_id == retry for retry in evidence["retriedRunIds"])
                      and evidence["requestsBeforeRetry"] == result["modelRequests"]
                      and evidence["totalRunsForCheckpoint"] == 1 and evidence["originalApiPid"] != evidence["restartedApiPid"] and bool(statuses)
                      and sum(event["type"] == "tool.started" for event in records) == expected_shells
                      and no_changes and not rewrites and repeat == 0
                      and (natural and quality if fault == "retry-after-restart" else not natural
                           and not result["run"].get("assistantMessageId") and not (workspace / "solar_report.md").exists()
                           and "delivery-verified" not in route_records))
        if cancel_fault:
            fault_pass &= (evidence["shellWriteAfterManagedCancel"] is False
                           and evidence["executionStateAfterRunCancel"] == "cancelled"
                           and ("shell-stop-confirmed" in route_records if fault == "cancel-shell"
                                else ("shell-stop-unconfirmed" in route_records and evidence["unconfirmedWriteDenied"]))
                           and not (workspace / ".formal-shell-alive").exists()
                           and (workspace / ".formal-shell-release").is_file()
                           and not (workspace / ".formal-shell-finished").exists())
        elif fault == "crash-before-commit":
            fault_pass &= any(event.get("status") == "interrupted" for event in statuses)
            fault_pass &= (workspace / "groups.json").read_text() == evidence["beforeCrash"]
            fault_pass &= not any(audit_solar(workspace)["errors"][:2])
    exit_path = arm / "exit-code.txt"
    exit_code = int(exit_path.read_text()) if exit_path.exists() else None
    return {"mode": result["mode"], "fault": fault, "fault_pass": fault_pass, "exit_code": exit_code,
            "source_displayed": received_in_source, "timing": timing_report(result, envelopes, model_requests), "run_status": result["run"]["status"], "completion": natural, "quality": quality, "review_order": review_order_ok and received_table and downstream_seen,
            "token_reconciliation": reconcile, "seconds": result["elapsedMs"] / 1000, "main_tokens": main_tokens, "source_tokens": source_tokens,
            "total_with_child_usage": totals, "requests": dict(purposes), "transport_retries": sum(row.get("retries", 0) for row in model_requests), "tools": Counter(entry["name"] for entry in tools),
            "child_usage_rows": len(child_usage), "qc_unchanged": no_changes, "qc_rewrites": sorted(rewrites),
            "other_frozen_changes": sorted(set(frozen_changes) - protected), "repeated_table_reads": repeat,
            "route": route_records}


def recovery_checks(row, displayed):
    checks = {key: row.get(key) is True for key in
              ("completion", "quality", "review_order", "token_reconciliation", "qc_unchanged")}
    route = row.get("route", ())
    mode = row["mode"]
    expected_route = "retained-evidence" if mode == "by-state" and displayed else "full-history"
    checks.update(
        protected_no_rewrite=row.get("qc_rewrites") == [],
        no_repeat=row.get("repeated_table_reads") == 0,
        source_state=displayed is not None and row.get("source_displayed") == displayed,
        no_delegation=row.get("child_usage_rows") == 0,
        delivery_attested=mode == "original" or "delivery-verified" in route,
        expected_route=mode == "original" or expected_route in route,
    )
    return checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--require-pass", action="store_true")
    parser.add_argument("--require-fault-pass", action="store_true")
    parser.add_argument("--single", action="store_true", help="audit the supplied arm directory")
    args = parser.parse_args()
    results = []
    directories = [args.directory] if args.single else sorted(args.directory.iterdir())
    for directory in directories:
        if not directory.is_dir():
            continue
        try:
            result = audit_arm(directory)
        except (AssertionError, OSError, ValueError, KeyError, StopIteration) as error:
            result = {"mode": directory.name, "audit_error": str(error)}
        results.append(result)
        print(json.dumps(result, ensure_ascii=False))
    if args.require_pass:
        displayed = (results[0].get("source_displayed") if args.single and results else
                     next((row.get("source_displayed") for row in results if row["mode"] == "original"), None))
        modes = {row["mode"] for row in results}
        complete = (len(results) == 1 if args.single else modes == {"original", "full", "by-state"})
        if not complete or not all(row.get("exit_code") == 0 and all(recovery_checks(row, displayed).values()) for row in results):
            raise SystemExit(1)

    if args.require_fault_pass:
        if ({row.get("fault") for row in results} not in ({"cancel-shell", "crash-before-commit", "retry-after-restart"},
                        {"cancel-shell", "runner-unavailable", "crash-before-commit", "retry-after-restart"})
                or not all(row.get("fault_pass") and row.get("exit_code") == 0 and row.get("token_reconciliation") for row in results)):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
