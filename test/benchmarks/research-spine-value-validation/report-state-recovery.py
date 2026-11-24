#!/usr/bin/env python3
"""Independently audit paired checkpoint-state recovery from persisted evidence."""
import argparse
import hashlib
import importlib.util
import json
from collections import Counter
from pathlib import Path
from statistics import mean, median

_spec = importlib.util.spec_from_file_location("paired", Path(__file__).with_name("report-paired.py"))
paired = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(paired)
ARMS = ("full", "by-state")
SLOW_RATIO = 1.8


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exited(directory):
    return (directory / "exit-code.txt").read_text().strip() == "0"


def slow_pair(directory):
    return all(exited(directory / arm) for arm in ARMS) and (
        float((directory / "by-state" / "wall-seconds.txt").read_text()) /
        float((directory / "full" / "wall-seconds.txt").read_text()) >= SLOW_RATIO)


def can_retry(directory):
    failed = [arm for arm in ARMS if not exited(directory / arm)]
    return bool(failed) and all(result["toolCalls"] == 0 and result["modelTurns"] == 1
        and "Model request failed with status 502" in (result.get("error") or "")
        for result in (paired.read_json(directory / arm / "recovery-result.json")["result"] for arm in failed))


def degrade_receipt(checkpoint):
    """Controlled-only fixture where the full history remains valid but the receipt cannot bind execution."""
    paths = [checkpoint / "workspace" / name for name in ("site_qc.csv", "cleaned.csv")]
    artifact, = [p for p in paths if p.exists()]
    transcript = checkpoint / "final-messages.json"
    history = paired.read_json(transcript)
    expected = paired.verified_display_receipt(history, artifact.read_text().rstrip(), digest(artifact))
    require(expected, "controlled fallback needs a verified initial receipt")
    for message in history:
        if message.get("tool_call_id") == expected["toolCallId"]:
            message["content"] = message["content"].replace(expected["toolCallId"], "unbound-execution", 1)
    require(not paired.verified_display_receipt(history, artifact.read_text().rstrip(), digest(artifact)),
            "fallback fixture still has qualifying evidence")
    transcript.write_text(json.dumps(history, indent=2))
    manifest_file = checkpoint / "checkpoint.json"
    manifest = paired.read_json(manifest_file)
    manifest["hashes"][transcript.name] = digest(transcript)
    manifest_file.write_text(json.dumps(manifest, sort_keys=False, indent=2))


def capture_evidence(block, workload):
    capture = block / "capture"
    require(exited(capture), "capture failed")
    seed = capture / paired.read_json(capture / "checkpoint-index.json")["id"]
    manifest = paired.read_json(seed / "checkpoint.json")
    run = paired.read_json(seed / "summary.json")
    calibration = workload == "calibration-review"
    source = seed / "workspace"
    stage = "calibration-quality" if calibration else "solar-quality"
    files = {"instrument.csv", "qc.json", "cleaned.csv"} if calibration else {"sites.csv", "measurements.csv", "daily_clean.csv", "site_qc.csv"}
    review_file = "cleaned.csv" if calibration else "site_qc.csv"
    output_file = "fits.json" if calibration else "groups.json"
    history = paired.read_json(seed / "final-messages.json")
    table = (source / review_file).read_text().rstrip()
    expected = paired.verified_display_receipt(history, table, manifest["hashes"][f"workspace/{review_file}"])
    reviewed = any(msg["role"] == "tool" and isinstance(msg.get("content"), str)
        and '"exitCode":0' in msg["content"]
        and paired.contains_complete_table(msg["content"].partition("\nstdout:\n")[2], table) for msg in history)
    state = "displayed" if reviewed else "pending"
    observed_files = {"final-messages.json", "verified-stages.json"} | {
        p.relative_to(seed).as_posix() for p in source.rglob("*") if p.is_file()}
    require(manifest["version"] == 1 and manifest["workload"] == workload and manifest["phase"] == stage
        and set(manifest["hashes"]) == observed_files
        and all(digest(seed / name) == value for name, value in manifest["hashes"].items())
        and files <= {p.name for p in source.iterdir()}, "capture manifest or integrity differs")
    require((block / "capture-review.txt").read_text().strip() == state, "incorrect checkpoint state")
    require(run["status"] == "completed" and run["completionMode"] == "acceptance_boundary"
        and run["processId"] == manifest["capturedBy"] and paired.usage_matches(run, [e for e in paired.read_events(capture, run)
            if e.get("type") == "model_usage"]), "capture boundary or usage audit failed")
    return {"capture": capture, "seed": seed, "manifest": manifest, "run": run, "workload": workload, "source": source,
            "files": files, "review_file": review_file, "output_file": output_file, "state": state,
            "expected": expected, "history": history}


def audit_arms(directory, frozen, require_calibration_handoff=False):
    runs, models, inputs = {}, set(), {}
    history = frozen["history"]
    expected = frozen["expected"]
    reviewed = frozen["state"] == "displayed"
    if expected and not reviewed:
        raise ValueError("verified evidence inconsistent with observed review")
    route = {"mode": "retire-display", "reason": "verified-display"} if expected else {
        "mode": "full", "reason": "unverified-display" if reviewed else "pending-display"}
    traces = {}
    for arm in ARMS:
        arm_dir = directory / arm
        require(exited(arm_dir), f"{arm} failed or absent")
        receipt = paired.read_json(arm_dir / "recovery-result.json")
        run = runs[arm] = receipt["result"]
        models.add(receipt["model"])
        require(Path(receipt["checkpoint"]).resolve() == frozen["seed"].resolve()
            and receipt["capturedBy"] == frozen["manifest"]["capturedBy"]
            and receipt["resumedBy"] == run["processId"] != receipt["capturedBy"], f"{arm} did not resume in a new process")
        workspace = arm_dir / run["id"] / "workspace"
        require(not run["qualityWrites"] and all((frozen["source"] / name).read_bytes() == (workspace / name).read_bytes()
            for name in frozen["files"]), f"{arm} rewrote QC or changed the accepted inputs")
        require(paired.audit_workflow(arm_dir, run, frozen["workload"], history), f"{arm} independent completion or artifact audit failed")
        require(receipt.get("route") == (route if arm == "by-state" else None)
            and receipt["historyMode"] == (route["mode"] if arm == "by-state" else "full")
            and receipt.get("evidenceReceipt") == (expected if arm == "by-state" else None), f"{arm} wrong routing decision")
        traces[arm] = paired.first_trace(arm_dir, run)["llmInput"]
        inputs[arm] = traces[arm]["history"]
        handoff = receipt.get("calibrationHandoff")
        if frozen["workload"] == "calibration-review" and arm == "by-state" and expected:
            if require_calibration_handoff or handoff is not None:
                expected_handoff = {"acceptedStage": "instrument-qc", "acceptedFiles": [
                    {"path": name, "sha256": frozen["manifest"]["hashes"][f"workspace/{name}"]}
                    for name in ("qc.json", "cleaned.csv")], "review": "already displayed",
                    "nextAction": {"input": "cleaned.csv", "output": "fits.json", "groupBy": "batch",
                                   "method": "ordinary least squares"}}
                text = inputs[arm][-1]["content"].partition("Verified workspace handoff:\n")[2]
                require(handoff == expected_handoff and text, "missing or invalid calibration handoff")
                sent_handoff, _ = json.JSONDecoder().raw_decode(text)
                require(sent_handoff == expected_handoff, "model-visible calibration handoff differs from the frozen files")
        else:
            require(handoff is None, f"{arm} received unexpected calibration handoff")
    require(len(models) == 1 and runs["full"]["processId"] != runs["by-state"]["processId"], "paired model or process audit failed")
    original_prompt, = [msg["content"] for msg in history if msg["role"] == "user"]
    require(inputs["full"][0] == {"role": "user", "content": original_prompt}
        and inputs["full"][-1]["content"].startswith("Continue the original task from the validated quality checkpoint."),
        "baseline missing original history or continuation")
    if expected:
        call_id = expected["toolCallId"]
        call, = [call for msg in history if msg["role"] == "assistant" for call in msg.get("tool_calls", []) if call["id"] == call_id]
        result, = [msg for msg in history if msg["role"] == "tool" and msg["tool_call_id"] == call_id]
        *prior, continuation = inputs["by-state"]
        require(prior == [{"role": "assistant", "content": None, "tool_calls": [call]}, result]
            and continuation["role"] == "user" and continuation["content"].endswith("Original task:\n" + original_prompt)
            and all(traces["by-state"][key] == traces["full"][key] for key in ("systemPrompt", "tools")),
            "optimised path first model input differs from validated pair and original task")
    else:
        require(traces["by-state"] == traces["full"], "full-history fallback sent different model input")
    metrics = paired.recovery_metrics({arm: directory / arm for arm in ARMS}, runs)
    for arm in ARMS:
        arm_dir = directory / arm
        metrics[arm].update(paired.recovery_progress(arm_dir, runs[arm], reviewed, require_valid_grouping=True,
            review_file=frozen["review_file"], downstream_file=frozen["output_file"]))
        metrics[arm].update(paired.audit_retirement_lifecycle(arm_dir, runs[arm], frozen["source"],
            "retire-display" if arm == "by-state" else "full", expected if arm == "by-state" else None,
            calibration=frozen["workload"] == "calibration-review"))
    return metrics, models.pop(), route["reason"]


def wall_ratio(metrics):
    return metrics["by-state"]["wall"] / metrics["full"]["wall"]


def report(root, workload, count, require_calibration_handoff=False):
    lines = [f"# State-selected recovery paired evidence · {workload}", "",
             "The full-history baseline and state-selected candidate start in distinct processes at one shared frozen checkpoint per pair.", "",
             "| Pair | QC state | Route reason | Arm | First input | Input / output / total | First tool effect | Extra / repeated calls | Task / compaction requests | Retries | First progress s | Runner s | Model task s | Post-stage input | Evidence exits |",
             "|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    runs, failures, rechecks, transport, captures = [], [], [], [], []
    for pair in range(1, count + 1):
        directory = root / f"pair-{pair}"
        try:
            frozen = capture_evidence(directory, workload)
            metrics, model, route = audit_arms(directory, frozen, require_calibration_handoff)
            capture = paired.recovery_metrics({"capture": frozen["capture"]}, {"capture": frozen["run"]})["capture"]
        except (OSError, ValueError, KeyError, StopIteration) as error:
            failures.append(f"- Pair {pair} FAIL ({error})")
            continue
        runs.append((frozen["state"], metrics, model, route))
        captures.append(capture)
        if (directory / "transport-attempt").is_dir():
            transport.append(pair)
        for arm, row in metrics.items():
            lines.append(f"| {pair} | {frozen['state']} | {route} | {arm} | {row['first']:,} | "
                f"{row['all_input']:,} / {row['all_output']:,} / {row['all_total']:,} | {row['first_tool']} | "
                f"{row['extra_calls']} / {row['duplicate_reads']} | {row['turns']} / {row['compact_n']} | {row['retries']} | "
                f"{row['progress_s']:.3f} | {row['wall']:.3f} | {row['task_s']:.3f} | {row['post_group_input']:,} | {row['retired_units']} |")
        if model != "controlled-stub" and wall_ratio(metrics) >= SLOW_RATIO:
            try:
                repeat, repeat_model, _ = audit_arms(directory / "latency-recheck", frozen, require_calibration_handoff)
                require(repeat_model == model, "latency recheck model changed")
                rechecks.append((pair, wall_ratio(metrics), wall_ratio(repeat), repeat, None))
            except (OSError, ValueError, KeyError, StopIteration) as error:
                rechecks.append((pair, wall_ratio(metrics), None, None, str(error)))
    correct = len(runs) == count and len({model for _, _, model, _ in runs}) == 1
    lines += ["", f"Correctness audit **{'PASS' if correct else 'FAIL'}** · {len(runs)}/{count} pairs · {2 * len(runs)}/{2 * count} resumptions.", *failures]
    if not correct:
        return "\n".join(lines) + "\n", False
    lines += ["", f"Model `{runs[0][2]}`. Route counts {dict(Counter(row[3] for row in runs))}.",
              f"Successful checkpoint captures reconciled {sum(x['turns'] for x in captures)} task and {sum(x['compact_n'] for x in captures)} compaction requests.",
              f"Pre-tool 502 pair repeats {transport}. Original attempts are retained under `transport-attempt`.", "",
              "| State | Arm | First progress | Extra calls | Mean first input | Mean input | Mean output | Mean total | Task / compaction requests | Model retries |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    differences = []
    for state in ("all", "pending", "displayed"):
        group = [row[1] for row in runs if state == "all" or row[0] == state]
        if not group:
            continue
        for arm in ARMS:
            data = [row[arm] for row in group]
            lines.append(f"| {state} | {arm} | {sum(x['first_tool_progress'] for x in data)}/{len(data)} | "
                f"{sum(x['extra_calls'] for x in data)} | " + " | ".join(f"{mean(x[k] for x in data):,.2f}"
                for k in ("first", "all_input", "all_output", "all_total")) +
                f" | {sum(x['turns'] for x in data)} / {sum(x['compact_n'] for x in data)} | {sum(x['retries'] for x in data)} |")
        delta = median(x["by-state"]["wall"] - x["full"]["wall"] for x in group)
        ratio = median(map(wall_ratio, group))
        pct = 100 * (mean(x["by-state"]["all_total"] for x in group) / mean(x["full"]["all_total"] for x in group) - 1)
        differences.append(f"- {state} median paired runner difference {delta:+.3f} s, median paired ratio {ratio:.3f}×, mean total Token delta {pct:+.2f}%.")
    lines += ["", "| Pair | Runner difference s | Candidate / full | Task model difference s |", "|---|---:|---:|---:|"]
    for pair, (_, x, _, _) in enumerate(runs, 1):
        lines.append(f"| {pair} | {x['by-state']['wall'] - x['full']['wall']:+.3f} | {wall_ratio(x):.3f}× | {x['by-state']['task_s'] - x['full']['task_s']:+.3f} |")
    lines += ["", *differences]
    for pair, first, repeat, metrics, error in rechecks:
        if error:
            lines.append(f"- Pair {pair} at {first:.3f}× had an inconclusive recheck ({error}).")
        else:
            lines.append(f"- Pair {pair} recheck {first:.3f}× → {repeat:.3f}×. Full / candidate model seconds "
                f"{metrics['full']['task_s']:.3f} / {metrics['by-state']['task_s']:.3f}, turns "
                f"{metrics['full']['turns']} / {metrics['by-state']['turns']}, tools {metrics['full']['tools']} / {metrics['by-state']['tools']}.")
    if runs[0][2] != "controlled-stub":
        states = Counter(row[0] for row in runs)
        coverage = states == {"displayed": 3, "pending": 3} and sum(row[3] == "verified-display" for row in runs) == 3
        cost = sum(r[1]["by-state"]["all_total"] for r in runs) < sum(r[1]["full"]["all_total"] for r in runs)
        latency = all(repeat is not None and repeat < SLOW_RATIO for _, _, repeat, _, _ in rechecks)
        lines += ["", f"- Planned state and activation coverage **{'PASS' if coverage else 'FAIL'}**.",
            f"- Lower all-request total Token **{'PASS' if cost else 'FAIL'}**.",
            f"- Near-2× regression recheck **{'PASS' if latency else 'FAIL'}**.",
            f"- Advancement gate **{'PASS' if coverage and cost and latency else 'FAIL'}**."]
    return "\n".join(lines) + "\n", True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--workload", choices=("solar", "calibration-review"), default="solar")
    parser.add_argument("--pairs", type=int, default=6)
    parser.add_argument("--require-calibration-handoff", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--degrade-receipt", action="store_true")
    mode.add_argument("--can-retry", action="store_true")
    mode.add_argument("--slow-pair", action="store_true")
    args = parser.parse_args()
    if args.degrade_receipt:
        degrade_receipt(args.directory)
    elif args.can_retry or args.slow_pair:
        try:
            valid = (can_retry if args.can_retry else slow_pair)(args.directory)
        except (OSError, ValueError, KeyError):
            valid = False
        raise SystemExit(0 if valid else 1)
    else:
        text, correct = report(args.directory, args.workload, args.pairs, args.require_calibration_handoff)
        print(text, end="")
        raise SystemExit(0 if correct else 1)


if __name__ == "__main__":
    main()
