"""Aggregate every paired run and audit final model inputs from raw context traces."""

import argparse
from collections import Counter
from datetime import datetime
import csv
import hashlib
import json
import math
from pathlib import Path
from statistics import mean, median

from solar_audit import audit as audit_solar


METRICS = {
    "inputTokens": "Input tokens",
    "outputTokens": "Output tokens",
    "totalTokens": "Total tokens",
    "modelTurns": "Model turns",
    "toolCalls": "Tool calls",
    "durationMs": "Duration (ms)",
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def percentile(values, fraction):
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def passed(run):
    return (
        run["status"] == "completed"
        and run["completionMode"] == "model_stop"
        and run["artifactCompleteness"] == 1
        and run["artifactValidation"]["passed"]
        and run["totalTokens"] > 0
        and run["usageEvents"] >= run["modelTurns"] > 0
    )


def solar_matches_reference(root, run):
    return not any(audit_solar(root / run["id"] / "workspace")["errors"])


def calibration_matches_reference(root, run, points=12):
    return calibration_matches_workspace(root / run["id"] / "workspace", points)


def calibration_matches_workspace(workspace, points=12):
    """Check the fixed input and independently recompute the cleaned data and drift."""
    try:
        raw = (workspace / "instrument.csv").read_bytes()
        fixture = ["batch,sample_id,setpoint,reading,status"]
        for batch, slope, intercept in (("reference", 1.02, .12), ("production_a", 1.03, .22), ("production_b", 1.12, .20)):
            fixture.extend(f"{batch},{sample},{sample},{slope * sample + intercept:.3f},ok" for sample in range(points))
        fixture.extend(("production_a,bad-1,5,,invalid", "production_b,0,0,99.000,ok"))
        if raw != ("\n".join(fixture) + "\n").encode():
            return False
        source = list(csv.DictReader(raw.decode("utf-8").splitlines()))
        seen, clean = set(), []
        invalid = duplicates = 0
        for row in source:
            key = row["batch"], row["sample_id"]
            if row["status"] != "ok":
                invalid += 1
            elif key in seen:
                duplicates += 1
            else:
                seen.add(key)
                clean.append(row)
        columns = ("batch", "sample_id", "setpoint", "reading", "status")
        def normalized(rows):
            return [(r["batch"], r["sample_id"], float(r["setpoint"]), float(r["reading"]), r["status"]) for r in rows]
        with (workspace / "cleaned.csv").open(encoding="utf-8", newline="") as stream:
            cleaned = csv.DictReader(stream)
            if tuple(cleaned.fieldnames or []) != columns or normalized(cleaned) != normalized(clean):
                return False
        qc = read_json(workspace / "qc.json")
        counts = {"raw_rows": len(source), "clean_rows": len(clean), "excluded_status_rows": invalid, "duplicate_rows": duplicates}
        if any(type(qc[key]) is not int or qc[key] != value for key, value in counts.items()):
            return False
        fits = read_json(workspace / "fits.json")
        slopes = {}
        def close(actual, expected):
            return type(actual) in (float, int) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-6)
        for batch in ("reference", "production_a", "production_b"):
            points = [(float(row["setpoint"]), float(row["reading"])) for row in clean if row["batch"] == batch]
            xs, ys = zip(*points)
            xmean, ymean = mean(xs), mean(ys)
            slope = sum((x - xmean) * (y - ymean) for x, y in points) / sum((x - xmean)**2 for x in xs)
            intercept = ymean - slope * xmean
            actual = fits[batch]
            if not (close(actual["n"], len(points)) and close(actual["slope"], slope) and close(actual["intercept"], intercept)):
                return False
            slopes[batch] = slope
        drift = read_json(workspace / "drift.json")
        threshold = 0.05
        deltas = {batch: slopes[batch] - slopes["reference"] for batch in ("production_a", "production_b")}
        flagged = [batch for batch, delta in deltas.items() if abs(delta) > threshold]
        if not (drift["baseline_batch"] == "reference" and close(drift["threshold"], threshold)
                and drift["flagged_batches"] == flagged
                and all(close(drift["slope_deltas"][batch], delta) for batch, delta in deltas.items())):
            return False
        text = (workspace / "calibration_report.md").read_text(encoding="utf-8")
        def report_field(key):
            values = [value.strip() for line in text.splitlines()
                      for name, sep, value in [line.strip().removeprefix("- ").removeprefix("* ").partition(":")]
                      if sep and name.strip() == key]
            if len(values) != 1:
                raise ValueError(f"Missing or repeated report field {key}")
            return values[0]
        return (all(name in text for name in ("qc.json", "cleaned.csv", "fits.json", "drift.json"))
                and close(float(report_field("clean_rows")), len(clean))
                and close(float(report_field("reference_slope")), slopes["reference"])
                and close(float(report_field("drift_threshold")), threshold)
                and [name.strip() for name in report_field("flagged_batches").split(",")] == flagged)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, ZeroDivisionError):
        return False


def cohort_matches_reference(root, run):
    """Recompute row selection, imputation and the outcome contingency table."""
    workspace = root / run["id"] / "workspace"
    try:
        with (workspace / "cohort.csv").open(encoding="utf-8", newline="") as stream:
            source = csv.DictReader(stream)
            columns = source.fieldnames
            raw = list(source)
        with (workspace / "cleaned_cohort.csv").open(encoding="utf-8", newline="") as stream:
            cleaned = csv.DictReader(stream)
            if cleaned.fieldnames != columns:
                return False
            observed = list(cleaned)
    except (OSError, csv.Error):
        return False
    raw_observed = [float(row["biomarker_a"]) for row in raw if row["biomarker_a"]]
    first = {}
    for row in raw:
        first.setdefault(row["subject_id"], row)
    deduplicated_observed = [float(row["biomarker_a"]) for row in first.values() if row["biomarker_a"]]
    # The two reasonable interpretations of cohort median differ only in
    # whether the duplicate contributes to the distribution.
    medians = (median(raw_observed), median(deduplicated_observed))
    if len(raw) != 60 or len(first) != 59 or len(observed) != 59:
        return False
    if set(first) != {row["subject_id"] for row in observed}:
        return False
    try:
        for row in observed:
            expected = first[row["subject_id"]]
            for key in columns:
                if key == "biomarker_a" and not expected[key]:
                    if not any(math.isclose(float(row[key]), value, abs_tol=1e-9) for value in medians):
                        return False
                elif key in {"biomarker_a", "biomarker_b"}:
                    if not math.isclose(float(row[key]), float(expected[key]), abs_tol=1e-9):
                        return False
                elif row[key] != expected[key]:
                    return False
        table = Counter((row["treatment_group"], int(row["outcome_30d"])) for row in observed)
    except (KeyError, ValueError, TypeError):
        return False
    return table == {("treated", 1): 25, ("treated", 0): 5, ("control", 1): 9, ("control", 0): 20}


def model_risk_difference_matches(root, run):
    """Check rate difference and Wald bounds against the accepted cleaned table."""
    path = root / run["id"] / "workspace" / "model_results.json"
    if not path.exists():
        return False
    try:
        result = read_json(path)
    except (OSError, ValueError):
        return False
    if not isinstance(result, dict):
        return False
    estimate = result.get("absolute_risk_difference", result.get("risk_difference"))
    if isinstance(estimate, dict):
        if "estimate" not in estimate and "value" not in estimate:
            return False
    elif not isinstance(estimate, (int, float)):
        return False

    def numbers(value):
        if isinstance(value, (int, float)):
            yield value
        elif isinstance(value, list):
            for item in value:
                yield from numbers(item)
        elif isinstance(value, dict):
            for item in value.values():
                yield from numbers(item)

    uncertainty = [value for key, value in result.items()
                   if any(label in key for label in ("risk_difference", "ci_95", "confidence_interval"))]
    observed = list(numbers(uncertainty))
    treated, control = 25 / 30, 9 / 29
    difference = treated - control
    margin = 1.96 * math.sqrt(treated * (1 - treated) / 30 + control * (1 - control) / 29)
    return all(any(math.isclose(value, expected, abs_tol=5e-4) for value in observed)
               for expected in (difference, difference - margin, difference + margin))


def trace_audit(root, runs):
    audit = Counter()
    reasons = Counter()
    candidates = []
    applied_percentages = []
    applied_savings = []
    first_application_by_run = {}
    for run in runs:
        first_application = None
        for path in sorted((root / run["id"] / "context-traces").rglob("turn-*.json")):
            trace = read_json(path)
            projection = trace.get("projection")
            if not projection:
                audit["without_projection_record"] += 1
                continue
            audit["records"] += 1
            if projection.get("skipReason"):
                reasons[projection["skipReason"]] += 1
            if projection.get("skipReason") != "short_history":
                candidates.append(projection["estimatedSavingsTokens"])
            if not projection["applied"]:
                continue
            audit["admitted"] += 1
            history = trace.get("llmInput", {}).get("history", [])
            if trace.get("selectedPath") == "projection" and any(
                (message.get("additional_kwargs") or {}).get("scope_node_memory")
                for message in history
            ):
                audit["model_input"] += 1
                turn = trace["turn"]
                first_application = turn if first_application is None else min(first_application, turn)
                applied_percentages.append(projection["estimatedSavingsPercent"])
                applied_savings.append(projection["sourceTokens"] - projection["projectedTokens"])
        if first_application is not None:
            audit["runs_with_projection"] += 1
            first_application_by_run[run["id"]] = first_application
    return audit, reasons, candidates, applied_percentages, applied_savings, first_application_by_run


def elapsed_ms(start, end):
    return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() * 1000


def latency_evidence(root, grouped):
    lines = ["", "### Timing by component", "",
             "| Mode | Model request count / usage | Model mean elapsed / task (ms) | Model request P95 (ms) | "
             "Mean tool span / task (ms) | Context traces / turns | Context P95 (ms) |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for mode, runs in grouped.items():
        request_times, tools, assemblies = [], [], []
        for run in runs:
            directory = root / run["id"]
            runner_log = directory.parent / "runner.log"
            if runner_log.exists():
                marker = "[model-sse-summary] "
                for line in runner_log.read_text(encoding="utf-8", errors="replace").splitlines():
                    if not line.startswith(marker):
                        continue
                    event = json.loads(line[len(marker):])
                    at = event.get("startedAt", "")
                    if run["startedAt"] <= at <= run["finishedAt"] and "elapsedMs" in event:
                        request_times.append(event["elapsedMs"])
            starts = {}
            duration = 0
            for event in read_events(root, run):
                if event["type"] == "tool_execution_start":
                    starts[event["toolCallId"]] = event["at"]
                elif event["type"] == "tool_execution_end" and (start := starts.pop(event["toolCallId"], None)):
                    duration += elapsed_ms(start, event["at"])
            tools.append(duration)
            for trace in directory.joinpath("context-traces").rglob("turn-*.json"):
                reading = read_json(trace).get("assemblyDurationMs")
                if reading is not None:
                    assemblies.append(reading)
        request_mean = f"{sum(request_times) / len(runs):,.2f}" if request_times else "—"
        request_p95 = f"{percentile(request_times, .95):,.2f}" if request_times else "—"
        assembly_p95 = f"{percentile(assemblies, .95):,.2f}" if assemblies else "—"
        lines.append(f"| {mode} | {len(request_times)}/{sum(run['usageEvents'] for run in runs)} | "
                     f"{request_mean} | {request_p95} | {mean(tools):,.2f} | "
                     f"{len(assemblies)}/{sum(run['modelTurns'] for run in runs)} | {assembly_p95} |")
    lines += ["", "Model request timers include client-observed wait and streaming. The assembler timer includes any context compaction and excludes writing the trace. Timers can overlap."]
    return lines


def read_events(root, run):
    with (root / run["id"] / "events.jsonl").open(encoding="utf-8") as stream:
        yield from map(json.loads, stream)


def audit_solar_review(root, run):
    directory = root / run["id"]
    table_path = directory / "workspace" / "site_qc.csv"
    if not table_path.exists():
        return False, False
    table = table_path.read_text(encoding="utf-8").splitlines()
    if len(table) != 121:
        return False, False
    closure = next((entry for entry in read_json(directory / "verified-stages.json")
                    if entry["stageId"] == "site-quality"), {})
    seen, signed = False, False
    for event in read_events(root, run):
        if event.get("type") != "tool_execution_end" or event.get("isError"):
            continue
        text = "\n".join(part.get("text", "") for part in (event.get("result") or {}).get("content", [])
                         if part.get("type") == "text")
        if all(line in text for line in table):
            seen = True
            signed = signed or event.get("toolCallId") == closure.get("resultSource", {}).get("toolCallId", closure.get("toolCallId"))
    return seen, signed


def linked_projection_turns(root, run):
    turns = set()
    for path in (root / run["id"] / "context-traces").rglob("turn-*.json"):
        trace = read_json(path)
        if trace.get("selectedPath") != "projection":
            continue
        for message in trace.get("llmInput", {}).get("history", []):
            if not (message.get("additional_kwargs") or {}).get("scope_node_memory"):
                continue
            closure = read_projected_closure(message)
            if closure and closure["toolCallId"] != message.get("tool_call_id"):
                turns.add(trace["turn"])
    return len(turns)


def trajectory_after_projection(root, run, first_turn):
    turn = -1
    model_turns = tool_calls = 0
    for event in read_events(root, run):
        if event.get("type") == "turn_start":
            turn += 1
            model_turns += turn >= first_turn
        elif event.get("type") == "tool_execution_start" and turn >= first_turn:
            tool_calls += 1
    return model_turns, tool_calls


def first_trace(root, run):
    path = next((root / run["id"] / "context-traces").rglob("turn-0000.json"))
    return read_json(path)


def canonical_audit_of_first_fork_input(root, baseline, projected):
    prefix = read_json(root / "fork-prefix.json")
    seed = root / prefix["seedId"]
    history_bytes = (seed / "final-messages.json").read_bytes()
    workspace = seed / "workspace"
    checks = {
        "Frozen history hash matches": hashlib.sha256(history_bytes).hexdigest() == prefix["historySha256"],
        "Frozen workspace hashes match": all(
            hashlib.sha256((workspace / name).read_bytes()).hexdigest() == digest
            for name, digest in prefix["workspaceSha256"].items()),
    }
    traces = [first_trace(root, run)["llmInput"] for run in (baseline, projected)]
    lhs, rhs = [trace["history"] for trace in traces]
    l_anchors, r_anchors = [[message for message in history if message["role"] == "user"] for history in (lhs, rhs)]
    original_user = next(message for message in json.loads(history_bytes) if message["role"] == "user")
    linked = projected["mode"] == "projection-linked"
    closures = {(closure.get("resultSource", {}).get("toolCallId", closure["toolCallId"]) if linked else closure["toolCallId"]): closure
                for closure in prefix["closures"]}
    memories = [message for message in rhs if (message.get("additional_kwargs") or {}).get("scope_node_memory")]
    memories_by_id = {message.get("tool_call_id"): message for message in memories}
    replaced = set(memories_by_id)
    checks["Original user task and continuation anchor are identical"] = (
        l_anchors == r_anchors and any(message["content"] == original_user["content"] for message in l_anchors))
    checks["All history outside the replaced tool results is identical"] = (
        [msg for msg in lhs if msg.get("tool_call_id") not in replaced]
        == [msg for msg in rhs if msg.get("tool_call_id") not in replaced])
    if replaced:
        checks["Replaced results match the frozen stage evidence"] = len(replaced) == len(memories) and all(
            call_id in closures
            and read_projected_closure(memory) == {key: value for key, value in closures[call_id].items() if key != "resultSource"}
            and sum(message.get("tool_call_id") == call_id and message["role"] == "tool"
                    and message["content"] != memory["content"] for message in lhs) == 1
            for call_id, memory in memories_by_id.items())
        if linked:
            sources = {call_id: closure["resultSource"] for call_id, closure in closures.items()
                       if call_id in replaced and "resultSource" in closure}
            checks["Replaced readout digests match original model input and frozen history"] = bool(sources) and all(
                any(message.get("tool_call_id") == call_id and isinstance(message.get("content"), str)
                    and hashlib.sha256(message["content"].encode()).hexdigest() == source["contentSha256"]
                    for message in history)
                for call_id, source in sources.items() for history in (lhs, json.loads(history_bytes)))
    else:
        checks["With zero replaced results, the complete model input trace is identical"] = traces[0] == traces[1]
    checks["First-request tools match"] = traces[0].get("tools") == traces[1].get("tools")
    checks["First-request system prompt matches"] = traces[0].get("systemPrompt") == traces[1].get("systemPrompt")
    return checks


def read_projected_closure(message):
    try:
        return json.loads(message["content"]).get("verified_stage")
    except (ValueError, TypeError, AttributeError):
        return None


def usage_matches(run, events):
    return (len(events) == run["usageEvents"] == run["modelTurns"] > 0
            and all(event.get("usageReported") is True for event in events)
            and all(sum(event["usage"][key] for event in events) == run[key]
                    for key in ("inputTokens", "outputTokens", "totalTokens")))


def first_early_admission(root, run):
    turns = [trace["turn"] + 1 for path in (root / run["id"] / "context-traces").rglob("turn-*.json")
             if (trace := read_json(path)).get("projection", {}).get("applied")
             and trace["turn"] < run["modelTurns"] - 1]
    return min(turns, default=None)


def shadow_report(root, runs):
    lines = ["", "| Run | E2E | Input | Output | Total | Turns | Tools | Seconds | Gate admitted | Model visible |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    durations, savings = [], []
    errors, reasons = Counter(), Counter()
    state, stages = Counter(), Counter()
    early = {run["id"]: turn for run in runs if (turn := first_early_admission(root, run)) is not None}
    for run in runs:
        audit, skipped, _, _, _, _ = trace_audit(root, [run])
        reasons.update(skipped)
        for path in (root / run["id"] / "context-traces").rglob("turn-*.json"):
            trace = read_json(path)
            obs = trace.get("projectionObservation")
            if obs is None:
                errors["missing_observation"] += 1
            else:
                durations.append(obs["durationMs"])
                if "error" in obs:
                    errors[obs["error"]] += 1
            if trace.get("selectedPath") != "dynamic" or any(
                (message.get("additional_kwargs") or {}).get("scope_node_memory")
                for message in trace.get("llmInput", {}).get("history", [])
            ):
                errors["unexpected_model_input"] += 1
            gate = trace.get("projection", {})
            details = gate.get("stageDiagnostics", {})
            if details:
                state[details["state"], details["receivedClosures"], details["validClosures"]] += 1
                stages.update(item["reason"] for item in details["stages"])
            if gate.get("completedToolCount", 0) > 0:
                savings.append(gate["estimatedSavingsTokens"])
        status = "PASS" if passed(run) else "FAIL"
        lines.append(f"| {run['id']} | {status} | {run['inputTokens']:,} | {run['outputTokens']:,} | {run['totalTokens']:,} | "
                     f"{run['modelTurns']} | {run['toolCalls']} | {run['durationMs']/1000:.2f} | {audit['admitted']} | {audit['model_input']} |")
    lines += ["", f"Gate skip reasons `{dict(reasons)}`. Observation errors `{dict(errors)}`."]
    if state:
        lines.append(f"Evidence `(state, received, valid) → turns` {dict(state)}.")
        lines.append(f"Per-stage decisions `{dict(stages)}`.")
    lines.append(f"First admitted turns before the last model turn in {len(early)}/{len(runs)} runs `{early}`.")
    if durations:
        lines.append(f"Candidate evaluation times over {len(durations)} turns, P50 {median(durations):.3f} ms, "
                     f"P95 {percentile(durations, .95):.3f} ms, max {max(durations):.3f} ms.")
    if savings:
        lines.append(f"Estimated savings in {len(savings)} turns with eligible stage results, "
                     f"min {min(savings):,}, P50 {median(savings):,}, max {max(savings):,} history tokens.")
    lines.append("")
    return lines


def report(root, results_file="results.json"):
    results = read_json(root / results_file)
    runs = results["summaries"]
    repetitions = results["repetitions"]
    modes = results["modes"]
    by_pair = {(run["repetition"], run["mode"]): run for run in runs}
    pair_ids = range(results.get("firstPair", 1), results.get("firstPair", 1) + repetitions)
    expected = {(pair, mode) for pair in pair_ids for mode in modes}
    if set(by_pair) != expected or len(by_pair) != len(runs):
        raise ValueError("Run manifest has missing or duplicate samples")
    grouped = {mode: [by_pair[pair, mode] for pair in pair_ids] for mode in modes}
    lines = [f"# Native MVP paired evidence · {root.name}", "", f"Model `{results['model']}`.", ""]
    lines += ["| Mode | E2E PASS | Natural stop | Valid complete artifact sets |", "|---|---:|---:|---:|"]
    for mode, samples in grouped.items():
        natural = sum(r["status"] == "completed" and r["completionMode"] == "model_stop" for r in samples)
        artifacts = sum(r["artifactCompleteness"] == 1 and r["artifactValidation"]["passed"] for r in samples)
        lines.append(f"| {mode} | {sum(map(passed, samples))}/{repetitions} | {natural}/{repetitions} | {artifacts}/{repetitions} |")
    workload = results.get("settings", {}).get("SCIENCE_SPINE_CASE")
    verifier, comparison = {
        "calibration": (calibration_matches_reference, "calibration fixture, cleaning, OLS, drift and report"),
        "solar": (solar_matches_reference, "solar fixture, joined observations, per-site QA, group comparisons and report"),
    }.get(workload, (cohort_matches_reference, "cleaned-cohort"))
    reference = {mode: [r["id"] for r in samples if not verifier(root, r)]
                 for mode, samples in grouped.items()}
    for mode, mismatches in reference.items():
        lines += ["", f"Independent {comparison} recomputation for `{mode}` matched {repetitions - len(mismatches)}/{repetitions}."]
        if mismatches:
            lines.append(f"Artifact mismatches `{', '.join(mismatches)}`.")
    review_mismatches = []
    if workload == "solar" and not (root / "fork-prefix.json").exists():
        for mode, samples in grouped.items():
            observed, bound = zip(*(audit_solar_review(root, run) for run in samples), strict=True)
            review_mismatches.extend(run["id"] for run, present in zip(samples, observed, strict=True) if not present)
            lines.append(f"Complete per-site tool output in `{mode}` {sum(observed)}/{repetitions}; "
                         f"matches the current verified QC tool call in {sum(bound)}/{repetitions}.")
    if review_mismatches:
        lines.append(f"Runs missing the complete review output `{', '.join(review_mismatches)}`.")
    if results.get("settings", {}).get("SCIENCE_SPINE_CASE") == "audit":
        for mode, samples in grouped.items():
            mismatches = [run["id"] for run in samples if not model_risk_difference_matches(root, run)]
            lines += ["", f"Independent risk difference and Wald CI matched {repetitions - len(mismatches)}/{repetitions} for `{mode}`."]
            if mismatches:
                lines.append(f"Risk-difference artifacts to review `{', '.join(mismatches)}`.")
    usage_events = {run["id"]: [e for e in read_events(root, run) if e.get("type") == "model_usage"] for run in runs}
    reported_usage = sum(e.get("usageReported") is True for events in usage_events.values() for e in events)
    usage_mismatches = [run["id"] for run in runs if not usage_matches(run, usage_events[run["id"]])]
    lines += ["", f"Provider-reported usage events {reported_usage}/{sum(r['usageEvents'] for r in runs)}."]
    if usage_mismatches:
        lines.append(f"Usage audit failed for `{', '.join(usage_mismatches)}`.")
    if modes == ["dynamic-shadow"]:
        lines.extend(shadow_report(root, grouped["dynamic-shadow"]))
        return "\n".join(lines)
    triple = "projection-linked" in grouped
    baseline, projected = grouped["dynamic"], grouped["projection-linked" if triple else "projection"]
    projection_label = "Projection-linked" if triple else "Projection"
    if not all(map(passed, runs)):
        lines += ["", "Reported metrics include every run. A run that stopped naturally can still fail artifact validation."]
    lines += ["", f"| Metric | Dynamic mean | {projection_label} mean | Change | Dynamic P50 / P95 | {projection_label} P50 / P95 |", "|---|---:|---:|---:|---:|---:|"]
    for key, label in METRICS.items():
        lhs = [run[key] for run in baseline]
        rhs = [run[key] for run in projected]
        change = 100 * (mean(rhs) - mean(lhs)) / mean(lhs) if mean(lhs) else float("nan")
        lines.append(f"| {label} | {mean(lhs):,.2f} | {mean(rhs):,.2f} | {change:+.2f}% | "
                     f"{percentile(lhs, .5):,.2f} / {percentile(lhs, .95):,.2f} | "
                     f"{percentile(rhs, .5):,.2f} / {percentile(rhs, .95):,.2f} |")
    lines += ["", f"Percentiles use linear interpolation. D → P is Dynamic → {projection_label}.", "",
              "| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for lhs, rhs in zip(baseline, projected, strict=True):
        delta = rhs["totalTokens"] - lhs["totalTokens"]
        metrics = [f"{lhs[key]:,} → {rhs[key]:,}" for key in METRICS if key != "durationMs"]
        metrics.insert(3, f"{delta:+,}")
        metrics.append(f"{lhs['durationMs'] / 1000:.2f} → {rhs['durationMs'] / 1000:.2f}")
        e2e = " / ".join("PASS" if passed(run) else "FAIL" for run in (lhs, rhs))
        lines.append(f"| {lhs['repetition']} | {e2e} | {' | '.join(metrics)} |")
    input_wins = sum(rhs["inputTokens"] < lhs["inputTokens"] for lhs, rhs in zip(baseline, projected, strict=True))
    total_wins = sum(rhs["totalTokens"] < lhs["totalTokens"] for lhs, rhs in zip(baseline, projected, strict=True))
    lines += ["", f"Input-token improvements in {input_wins}/{repetitions} pairs. Total-token improvements in {total_wins}/{repetitions} pairs.", ""]
    if workload in ("calibration", "solar") and not (root / "fork-prefix.json").exists():
        valid = all(map(passed, runs)) and not any(reference.values()) and not usage_mismatches and not review_mismatches
        baseline_total = sum(run["totalTokens"] for run in baseline)
        projected_total = sum(run["totalTokens"] for run in projected)
        gate_checks = {
            "All samples pass natural end-to-end, independent artifact and usage audits": valid,
            "Mean total tokens decrease at least 5%": baseline_total > 0 and projected_total * 100 <= baseline_total * 95,
            "At least two thirds of pairs decrease input tokens": input_wins * 3 >= repetitions * 2,
            "Mean model turns do not increase": sum(run["modelTurns"] for run in projected) <= sum(run["modelTurns"] for run in baseline),
            "Mean tool calls do not increase": sum(run["toolCalls"] for run in projected) <= sum(run["toolCalls"] for run in baseline),
            "Model-visible projection observed": any(run["projectionAudit"]["applied"] for run in projected),
        }
        lines += ["", "### Rollout gate", ""]
        lines.extend(f"- {'PASS' if ok else 'FAIL'} · {criterion}" for criterion, ok in gate_checks.items())
        lines.append("")
    if triple:
        incumbent = grouped["projection"]
        lines += ["", "### Increment versus current Projection", "",
                  "| Metric | Current mean | Linked mean | Change | Dynamic P95 | Current P95 | Linked P95 |",
                  "|---|---:|---:|---:|---:|---:|---:|"]
        for key, label in METRICS.items():
            raw = [[run[key] for run in samples] for samples in (baseline, incumbent, projected)]
            current, linked = map(mean, raw[1:])
            change = 100 * (linked - current) / current if current else float("nan")
            p95 = " | ".join(f"{percentile(values, .95):,.2f}" for values in raw)
            lines.append(f"| {label} | {current:,.2f} | {linked:,.2f} | {change:+.2f}% | {p95} |")
        lines += ["", "| Group | Current E2E | Input | Output | Total | Linked Δ total | Turns | Tools | Seconds |",
                  "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
        for old, new in zip(incumbent, projected, strict=True):
            lines.append(f"| {old['repetition']} | {'PASS' if passed(old) else 'FAIL'} | {old['inputTokens']:,} | "
                         f"{old['outputTokens']:,} | {old['totalTokens']:,} | {new['totalTokens'] - old['totalTokens']:+,} | "
                         f"{old['modelTurns']} | {old['toolCalls']} | {old['durationMs']/1000:.2f} |")
        lines.append("")
        if workload == "solar":
            linked_turns = [linked_projection_turns(root, run) for run in projected]
            lines.append(f"Cross-call readouts actually replaced in {sum(linked_turns)} turns across "
                         f"{sum(turns > 0 for turns in linked_turns)}/{len(linked_turns)} runs. "
                         f"Counts by group `{dict(zip(pair_ids, linked_turns, strict=True))}`.")
        lines.extend(latency_evidence(root, grouped))
    for mode in (mode for mode in modes if mode != "dynamic"):
        audit, reasons, candidates, percentages, savings, first_turns = trace_audit(root, grouped[mode])
        lines.append(f"- `{mode}` had {audit['records']} gate records, {audit['admitted']} admitted candidates and "
                     f"{audit['model_input']} applications visible in model input across {audit['runs_with_projection']}/{repetitions} runs. "
                     f"Missing projection records on {audit['without_projection_record']} context traces.")
        lines.append(f"- `{mode}` skip reasons `{dict(reasons)}`.")
        if candidates:
            lines.append(f"- `{mode}` mean candidate savings {mean(candidates):,.2f} estimated history tokens per evaluated turn, excluding short histories.")
        if percentages:
            lines.append(f"- `{mode}` mean applied savings {mean(savings):,.2f} estimated history tokens per application. "
                         f"Compression P50/P95/max {percentile(percentages, .5):.2f}% / {percentile(percentages, .95):.2f}% / {max(percentages):.2f}%.")
        if first_turns:
            lines += ["", f"### {mode} trajectory after first model-visible projection", "",
                      "| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |",
                      "|---|---:|---:|---:|"]
            for run in grouped[mode]:
                first_turn = first_turns.get(run["id"])
                if first_turn is None:
                    lines.append(f"| {run['repetition']} | — | — | — |")
                else:
                    turns, calls = trajectory_after_projection(root, run, first_turn)
                    lines.append(f"| {run['repetition']} | {first_turn + 1} | {turns} | {calls} |")
            lines.append("")
    if (root / "fork-prefix.json").exists():
        lhs = baseline[0]
        lines += ["", "### Frozen-prefix first request", ""]
        for mode in modes:
            run = grouped[mode][0]
            usage = run.get("firstRequestUsage") or {}
            lines.append(f"- {mode} `{usage.get('inputTokens', 'missing')}` input tokens. Provider reported `{usage.get('providerReported', False)}`.")
        for rhs in (grouped[mode][0] for mode in modes if mode != "dynamic"):
            lines += ["", f"#### {rhs['mode']}", ""]
            first_projected = first_trace(root, rhs)
            if gate := first_projected.get("projection"):
                lines.append(f"- First-request selected path `{first_projected['selectedPath']}`, "
                             f"skip reason `{gate.get('skipReason', 'none')}`, estimated savings "
                             f"{gate['estimatedSavingsTokens']:,} history tokens ({gate['estimatedSavingsPercent']:.2f}%).")
            for description, expected in canonical_audit_of_first_fork_input(root, lhs, rhs).items():
                lines.append(f"- {description}. {'PASS' if expected else 'FAIL'}.")
    for run in runs:
        if not passed(run):
            errors = ", ".join([run.get("error", ""), *run["artifactValidation"]["errors"]]).strip(", ")
            lines += ["", f"- `{run['id']}` failed. {errors} See its `summary.json` and `events.jsonl`."]
    lines += ["", f"Source `{results_file}` and per-run `context-traces`, benchmark directory `{root.name}`.", ""]
    return "\n".join(lines)


def merge_shards(root):
    manifest = None
    pending = []
    summary_files = sorted(root.glob("pairs-*/results.json"))
    if len(summary_files) != 4:
        raise ValueError("Expected four completed shard manifests")
    for source in summary_files:
        shard = read_json(source)
        expected_ranges = {"pairs-1": (1, 3), "pairs-4": (4, 3), "pairs-7": (7, 2), "pairs-9": (9, 2)}
        if (shard["firstPair"], shard["repetitions"]) != expected_ranges[source.parent.name]:
            raise ValueError(f"Unexpected pair range in {source}")
        config = {key: shard[key] for key in ("model", "modes", "settings", "repositoryRoot")}
        if manifest is not None and config != manifest:
            raise ValueError(f"Mismatched experiment configuration in {source}")
        manifest = config
        for run in shard["summaries"]:
            pending.append({**run, "id": f"{source.parent.name}/{run['id']}"})
    aggregate = {**manifest, "repetitions": 10, "summaries": pending,
                 "shards": [str(source.relative_to(root)) for source in summary_files]}
    (root / "results.json").write_text(json.dumps(aggregate, indent=2), encoding="utf-8")


def handoff_report(roots):
    """Audit the three model inputs and every continuation of the handoff experiment."""
    modes = ("projection", "projection-linked", "projection-handoff")
    lines = ["# Stage handoff frozen-prefix evidence", ""]
    outcomes = []
    by_mode = {mode: [] for mode in modes}
    seen = set()
    for root in roots:
        results = read_json(root / "results.json")
        frozen = read_json(root / "fork-prefix.json")
        seed = root / frozen["seedId"]
        history_bytes = (seed / "final-messages.json").read_bytes()
        history = json.loads(history_bytes)
        workspace = seed / "workspace"
        review = (workspace / "site_qc.csv").read_text(encoding="utf-8").strip()
        audited = audit_solar(workspace)
        model = results["model"]
        lines.extend([f"## {root.parent.name}", "", f"Model `{model}`. Seed `{frozen['seedId']}`.", "",
                      "| Pair | Mode | Audit | First input | Input | Output | Total | Turns | Tools | First projected outputs | Seconds |",
                      "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"])
        grouped = {}
        for run in results["summaries"]:
            repetition = run["repetition"]
            if (repetition, run["mode"]) in seen:
                raise ValueError("Duplicate repetition and mode")
            seen.add((repetition, run["mode"]))
            grouped.setdefault(repetition, {})[run["mode"]] = run
        for repetition, group in sorted(grouped.items()):
            if set(group) != set(modes):
                raise ValueError("Incomplete handoff comparison")
            first = {mode: first_trace(root, group[mode])["llmInput"] for mode in modes}
            base = first[modes[0]]
            for mode in modes:
                run = group[mode]
                actual = first[mode]
                current = root / run["id"] / "workspace"
                usage = [event for event in read_events(root, run) if event.get("type") == "model_usage"]
                projected = {m.get("tool_call_id"): m for m in actual["history"]
                             if (m.get("additional_kwargs") or {}).get("scope_node_memory")}
                expected = {}
                for closure in frozen["closures"]:
                    source = closure.get("resultSource")
                    if not source:
                        continue
                    call_id = source["toolCallId"]
                    payload = {key: value for key, value in closure.items() if key != "resultSource"}
                    if mode == modes[2]:
                        payload = json.loads(json.dumps(payload))
                        fields = next(item["fields"] for item in payload["artifacts"] if item["path"] == "site_qc.csv")
                        fields.update(audited["handoff"][0])
                        fields["next_required"] = ("Complete sensitivity, then compare its results with groups.json in the report."
                                                  if audited["errors"][2] else "Use groups.json and sensitivity.json to compare rankings and explain exclusions in the report.")
                    for messages in (history, base["history"]):
                        result, = (m for m in messages if m.get("tool_call_id") == call_id)
                        if hashlib.sha256(result["content"].encode()).hexdigest() != source["contentSha256"] or review not in result["content"].replace("\r\n", "\n"):
                            raise ValueError("Frozen readout failed digest or full-table audit")
                    expected[call_id] = payload
                def unchanged_input(exclude):
                    return ({key: value for key, value in base.items() if key != "history"}
                            == {key: value for key, value in actual.items() if key != "history"}
                            and [m for m in base["history"] if m.get("tool_call_id") not in exclude]
                            == [m for m in actual["history"] if m.get("tool_call_id") not in exclude])
                first_usage = run.get("firstRequestUsage", {})
                checks = {
                    "frozen history hash": hashlib.sha256(history_bytes).hexdigest() == frozen["historySha256"],
                    "frozen workspace hashes": all(hashlib.sha256((workspace / name).read_bytes()).hexdigest() == digest for name, digest in frozen["workspaceSha256"].items()),
                    "first input isolation and payload": unchanged_input(projected) and (not projected if mode == modes[0] else bool(expected) and {key: read_projected_closure(msg) for key, msg in projected.items()} == expected),
                    "natural completion and five artifacts": passed(run) and solar_matches_reference(root, run),
                    "complete review version": (current / "site_qc.csv").read_bytes() == (workspace / "site_qc.csv").read_bytes(),
                    "provider usage reconciliation": usage_matches(run, usage) and bool(first_usage.get("providerReported")) and first_usage.get("inputTokens") == usage[0]["usage"]["inputTokens"],
                }
                failed = [label for label, valid in checks.items() if not valid]
                outcomes.append(not failed)
                by_mode[mode].append(run)
                lines.append(f"| {repetition} | {mode} | {'FAIL (' + ', '.join(failed) + ')' if failed else 'PASS'} | "
                             f"{first_usage.get('inputTokens', 0):,} | {run['inputTokens']:,} | {run['outputTokens']:,} | {run['totalTokens']:,} | "
                             f"{run['modelTurns']} | {run['toolCalls']} | {len(projected)} | {run['durationMs'] / 1000:.2f} |")
        lines.append("")
    lines.extend(["## Pooled continuation means", "", "| Mode | First input | Input | Output | Total | Turns | Tools |", "|---|---:|---:|---:|---:|---:|---:|"])
    averages = {}
    for mode, runs in by_mode.items():
        values = [mean(run.get("firstRequestUsage", {}).get("inputTokens", 0) for run in runs)]
        values.extend(mean(run[key] for run in runs) for key in ("inputTokens", "outputTokens", "totalTokens", "modelTurns", "toolCalls"))
        averages[mode] = values
        lines.append(f"| {mode} | " + " | ".join(f"{value:,.2f}" for value in values) + " |")
    baseline, _, handoff = averages.values()
    gate = all(outcomes) and handoff[0] < baseline[0] and handoff[3] < baseline[3] and handoff[4] <= baseline[4] and handoff[5] <= baseline[5]
    lines += ["", f"Audit {sum(outcomes)}/{len(outcomes)}. Continuation cost gate {'PASS' if gate else 'FAIL'}.", ""]
    return "\n".join(lines), all(outcomes)


def audit_workflow(root, run, workflow, review_history=()):
    directory = root / run["id"]
    name = "site_qc.csv" if workflow == "solar" else "cleaned.csv"
    model_events = list(read_events(root, run))
    table = (directory / "workspace" / name).read_text(encoding="utf-8").strip() if (directory / "workspace" / name).exists() else ""
    texts = [part.get("text", "") for event in model_events if event.get("type") == "tool_execution_end" and not event.get("isError")
             for part in (event.get("result") or {}).get("content", [])]
    texts.extend(msg.get("content", "") for msg in review_history if msg.get("role") == "tool")
    review = bool(table) and any(table in text.replace("\r\n", "\n") for text in texts if isinstance(text, str))
    artifacts = solar_matches_reference(root, run) if workflow == "solar" else calibration_matches_reference(root, run, 72)
    usage_events = [event for event in model_events if event.get("type") == "model_usage"]
    return passed(run) and artifacts and review and usage_matches(run, usage_events)


def adaptive_report(roots):
    lines = ["# Stage-aware shadow evidence", ""]
    eligible_workloads = []
    result_ok = True
    for root in roots:
        data = read_json(root / "results.json")
        workflow = data["settings"]["SCIENCE_SPINE_CASE"]
        lines += [f"## {root.parent.name}", "", f"Provider model `{data['model']}`.", "",
                  "| Run | E2E and usage | Bound while pending | Early preferred hits | Applied | Model turns |",
                  "|---|---|---:|---:|---:|---:|"]
        reasons = Counter()
        rejections = Counter()
        hit_runs = successful = total_turns = 0
        for run in data["summaries"]:
            policy = {row["turn"]: row for row in run["stagePolicy"]}
            preferred = {row["turn"] for row in run["projectionAudit"]["rows"] if row["projection"].get("preferredStageProjection") is True}
            eligible = {turn for turn, row in policy.items() if row["reason"] == "eligible"}
            early_hits = len({turn for turn in preferred if turn < run["modelTurns"] - 1})
            actual = run["projectionAudit"]["applied"]
            ok = audit_workflow(root, run, workflow) and preferred <= eligible and actual == 0 and len(policy) == run["modelTurns"]
            hit_runs += ok and early_hits > 0
            successful += ok
            total_turns += run["modelTurns"]
            reasons.update(row["reason"] for row in policy.values())
            rejections.update(row["projection"].get("preferredStageSkipReason", "none") for row in run["projectionAudit"]["rows"] if row["turn"] in eligible)
            lines.append(f"| {run['id']} | {'PASS' if ok else 'FAIL'} | {len(eligible)} | {early_hits} | {actual} | {run['modelTurns']} |")
        qualifies = successful == len(data["summaries"]) == 3 and hit_runs >= 2
        if qualifies:
            eligible_workloads.append(workflow)
        result_ok &= successful == len(data["summaries"])
        lines += ["", f"Early hit runs {hit_runs}/{len(data['summaries'])}. Audited model turns {total_turns}.",
                  f"Workflow decisions {dict(reasons)}.", f"Eligible-stage Context results {dict(rejections)}.", ""]
    lines += [f"Full-pair admission {'PASS for ' + ', '.join(eligible_workloads) if eligible_workloads else 'FAIL'}.", ""]
    return "\n".join(lines), result_ok


def recovery_report(root):
    lines = ["# Checkpoint recovery evidence", "",
             "| Pair | Natural resume / restart | Capture turns | Resume input / output / total | Restart input / output / total | Resume / restart seconds | Resume / restart QC write calls |",
             "|---|---|---:|---:|---:|---:|---:|"]
    accepted = 0
    metrics = []
    for group in sorted(root.glob("pair-*")):
        manifest = read_json(group / "resume" / "recovery-result.json")
        checkpoint = Path(manifest["checkpoint"])
        cap = read_json(checkpoint / "summary.json")
        resumed = manifest["result"]
        restarted, = read_json(group / "restart" / "results.json")["summaries"]
        history = read_json(checkpoint / "final-messages.json")
        source = checkpoint / "workspace"
        target = group / "resume" / resumed["id"] / "workspace"
        immutable_quality = all((source / name).read_bytes() == (target / name).read_bytes() for name in ("daily_clean.csv", "site_qc.csv"))
        cap_events = [e for e in read_events(checkpoint.parent, cap) if e.get("type") == "model_usage"]
        valid_capture = cap["completionMode"] == "acceptance_boundary" and cap["status"] == "completed" and usage_matches(cap, cap_events)
        resume_ok = (audit_workflow(group / "resume", resumed, "solar", history) and immutable_quality
                     and valid_capture and cap["processId"] == manifest["capturedBy"] != manifest["resumedBy"] == resumed["processId"])
        restart_ok = audit_workflow(group / "restart", restarted, "solar")
        accepted += resume_ok and restart_ok
        metrics.append((cap, resumed, restarted))
        def usage(run):
            return " / ".join(f"{run[key]:,}" for key in ("inputTokens", "outputTokens", "totalTokens"))
        lines.append(f"| {group.name} | {'PASS' if resume_ok else 'FAIL'} / {'PASS' if restart_ok else 'FAIL'} | {cap['modelTurns']} | "
                     f"{usage(resumed)} | {usage(restarted)} | {resumed['durationMs']/1000:.2f} / {restarted['durationMs']/1000:.2f} | "
                     f"{len(resumed['qualityWrites'])} / {len(restarted['qualityWrites'])} |")
    for label, modes in zip(("capture", "resume", "restart"), zip(*metrics)):
        lines.append("")
        for key in ("inputTokens", "outputTokens", "totalTokens", "modelTurns", "toolCalls", "durationMs"):
            lines.append(f"- {label} mean {key} {mean(row[key] for row in modes):,.2f}")
    lines += ["", f"Audit {accepted}/{len(metrics)} paired comparisons.", ""]
    return "\n".join(lines), accepted == len(metrics) > 0



def recovery_wire(directory):
    prefix = "[model-sse-summary] "
    usage_prefix = "[recovery-summary-usage] "
    lines = (directory / "runner.log").read_text(encoding="utf-8").splitlines()
    requests = [json.loads(line[len(prefix):]) for line in lines if line.startswith(prefix)]
    summary_usage = [json.loads(line[len(usage_prefix):]) for line in lines if line.startswith(usage_prefix)]
    return ([row for row in requests if row["purpose"] == "task"],
            [row for row in requests if row["purpose"] == "compaction"], summary_usage)


def contains_complete_table(output, table):
    normalized = output.replace("\r\n", "\n")
    return bool(table) and f"\n{table}\n" in f"\n{normalized}\n"


def recovery_progress(directory, run, reviewed, require_valid_grouping=False,
                      review_file="site_qc.csv", downstream_file="groups.json"):
    events = list(read_events(directory, run))
    workspace = directory / run["id"] / "workspace"
    table = (workspace / review_file).read_text(encoding="utf-8").rstrip()
    started_at = int((directory / "started-epoch-ms.txt").read_text()) / 1000
    tool_starts = [event for event in events if event.get("type") == "tool_execution_start"]
    tool_ids = [event["toolCallId"] for event in tool_starts]
    ends = [event for event in events if event.get("type") == "tool_execution_end"]
    tool_ends = {event["toolCallId"]: event for event in ends}
    receipts = [event for event in events if event.get("type") == "recovery_tool_artifacts"]
    receipt_ids = [event["toolCallId"] for event in receipts]
    if (set(tool_ends) != set(tool_ids) or len(tool_ends) != len(ends) or len(set(tool_ids)) != len(tool_ids)
            or receipt_ids != [call_id for call_id in tool_ids if call_id in set(receipt_ids)]):
        raise ValueError("tool receipt ledger does not match the execution events")
    evidence = {event["toolCallId"]: event for event in receipts}
    for start in tool_starts:
        call_id = start["toolCallId"]
        if call_id in evidence:
            continue
        # A missing script is rejected by workspace path resolution before the shell callback.
        end = tool_ends[call_id]
        path = (start.get("args") or {}).get("scriptPath")
        details = (end.get("result") or {}).get("details") or {}
        failure = details.get("error") or {}
        if (start.get("toolName") != "run_shell" or end.get("toolName") != "run_shell" or not path
                or end.get("isError") is not True or details.get("ok") is not False
                or failure.get("code") != "TOOL_EXECUTION_FAILED"
                or failure.get("message") != f"scriptPath does not exist in an authorized mount: {path}"):
            raise ValueError("tool receipt ledger does not match the execution events")
        evidence[call_id] = {"toolCallId": call_id, "changedArtifacts": [], "exitCode": None}
    accepted_groups = {e["toolCallId"] for e in events if e.get("type") == "recovery_grouping_validation" and e["accepted"]}
    waiting_for_table = not reviewed
    first_tool = None
    first_progress = None
    first_tool_progress = False
    repeated = 0
    probes = 0
    extra_calls = 0
    grouped = False
    for index, call_id in enumerate(tool_ids):
        receipt = evidence[call_id]
        end = tool_ends[call_id]
        changed = set(receipt["changedArtifacts"])
        success = not end.get("isError") and receipt["exitCode"] == 0
        parts = (end.get("result") or {}).get("content", [])
        display = success and any(contains_complete_table(part.get("text", ""), table)
                                  for part in parts if isinstance(part.get("text"), str))
        groups_written = downstream_file in changed
        if groups_written and waiting_for_table:
            raise ValueError(f"{downstream_file} changed before an earlier successful display of the current full QC table")
        valid_group = groups_written and (not require_valid_grouping or call_id in accepted_groups)
        accomplished_review = waiting_for_table and display
        duplicate_display = display and not accomplished_review
        invalid_group = require_valid_grouping and groups_written and not valid_group
        no_progress = not grouped and (not changed or invalid_group) and not accomplished_review
        if display:
            waiting_for_table = False
        repeated += duplicate_display
        probes += no_progress
        extra_calls += duplicate_display or no_progress
        grouped = grouped or valid_group
        if first_tool is None:
            if invalid_group:
                first_tool = "unvalidated grouping write"
            elif display and groups_written:
                first_tool = "grouping write + QC display"
            elif groups_written:
                first_tool = "grouping write"
            else:
                first_tool = "QC display" if display else "other"
        if first_progress is None and success and (accomplished_review or valid_group):
            first_progress = datetime.fromisoformat(end["at"]).timestamp() - started_at
            first_tool_progress = index == 0
    if not grouped or first_progress is None or waiting_for_table or first_progress < 0:
        raise ValueError("missing or invalid recovery progress evidence")
    return {"probe_calls": probes, "duplicate_reads": repeated, "extra_calls": extra_calls,
            "first_tool": first_tool, "progress_s": first_progress, "first_tool_progress": first_tool_progress}


def verified_display_receipt(history, table, artifact_sha):
    calls = Counter(call["id"] for msg in history if msg["role"] == "assistant" for call in msg.get("tool_calls", []))
    results = Counter(msg.get("tool_call_id") for msg in history if msg["role"] == "tool")
    preceding = set()
    for msg in history:
        if msg["role"] == "assistant":
            preceding.update(call["id"] for call in msg.get("tool_calls", [])
                             if call.get("function", {}).get("name") == "run_shell" and calls[call["id"]] == 1)
        call_id = msg.get("tool_call_id")
        content = msg.get("content")
        if (msg["role"] != "tool" or msg.get("name") != "run_shell" or call_id not in preceding
                or results[call_id] != 1 or not isinstance(content, str)):
            continue
        header, marker, stdout = content.partition("\nstdout:\n")
        if not marker:
            continue
        try:
            metadata = json.loads(header)
        except ValueError:
            continue
        if (isinstance(metadata, dict) and metadata.get("executionId") == call_id and metadata.get("state") == "completed"
                and type(metadata.get("exitCode")) is int and metadata["exitCode"] == 0
                and contains_complete_table(stdout.replace("\r\n", "\n").partition("\nstderr:\n")[0], table)):
            return {"toolCallId": call_id, "contentSha256": hashlib.sha256(content.encode()).hexdigest(), "artifactSha256": artifact_sha}
    return None


def audit_retirement_lifecycle(directory, run, source, arm, expected_receipt, calibration=False):
    stage = "batch-fit" if calibration else "technology-grouping"
    downstream_file = "fits.json" if calibration else "groups.json"
    inputs = {"instrument.csv", "cleaned.csv", "qc.json"} if calibration else {"sites.csv", "measurements.csv", "daily_clean.csv", "site_qc.csv"}
    events = list(read_events(directory, run))
    grouping = [e for e in events if e.get("type") == "recovery_grouping_validation" and e["accepted"]]
    retired = [e for e in events if e.get("type") == "recovery_display_retired"]
    if not grouping:
        raise ValueError(f"{arm} has no validated grouping boundary")
    accepted = grouping[0]
    closure = accepted["closure"]
    if (closure["stageId"] != stage or closure["toolCallId"] != accepted["toolCallId"]
            or set(closure["inputRevisions"]) != inputs
            or any(hashlib.sha256((source / name).read_bytes()).hexdigest() != version
                   for name, version in closure["inputRevisions"].items())):
        raise ValueError(f"{arm} grouping boundary does not refer to the verified inputs")
    group_end = next(i for i, e in enumerate(events) if e.get("type") == "tool_execution_end"
                     and e["toolCallId"] == accepted["toolCallId"] and not e.get("isError"))
    usage_after = [e["usage"] for e in events[group_end + 1:] if e.get("type") == "model_usage"]
    if not usage_after:
        raise ValueError(f"{arm} omitted the rest of the workflow after grouping")
    final_group, = grouping[-1]["closure"]["artifacts"]
    if (final_group["path"] != downstream_file or final_group["revision"] != hashlib.sha256(
            (directory / run["id"] / "workspace" / downstream_file).read_bytes()).hexdigest()):
        raise ValueError(f"{arm} final grouping artifact differs from the verified version")
    if arm == "retire-display" and expected_receipt:
        if len(retired) != 1 or retired[0]["receipt"] != expected_receipt or retired[0]["grouping"] != closure:
            raise ValueError("display evidence retirement is missing or references a different grouping closure")
        turn = retired[0]["turn"]
        if turn != sum(e.get("type") == "model_usage" for e in events[:group_end]):
            raise ValueError("display evidence did not retire immediately after validated grouping")
        directory_trace = directory / run["id"] / "context-traces"
        traces = sorted(directory_trace.rglob("turn-*.json"))
        if len(traces) <= turn or turn < 1:
            raise ValueError("missing before/after display retirement traces")
        call_id = expected_receipt["toolCallId"]
        for i, path in enumerate(traces):
            messages = read_json(path)["llmInput"]["history"]
            has_call = any(call.get("id") == call_id for m in messages for call in m.get("tool_calls", []))
            has_result = any(m.get("tool_call_id") == call_id for m in messages)
            if has_call != (i < turn) or has_result != (i < turn):
                raise ValueError(f"display evidence pair lifecycle disagrees with model trace {path.name}")
    elif retired:
        raise ValueError(f"{arm} retired unexpected display evidence")
    return {"post_group_input": sum(u["inputTokens"] for u in usage_after),
            "post_group_output": sum(u["outputTokens"] for u in usage_after),
            "post_group_turns": len(usage_after),
            "retired_units": len(retired)}


def recovery_metrics(directories, runs):
    metrics = {}
    for arm, run in runs.items():
        task, compaction, summary_usage = recovery_wire(directories[arm])
        usage_keys = ("inputTokens", "outputTokens", "totalTokens")
        if len(summary_usage) != len(compaction) or any(
                not item or any(not isinstance(item.get(key), int) or item[key] < 0 for key in usage_keys)
                for item in summary_usage):
            raise ValueError(f"{arm} compaction request usage is incomplete")
        compact_usage = {key: sum(item[key] for item in summary_usage) for key in usage_keys}
        task_usage = [e for e in read_events(directories[arm], run) if e.get("type") == "model_usage"]
        first = run["firstRequestUsage"]
        if (len(task) != run["modelTurns"] or not first["providerReported"]
                or first["inputTokens"] != task_usage[0]["usage"]["inputTokens"]):
            raise ValueError(f"{arm} task request count or first usage differs from the usage ledger")
        metrics[arm] = {"first": first["inputTokens"], "input": run["inputTokens"], "output": run["outputTokens"],
                        "total": run["totalTokens"], "all_input": run["inputTokens"] + compact_usage["inputTokens"],
                        "all_output": run["outputTokens"] + compact_usage["outputTokens"],
                        "all_total": run["totalTokens"] + compact_usage["totalTokens"],
                        "turns": run["modelTurns"], "tools": run["toolCalls"],
                        "writes": len(run["qualityWrites"]), "wall": float((directories[arm] / "wall-seconds.txt").read_text()),
                        "task_s": sum(req["elapsedMs"] for req in task) / 1000,
                        "compact_s": sum(req["elapsedMs"] for req in compaction) / 1000, "compact_n": len(compaction),
                        "retries": sum(req["retries"] for req in [*task, *compaction])}
    return metrics


def audit_recovery_trial(group, next_step=False, workspace_handoff=False, display_receipt=False, diagnostic=False,
                         display_evidence=False, retire_display=False):
    if retire_display:
        display_evidence = True
        arms = ("capture", "handoff", "evidence", "retire-display") if diagnostic else ("capture", "resume", "compact", "handoff", "retire-display")
    elif display_evidence:
        arms = ("capture", "handoff", "evidence") if diagnostic else ("capture", "resume", "compact", "handoff", "evidence")
    elif diagnostic:
        arms = ("capture", "handoff", "receipt")
    elif display_receipt:
        arms = ("capture", "resume", "compact", "handoff", "receipt")
    elif workspace_handoff:
        arms = ("capture", "resume", "compact", "next-step", "handoff")
    elif next_step:
        arms = ("capture", "resume", "compact", "restart", "next-step")
    else:
        arms = ("capture", "resume", "compact", "restart")
    directories = {arm: group / arm for arm in arms}
    failed = [arm for arm, directory in directories.items() if not (directory / "exit-code.txt").exists()
              or (directory / "exit-code.txt").read_text().strip() != "0"]
    if failed:
        raise ValueError(f"runner failed or absent ({', '.join(failed)})")
    cap_dir = directories["capture"]
    seed = cap_dir / read_json(cap_dir / "checkpoint-index.json")["id"]
    history = read_json(seed / "final-messages.json")
    manifest = read_json(seed / "checkpoint.json")
    capture = read_json(seed / "summary.json")
    source = seed / "workspace"
    quality_files = ("daily_clean.csv", "site_qc.csv")
    original_prompt, = [msg["content"] for msg in history if msg["role"] == "user"]
    table = (source / "site_qc.csv").read_text().rstrip()
    reviewed = any(msg["role"] == "tool" and isinstance(msg.get("content"), str)
                   and '"exitCode":0' in msg["content"]
                   and contains_complete_table(msg["content"].partition("\nstdout:\n")[2], table)
                   for msg in history)
    expected_receipt = None
    expected_pair = []
    if display_receipt or display_evidence:
        digest = hashlib.sha256((source / "site_qc.csv").read_bytes()).hexdigest()
        if manifest["hashes"]["workspace/site_qc.csv"] != digest:
            raise ValueError("the frozen artifact differs from the checkpoint manifest")
        expected_receipt = verified_display_receipt(history, table, digest)
        if display_evidence and bool(expected_receipt) != reviewed:
            raise ValueError("review assignment differs from independently verified source")
        if display_evidence and expected_receipt:
            call_id = expected_receipt["toolCallId"]
            call, = [call for msg in history if msg["role"] == "assistant"
                     for call in msg.get("tool_calls", []) if call["id"] == call_id]
            result, = [msg for msg in history if msg["role"] == "tool" and msg["tool_call_id"] == call_id]
            expected_pair = [{"role": "assistant", "content": None, "tool_calls": [call]}, result]
    if (next_step or display_receipt or display_evidence) and (group / "capture-review.txt").read_text().strip() != ("displayed" if reviewed else "pending"):
        raise ValueError("frozen checkpoint review state differs from the trial assignment")
    runs = {"capture": capture}
    models = {}
    history_modes = {"resume": "full", "compact": "compact", "next-step": "next-step",
                     "handoff": "handoff", "receipt": "receipt", "evidence": "evidence", "retire-display": "retire-display"}
    recovery_arms = {arm: history_modes[arm] for arm in arms if arm in history_modes}
    for arm, history_mode in recovery_arms.items():
        receipt = read_json(directories[arm] / "recovery-result.json")
        run = runs[arm] = receipt["result"]
        models[arm] = receipt["model"]
        if (Path(receipt["checkpoint"]).resolve() != seed.resolve() or receipt["historyMode"] != history_mode
                or capture["processId"] != manifest["capturedBy"] or manifest["capturedBy"] != receipt["capturedBy"]
                or capture["processId"] == receipt["resumedBy"] or receipt["resumedBy"] != run["processId"]):
            raise ValueError(f"{arm} did not resume from the shared snapshot in a new process")
        workspace = directories[arm] / run["id"] / "workspace"
        if run["qualityWrites"] or any((source / name).read_bytes() != (workspace / name).read_bytes()
                                       for name in (*quality_files, "sites.csv", "measurements.csv")):
            raise ValueError(f"{arm} changed accepted files or inputs")
        if not audit_workflow(directories[arm], run, "solar", history):
            raise ValueError(f"{arm} failed natural-completion, independent artifact, review or usage audit")
        if arm in ("compact", "next-step", "handoff", "receipt", "evidence", "retire-display"):
            arm_reviewed = bool(expected_receipt) if arm == "receipt" else reviewed
            state = receipt["compactRecovery"]
            expected_state = {"acceptedStage": "site-quality",
                              "artifactSha256": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in quality_files},
                              "review": "already displayed" if arm_reviewed else "still required",
                              "pendingStages": ["technology-grouping", "complete-site-sensitivity", "solar-report"]}
            sent_history = first_trace(directories[arm], run)["llmInput"]["history"]
            *prior, sent = sent_history
            uses_evidence = arm in ("evidence", "retire-display")
            if prior != (expected_pair if uses_evidence else []):
                raise ValueError(f"{arm} first model history differs from the expected evidence pair")
            if uses_evidence and receipt.get("evidenceReceipt") != expected_receipt:
                raise ValueError("candidate evidence receipt differs from the frozen trajectory")
            text = sent["content"]
            if uses_evidence:
                baseline_input = first_trace(directories["handoff"], runs["handoff"])["llmInput"]
                candidate_input = first_trace(directories[arm], run)["llmInput"]
                if [sent] != baseline_input["history"] or any(candidate_input[key] != baseline_input[key]
                                                                for key in ("systemPrompt", "tools")):
                    raise ValueError("first model input changed beyond the evidence pair")
                if arm == "retire-display" and "evidence" in runs and candidate_input != first_trace(directories["evidence"], runs["evidence"])["llmInput"]:
                    raise ValueError("retirement and continuous evidence differ before grouping")
            sent_state, _ = json.JSONDecoder().raw_decode(text[text.index("{\n"):])
            if (sent["role"] != "user" or not text.endswith("Original task:\n" + original_prompt)
                    or state != expected_state):
                raise ValueError(f"{arm} first model input failed audit")
            if arm == "next-step":
                audit = audit_solar(source)
                expected_step = {"firstPending": "technology-grouping" if reviewed else "display-quality-table",
                                 "qualityFacts": audit["facts"][0], "downstreamFields": audit["handoff"][0]}
                if audit["errors"][0] or receipt["recoveryStep"] != expected_step or sent_state != {**expected_state, **expected_step}:
                    raise ValueError("first pending action or verified QC facts differ from independent audit")
            elif arm in ("handoff", "receipt", "evidence", "retire-display"):
                accepted_files = [{"path": name, "sha256": digest} for name, digest in expected_state["artifactSha256"].items()]
                accepted_files[1]["columns"] = table.splitlines()[0].split(",")
                expected_action = {"input": "site_qc.csv", "command": "cat site_qc.csv"}
                if arm_reviewed:
                    expected_action = {"input": "site_qc.csv", "output": "groups.json", "groupBy": "technology",
                                       "value": "mean_index", "weighting": "equal per site", "groups": ["mono", "poly", "thin_film"],
                                       "outputFields": ["sites", "mean_index"]}
                expected_handoff = {"acceptedStage": expected_state["acceptedStage"], "review": expected_state["review"],
                                    "acceptedFiles": accepted_files, "firstPending": "technology-grouping" if arm_reviewed else "display-quality-table",
                                    "nextAction": expected_action, "pendingStages": expected_state["pendingStages"]}
                if arm == "receipt" and expected_receipt:
                    expected_handoff["displayReceipt"] = expected_receipt
                if audit_solar(source)["errors"][0] or sent_state != expected_handoff or receipt["recoveryHandoff"] != expected_handoff:
                    raise ValueError("workspace handoff first model input differs from the verified files or pending action")
            elif sent_state != expected_state:
                raise ValueError("first compact model input differs from the verified state")
    if "restart" in directories:
        restart_manifest = read_json(directories["restart"] / "results.json")
        runs["restart"], = restart_manifest["summaries"]
        models["restart"] = restart_manifest["model"]
        if not audit_workflow(directories["restart"], runs["restart"], "solar"):
            raise ValueError("restart failed natural-completion, independent artifact, review or usage audit")
    if len(set(models.values())) != 1:
        raise ValueError("model differs across arms")
    capture_events = [e for e in read_events(cap_dir, capture) if e.get("type") == "model_usage"]
    if not (capture["completionMode"] == "acceptance_boundary" and capture["status"] == "completed" and usage_matches(capture, capture_events)):
        raise ValueError("capture failed acceptance-boundary or usage audit")
    metrics = recovery_metrics(directories, runs)
    for arm in (name for name in arms if name != "capture"):
        if next_step or display_receipt or display_evidence:
            try:
                arm_reviewed = bool(expected_receipt) if arm == "receipt" else reviewed and arm != "restart"
                metrics[arm].update(recovery_progress(directories[arm], runs[arm], arm_reviewed, require_valid_grouping=retire_display))
            except ValueError as error:
                raise ValueError(f"{arm}: {error}") from error
        if retire_display:
            metrics[arm].update(audit_retirement_lifecycle(directories[arm], runs[arm], source, arm, expected_receipt))
        metrics[arm]["full_tokens"] = metrics[arm]["all_total"] + (metrics["capture"]["all_total"] if arm != "restart" else 0)
        metrics[arm]["full_wall"] = metrics[arm]["wall"] + (metrics["capture"]["wall"] if arm != "restart" else 0)
    return metrics, next(iter(models.values())), reviewed


def compact_recovery_report(root, expected_pairs):
    lines = ["# Compact recovery evidence", "",
             "Task and compaction usage are reconciled separately. All-request totals include both.", "",
             "| Block | Arm | First input | Task input / output / total | All request total | Turns / tools / QC writes | Runner s | Task request s | Compaction count / s | Retries |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    trials, failures, models, reviews = [], [], set(), []
    for i in range(1, expected_pairs + 1):
        try:
            trial, model, reviewed = audit_recovery_trial(root / f"pair-{i}")
        except (OSError, KeyError, ValueError, StopIteration) as error:
            failures.append(f"- Block {i} FAIL ({error})")
            continue
        trials.append(trial)
        models.add(model)
        reviews.append(f"- Block {i} QC table already displayed at capture: {reviewed}")
        for arm, row in trial.items():
            lines.append(f"| {i} | {arm} | {row['first']:,} | {row['input']:,} / {row['output']:,} / {row['total']:,} | "
                         f"{row['all_total']:,} | {row['turns']} / {row['tools']} / {row['writes']} | {row['wall']:.3f} | {row['task_s']:.3f} | "
                         f"{row['compact_n']} / {row['compact_s']:.3f} | {row['retries']} |")
    valid = len(trials) == expected_pairs and len(models) == 1
    lines += ["", f"Correctness audit: {len(trials)}/{expected_pairs} blocks PASS.", *reviews, *failures, ""]
    if valid:
        lines += [f"Model: {next(iter(models))}", "", "| Mean | Full | Compact | Restart |", "|---|---:|---:|---:|"]
        arms = ("resume", "compact", "restart")
        for key in ("first", "all_input", "all_output", "all_total", "turns", "tools", "wall", "task_s", "compact_n", "compact_s", "full_tokens", "full_wall"):
            values = " | ".join(f"{mean(trial[arm][key] for trial in trials):,.2f}" for arm in arms)
            lines.append(f"| {key} | {values} |")
        saving = median(100 * (1 - trial["compact"]["first"] / trial["resume"]["first"]) for trial in trials)
        delta_s = median(trial["compact"]["wall"] - trial["resume"]["wall"] for trial in trials)
        restart_delta_s = median(trial["compact"]["wall"] - trial["restart"]["wall"] for trial in trials)
        lines += ["", f"- Paired median first task input reduction vs full history: {saving:.2f}%",
                  f"- Paired median runner seconds delta vs full history: {delta_s:+.3f}",
                  f"- Paired median runner seconds delta vs restart: {restart_delta_s:+.3f}"]
        if models != {"controlled-stub"}:
            lines.append(f"- Predeclared enlargement gate (>=15% first input reduction and lower wall latency vs full): "
                         f"{'PASS' if saving >= 15 and delta_s < 0 else 'FAIL'}")
    return "\n".join(lines) + "\n", valid


def next_step_recovery_report(root, expected_pairs, workspace_handoff=False, display_receipt=False, diagnostic=False,
                              display_evidence=False, retire_display=False):
    if retire_display:
        display_evidence = True
        heading = "Display retirement diagnostic" if diagnostic else "Display retirement"
    elif display_evidence:
        heading = "Display evidence diagnostic" if diagnostic else "Display evidence"
    else:
        heading = "Display receipt diagnostic" if diagnostic else "Display receipt" if display_receipt else "Workspace handoff" if workspace_handoff else "Next-step"
    lines = [f"# {heading} recovery evidence", "",
             "Each block has a single frozen checkpoint for all resumption arms. All-request usage includes compaction.", "",
             "| Block | QC state | Arm | First input | All input / output / total | Model turns / tools / QC writes | First tool effect | Pre-group no-progress calls | Repeated full-table prints | First progress s | Runner s | Task model s | Compaction count / s |",
             "|---|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|"]
    trials, failures, models, states = [], [], set(), []
    for i in range(1, expected_pairs + 1):
        try:
            trial, model, reviewed = audit_recovery_trial(root / f"pair-{i}", next_step=True, workspace_handoff=workspace_handoff,
                                                         display_receipt=display_receipt, diagnostic=diagnostic,
                                                         display_evidence=display_evidence, retire_display=retire_display)
        except (OSError, KeyError, ValueError, StopIteration) as error:
            failures.append(f"- Block {i} FAIL ({error})")
            continue
        trials.append(trial)
        models.add(model)
        state = "displayed" if reviewed else "pending"
        states.append(state)
        for arm, row in trial.items():
            lines.append(f"| {i} | {state} | {arm} | {row['first']:,} | {row['all_input']:,} / {row['all_output']:,} / {row['all_total']:,} | "
                         f"{row['turns']} / {row['tools']} / {row['writes']} | {row.get('first_tool', '—')} | "
                         f"{row.get('probe_calls', '—')} | {row.get('duplicate_reads', '—')} | {row.get('progress_s', 0):.3f} | "
                         f"{row['wall']:.3f} | {row['task_s']:.3f} | {row['compact_n']} / {row['compact_s']:.3f} |")
    valid = len(trials) == expected_pairs and len(models) == 1
    lines += ["", f"Correctness audit {len(trials)}/{expected_pairs} blocks PASS.", *failures, ""]
    if not valid:
        return "\n".join(lines) + "\n", False
    arms = tuple(arm for arm in trials[0] if arm != "capture")
    label = {"resume": "Full", "compact": "Compact", "next-step": "Next step", "handoff": "Handoff", "receipt": "Receipt", "evidence": "Evidence", "retire-display": "Retirement", "restart": "Restart"}
    lines += [f"Model `{next(iter(models))}`. Capture states {dict(Counter(states))}.", "",
              "| Mean | " + " | ".join(label[arm] for arm in arms) + " |", "|---|" + "---:|" * len(arms)]
    keys = ("first", "all_input", "all_output", "all_total", "turns", "tools", "probe_calls", "duplicate_reads", "extra_calls", "progress_s", "wall", "full_tokens", "full_wall")
    if retire_display:
        keys += ("post_group_input", "post_group_output", "post_group_turns", "retired_units")
    for key in keys:
        values = " | ".join(f"{mean(trial[arm][key] for trial in trials):,.2f}" for arm in arms)
        lines.append(f"| {key} | {values} |")
    if workspace_handoff or display_receipt or display_evidence:
        candidate = "retire-display" if retire_display else "evidence" if display_evidence else "receipt" if display_receipt else "handoff"
        comparison = "handoff" if display_receipt or display_evidence else "next-step"
        first_saving = (median(100 * (1 - trial[candidate]["first"] / trial["resume"]["first"]) for trial in trials)
                        if "resume" in arms else None)
        first_counts = {state: sum(trial[candidate]["first_tool_progress"] for trial, observed in zip(trials, states)
                                   if observed == state) for state in ("pending", "displayed")}
        first_count = sum(first_counts.values())
        wall_deltas = {arm: median(trial[candidate]["wall"] - trial[arm]["wall"] for trial in trials)
                       for arm in (comparison, "compact", "resume") if arm in arms}
        extra_deltas = {arm: sum(trial[candidate]["extra_calls"] - trial[arm]["extra_calls"] for trial in trials)
                        for arm in (comparison, "compact") if arm in arms}
        lines += ["", f"- First-tool progress {first_count}/{len(trials)} in {candidate} ({first_counts})."]
        if first_saving is not None:
            lines.append(f"- Paired median first input reduction vs full {first_saving:.2f}%.")
        lines += [f"- Vs {arm} paired median runner seconds {delta:+.3f}." for arm, delta in wall_deltas.items()]
        lines += [f"- Vs {arm} deduplicated extra calls {delta:+d}." for arm, delta in extra_deltas.items()]
        for arm in ("capture", *arms):
            lines.append(f"- {arm} usage reconciled for {sum(trial[arm]['turns'] for trial in trials)} task requests "
                         f"and {sum(trial[arm]['compact_n'] for trial in trials)} compaction requests.")
        if retire_display and diagnostic:
            post_delta = mean(t[candidate]["post_group_input"] - t["evidence"]["post_group_input"] for t in trials)
            baseline_first = sum(t["handoff"]["first_tool_progress"] for t in trials)
            retained_first = sum(t["evidence"]["first_tool_progress"] for t in trials)
            advance = (models != {"controlled-stub"} and len(trials) == states.count("displayed") == 3
                       and first_count >= 2 and post_delta < 0)
            lines += [f"- First-tool accepted grouping: handoff {baseline_first}/{len(trials)}, evidence {retained_first}/{len(trials)}.",
                      f"- Vs evidence mean post-group business input tokens {post_delta:+,.2f}.",
                      f"- Predeclared diagnostic gate **{'PASS' if advance else 'FAIL'}**."]
        elif display_evidence and diagnostic:
            repeats = {arm: sum(trial[arm]["duplicate_reads"] for trial in trials) for arm in arms}
            baseline_first = sum(trial["handoff"]["first_tool_progress"] for trial in trials)
            lines += [f"- Baseline first-tool progress {baseline_first}/{len(trials)}.",
                      f"- Repeated full-table prints: baseline {repeats['handoff']}, evidence {repeats['evidence']}."]
            advance = (models != {"controlled-stub"} and len(trials) == states.count("displayed") == 3
                       and first_count >= 2 and repeats["evidence"] < repeats["handoff"])
            lines.append(f"- Predeclared diagnostic gate **{'PASS' if advance else 'FAIL'}**.")
        if models != {"controlled-stub"} and not diagnostic:
            gate = (len(trials) == 6 and states.count("pending") == states.count("displayed") == 3
                    and first_count >= 5 and min(first_counts.values()) >= 2 and first_saving >= 15
                    and all(delta < 0 for delta in (*wall_deltas.values(), *extra_deltas.values())))
            if display_evidence:
                delta = mean(trial[candidate]["all_total"] - trial[comparison]["all_total"] for trial in trials)
                lines.append(f"- Vs handoff mean all-request total tokens {delta:+,.2f}.")
                gate = gate and delta <= 0
            lines.append(f"- Predeclared cross-workload gate **{'PASS' if gate else 'FAIL'}**.")
        return "\n".join(lines) + "\n", True

    def median_delta(key, ref):
        return median(trial["next-step"][key] - trial[ref][key] for trial in trials)
    first_saving = median(100 * (1 - trial["next-step"]["first"] / trial["resume"]["first"]) for trial in trials)
    probe_delta = sum(trial["next-step"]["probe_calls"] - trial["compact"]["probe_calls"] for trial in trials)
    repeat_delta = sum(trial["next-step"]["duplicate_reads"] - trial["compact"]["duplicate_reads"] for trial in trials)
    extra_delta = sum(trial["next-step"]["extra_calls"] - trial["compact"]["extra_calls"] for trial in trials)
    lines += ["", f"- Paired median first input reduction vs full {first_saving:.2f}%.",
              f"- Paired median runner seconds vs compact {median_delta('wall', 'compact'):+.3f}.",
              f"- Paired median runner seconds vs full {median_delta('wall', 'resume'):+.3f}.",
              f"- Paired median runner seconds vs restart {median_delta('wall', 'restart'):+.3f}.",
              f"- Aggregate pre-group no-progress calls vs compact {probe_delta:+d}, repeated full-table prints {repeat_delta:+d}, and deduplicated extra calls {extra_delta:+d}."]
    if models != {"controlled-stub"}:
        adequate_coverage = states.count("pending") >= 3 and states.count("displayed") >= 3
        gate = adequate_coverage and extra_delta < 0 and median_delta("wall", "compact") < 0 and median_delta("wall", "resume") < 0 and first_saving >= 15
        lines.append(f"- Predeclared cross-workload gate **{'PASS' if gate else 'FAIL'}**.")
    return "\n".join(lines) + "\n", True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Benchmark output directory containing results.json")
    parser.add_argument("--results", default="results.json", help="Manifest file relative to the benchmark output directory")
    parser.add_argument("--adaptive-dir", type=Path, action="append", default=[], help="Additional adaptive shadow workload to audit")
    parser.add_argument("--recovery", action="store_true", help="Audit paired recovery results")
    parser.add_argument("--handoff-dir", type=Path, action="append", default=[], help="Additional handoff cohort to audit")
    parser.add_argument("--merge-shards", action="store_true", help="Merge the fixed ten-pair audit experiment")
    parser.add_argument("--compact-recovery", action="store_true", help="Audit the three-arm recovery experiment")
    parser.add_argument("--next-step-recovery", action="store_true", help="Audit next-step recovery and three comparison arms")
    parser.add_argument("--workspace-handoff-recovery", action="store_true", help="Audit verified workspace handoff against three recovery baselines")
    parser.add_argument("--display-receipt-recovery", action="store_true", help="Audit display receipts against three recovery baselines")
    parser.add_argument("--receipt-diagnostic", action="store_true", help="Audit the two-arm reused-checkpoint diagnostic")
    parser.add_argument("--expected-pairs", type=int, default=3, help="Required count of three-arm blocks")
    parser.add_argument("--display-evidence-recovery", action="store_true", help="Audit retained tool evidence against three baselines")
    parser.add_argument("--evidence-diagnostic", action="store_true", help="Audit the paired retained-evidence diagnostic")
    parser.add_argument("--retire-display-recovery", action="store_true", help="Audit retirement after accepted grouping")
    parser.add_argument("--retire-display-diagnostic", action="store_true", help="Audit handoff, retained evidence, and evidence retirement")
    args = parser.parse_args()
    retire_display = args.retire_display_recovery or args.retire_display_diagnostic
    display_evidence = args.display_evidence_recovery or args.evidence_diagnostic or retire_display
    display_receipt = args.display_receipt_recovery or args.receipt_diagnostic
    if args.compact_recovery or args.next_step_recovery or args.workspace_handoff_recovery or display_receipt or display_evidence:
        if args.expected_pairs < 1:
            parser.error("--expected-pairs must be positive")
        if args.next_step_recovery or args.workspace_handoff_recovery or display_receipt or display_evidence:
            text, valid = next_step_recovery_report(args.directory, args.expected_pairs, workspace_handoff=args.workspace_handoff_recovery,
                                                    display_receipt=display_receipt, display_evidence=display_evidence,
                                                    diagnostic=args.receipt_diagnostic or args.evidence_diagnostic or args.retire_display_diagnostic,
                                                    retire_display=retire_display)
        else:
            text, valid = compact_recovery_report(args.directory, args.expected_pairs)
        print(text, end="")
        if not valid:
            raise SystemExit(1)
    elif args.adaptive_dir or args.recovery:
        text, valid = recovery_report(args.directory) if args.recovery else adaptive_report([args.directory, *args.adaptive_dir])
        print(text, end="")
        if not valid:
            raise SystemExit(1)
    elif args.handoff_dir:
        text, valid = handoff_report([args.directory, *args.handoff_dir])
        print(text, end="")
        if not valid:
            raise SystemExit(1)
    elif args.merge_shards:
        merge_shards(args.directory)
        (args.directory / "paired-evidence.md").write_text(report(args.directory, args.results), encoding="utf-8")
    else:
        print(report(args.directory, args.results), end="")


if __name__ == "__main__":
    main()
