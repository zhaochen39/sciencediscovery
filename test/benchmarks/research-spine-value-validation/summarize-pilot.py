"""Summarize finalized or in-progress formal pairs without pooling failed pairs."""
import argparse
from collections import defaultdict
import importlib.util
import hashlib
import re
import json
from pathlib import Path
import statistics


spec = importlib.util.spec_from_file_location("formal", Path(__file__).with_name("report-formal-recovery.py"))
formal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(formal)
MODES = ("original", "full", "by-state")


def audit_pair(directory, state):
    arms = {}
    for mode in MODES:
        arm = directory / mode
        if not (arm / "exit-code.txt").is_file():
            arms[mode] = {"status": "pending"}
            continue
        exit_code = int((arm / "exit-code.txt").read_text())
        try:
            result = formal.audit_arm(arm)
        except (AssertionError, OSError, ValueError, KeyError, StopIteration) as error:
            arms[mode] = {"status": "failed", "error": str(error), "exit_code": exit_code}
            continue
        checks = formal.recovery_checks(result, state == "displayed")
        arms[mode] = {"status": "pass" if exit_code == 0 and all(checks.values()) else "failed", "checks": checks, **result}
    return arms


def summarize(rows):
    eligible = [row["arms"] for row in rows if all(arm["status"] == "pass" for arm in row["arms"].values())]
    groups = {}
    for mode in MODES:
        arms = [row[mode] for row in eligible]
        if arms:
            groups[mode] = {
                "mean_tokens": [statistics.mean(arm["total_with_child_usage"][i] for arm in arms) for i in range(3)],
                "mean_model_requests": statistics.mean(sum(arm["requests"].values()) for arm in arms),
                "mean_tool_calls": statistics.mean(sum(arm["tools"].values()) for arm in arms),
                "mean_seconds": statistics.mean(arm["seconds"] for arm in arms),
            }
    comparisons = {}
    if groups:
        for reference in ("original", "full"):
            candidate, baseline = groups["by-state"], groups[reference]
            comparisons[reference] = {
                "token_pct": [100 * (a / b - 1) if b else None for a, b in zip(candidate["mean_tokens"], baseline["mean_tokens"])],
                "model_requests_pct": 100 * (candidate["mean_model_requests"] / baseline["mean_model_requests"] - 1),
                "tool_calls_pct": 100 * (candidate["mean_tool_calls"] / baseline["mean_tool_calls"] - 1),
                "paired_median_seconds_pct": 100 * (statistics.median(pair["by-state"]["seconds"] / pair[reference]["seconds"] for pair in eligible) - 1),
                "paired_median_seconds_delta": statistics.median(pair["by-state"]["seconds"] - pair[reference]["seconds"] for pair in eligible),
            }
    return {"passed_pairs": len(eligible), "total_pairs": len(rows), "arms": groups, "comparisons": comparisons}


def initial_request(arm):
    result = json.loads((arm / "result.json").read_text(encoding="utf-8"))
    data = Path((arm / "data-dir.txt").read_text().strip())
    files = sorted((data / "context-traces").glob(result["sessionId"] + "_*/turn-*.json"))
    if not files:
        return None
    wire = json.loads(files[0].read_text(encoding="utf-8"))["llmInput"]
    return {key: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest() for key, value in wire.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("logs", type=Path)
    parser.add_argument("--rollout", action="store_true", help="read flat WORKFLOW-STATE-PAIR directories")
    parser.add_argument("--case", type=Path, action="append", default=[], help="add a flat case from another batch")
    parser.add_argument("--only", action="append", default=[], help="select matching case-directory names")
    args = parser.parse_args()
    rows = []
    groups = defaultdict(list)
    if args.rollout:
        cases = []
        for directory in sorted(args.logs.iterdir()) + args.case:
            match = re.fullmatch(r"(solar|calibration)-(displayed|pending)-([1-6])", directory.name)
            if match and (not args.only or directory.name in args.only):
                workflow, state, pair = match.groups()
                cases.append((workflow, state, int(pair), directory))
    else:
        cases = [(workflow, state, pair, args.logs / f"pilot-formal-{workflow}-{state}" / f"pair-{pair}")
                 for workflow in ("solar", "calibration") for pair in range(1, 7)
                 for state in ["pending" if pair % 2 else "displayed"]]
    for workflow, state, pair, directory in cases:
        arms = audit_pair(directory, state)
        order = directory / "arm-order.txt"
        row = {"workflow": workflow, "state": state, "pair": pair, "directory": str(directory),
               "order": order.read_text().splitlines() if order.exists() else [], "arms": arms}
        candidate = arms["by-state"]
        row["recheck"] = {mode: candidate["seconds"] / arms[mode]["seconds"] for mode in ("original", "full")
                          if "seconds" in candidate and "seconds" in arms[mode]
                          and candidate["seconds"] >= 1.8 * arms[mode]["seconds"]}
        if args.rollout and all((directory / mode / "result.json").is_file() for mode in ("full", "by-state")):
            full, other = (initial_request(directory / mode) for mode in ("full", "by-state"))
            if full and other:
                row["initial_request_matches_full"] = {key: digest == other.get(key) for key, digest in full.items()}
        rows.append(row)
        groups[f"{workflow}-{state}"].append(row)
    print(json.dumps({"overall": summarize(rows), "summary": {group: summarize(pairs) for group, pairs in groups.items()}, "pairs": rows}, indent=2))


if __name__ == "__main__":
    main()
