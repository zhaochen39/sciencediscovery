"""Paired pilot of the candidate feedback prompt on a real JiuwenSwarm adapter."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

import httpx
from sciencediscovery_evolve.vendor.idea_tree.research import IdeaTreeEngine
from score import BURGERS, IMDB


def choose(client, prompt, choices, run_id):
    started = time.monotonic()
    result = {"runId": run_id, "score": None, "choice": None, "tokens": None}
    usage = []
    status = "unknown"
    try:
        with client.stream("POST", "/agent/runs", json={
            "sessionId": run_id, "runId": run_id, "agentId": "main", "prompt": prompt, "tools": [],
            "systemPrompt": "You are selecting one reproducible scientific experiment under a fixed budget. "
                            "Reply with a JSON object with only the key choice. Choose exactly one of the supplied IDs.",
            "model": {"model": os.environ["REAL_LLM_MODEL"], "baseUrl": os.environ["REAL_LLM_BASE_URL"],
                      "apiKey": os.environ["REAL_LLM_KEY"]},
        }) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line:
                    continue
                item = json.loads(line)
                event = item.get("event", {})
                if event.get("type") == "model.usage":
                    usage.append(event["usage"]["totalTokens"])
                if "done" in item:
                    status = item["done"].get("status")
                    text = item["done"].get("finalText", "").strip()
                    if status == "completed":
                        if text.startswith("```") and text.endswith("```"):
                            text = text.split("\n", 1)[1].rsplit("\n", 1)[0].strip()
                        choice = json.loads(text)["choice"]
                        if choice in choices:
                            result["choice"] = choice
                        else:
                            status = "invalid_choice"
    except (ValueError, KeyError, TypeError):
        status = "invalid_response"
    except httpx.TimeoutException:
        status = "timeout"
    except httpx.HTTPError:
        status = "adapter_http_error"
    result.update(status=status, wallSeconds=time.monotonic() - started, tokens=sum(usage) if usage else None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=["burgers", "imdb"])
    parser.add_argument("--development", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pairs", type=int, default=3, choices=range(1, 21))
    args = parser.parse_args()
    development = json.loads(args.development.read_text(encoding="utf-8"))
    burgers = args.task == "burgers"
    choices = BURGERS if burgers else IMDB
    baseline, first_candidate = ("seed", "smoothing") if burgers else ("unigram", "stopword")
    baseline_value = development["scores"][baseline]["score"]
    candidate_value = development["scores"][first_candidate]["score"]
    summary = {
        "id": "validation-first-round", "referenceVersionId": "development-v1", "metric": "nrmse" if burgers else "accuracy",
        "baseline": baseline_value, "candidate": candidate_value, "sampleCount": development["count"],
        "improvement": baseline_value - candidate_value if burgers else candidate_value - baseline_value,
    }
    run = uuid.uuid4().hex[:10]
    with httpx.Client(base_url=os.environ["SCIENCE_AGENT_ADAPTER_URL"], trust_env=False, timeout=150) as client:
        info = client.get("/agent/info").json()
        if info.get("executor") != "jiuwenswarm" or not info.get("jiuwenswarm", {}).get("reachable"):
            raise RuntimeError("A reachable JiuwenSwarm adapter is required")
        report = {"task": args.task, "executor": info["executor"], "model": os.environ["REAL_LLM_MODEL"],
                  "metric": summary["metric"], "developmentSha256": development["dataSha256"], "pairs": []}
        for number in range(1, args.pairs + 1):
            order = ("A", "B") if number % 2 else ("B", "A")
            pair = {"pair": number, "order": list(order), "arms": {}}
            for arm in order:
                state = {"settings": {"candidateValidationEnabled": True}, "nodes": [
                    {"id": first_candidate, "validations": [summary] if arm == "B" else []},
                ]}
                evidence = IdeaTreeEngine(state, None, {}).experiment_feedback()
                prompt = json.dumps({
                    "objective": "Minimize mean per-trajectory nRMSE on 1-D Burgers nu=0.01" if burgers else "Maximize IMDb sentiment accuracy",
                    "options": choices, "baseline": baseline, "firstRoundCandidate": first_candidate,
                    "decision": "Select the single next experiment. You may keep the baseline or first-round candidate. ",
                    **evidence,
                }, ensure_ascii=False)
                arm_result = choose(client, prompt, choices, f"validation-{run}-{number}-{arm.lower()}")
                arm_result.update(promptSha256=hashlib.sha256(prompt.encode()).hexdigest(),
                                  feedbackIds=[row["id"] for row in evidence.get("candidateValidation", [])])
                pair["arms"][arm] = arm_result
            report["pairs"].append(pair)
            args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            print(args.task, number, [(arm, pair["arms"][arm]["status"], pair["arms"][arm]["choice"]) for arm in order], flush=True)


if __name__ == "__main__":
    main()
