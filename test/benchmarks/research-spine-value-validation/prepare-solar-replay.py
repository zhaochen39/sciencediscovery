"""Freeze a report-stage checkpoint from a completed natural solar trajectory."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from shutil import copyfile

from solar_audit import audit


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("boundary_call")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--support", action="append", default=[], help="Supporting workspace file already present at the boundary")
    args = parser.parse_args()
    source = args.source.resolve()
    workspace = source / "workspace"
    output = args.destination
    summary = read_json(source / "summary.json")
    if summary["completionMode"] != "model_stop" or not summary["artifactValidation"]["passed"] or any(audit(workspace)["errors"]):
        raise ValueError("Source must have completed naturally and passed independent artifact validation")
    history = read_json(source / "final-messages.json")
    boundary, = (i for i, message in enumerate(history) if message.get("tool_call_id") == args.boundary_call)
    if history[boundary + 1]["role"] != "assistant":
        raise ValueError("Boundary must end after the last response to its assistant tool call")
    prefix = history[:boundary + 1]
    boundary_output = prefix[-1]["content"]
    if json.loads(boundary_output.partition("\nstdout:\n")[0])["exitCode"] != 0:
        raise ValueError("Boundary tool did not succeed")
    closures = read_json(source / "verified-stages.json")
    for closure in closures:
        source_result = closure.get("resultSource")
        call_ids = {message.get("tool_call_id") for message in prefix}
        if closure["toolCallId"] not in call_ids:
            raise ValueError("Closure was created after the selected boundary")
        if source_result:
            message, = (message for message in prefix if message.get("tool_call_id") == source_result["toolCallId"])
            if sha256(message["content"].encode()).hexdigest() != source_result["contentSha256"]:
                raise ValueError("Readout digest mismatch")
        revisions = {**closure["inputRevisions"], **{item["path"]: item["revision"] for item in closure["artifacts"]}}
        if any(digest(workspace / name) != expected for name, expected in revisions.items()):
            raise ValueError("Closure references an obsolete file")
    if not any(item.get("resultSource") for item in closures):
        raise ValueError("Expected a naturally attested independent readout")
    for name in ("groups.json", "sensitivity.json"):
        if (workspace / name).read_text(encoding="utf-8").strip() not in boundary_output:
            raise ValueError(f"Current {name} bytes do not match the boundary tool's printed JSON")
    support = [Path(name) for name in args.support]
    if any(name.is_absolute() or ".." in name.parts or name.name == "solar_report.md" for name in support):
        raise ValueError("Supporting files must be relative and must exclude the report")
    files = ["sites.csv", "measurements.csv", "daily_clean.csv", "site_qc.csv", "groups.json", "sensitivity.json", *args.support]
    output.mkdir()
    for name in files:
        destination = output / "workspace" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        copyfile(workspace / name, destination)
    if any(audit(output / "workspace")["errors"][:3]):
        raise ValueError("Frozen report-stage artifacts fail independent validation")
    (output / "final-messages.json").write_text(json.dumps(prefix, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "verified-stages.json").write_text(json.dumps(closures, indent=2), encoding="utf-8")
    provenance = {"id": output.name, "sourceRun": str(source), "boundaryToolCallId": args.boundary_call,
                  "sourceHistorySha256": digest(source / "final-messages.json"), "prefixMessages": len(prefix),
                  "copiedFiles": {name: digest(workspace / name) for name in files}}
    (output / "natural-replay.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
