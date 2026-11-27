"""Summarize locked holdout scores for the feedback comparison."""
import argparse
import json
from pathlib import Path
from statistics import mean, median

import numpy as np


def summarize(document):
    lower_is_better = "nRMSE" in document["design"]["metric"]
    key = "testNrmse" if lower_is_better else "testAccuracy"
    pairs = [{arm["arm"]: arm for arm in pair["arms"]} for pair in document["pairs"]]
    arms = {label: [pair[label] for pair in pairs if label in pair] for label in ("A", "B")}
    matched = [(pair["A"][key], pair["B"][key]) for pair in pairs if
               key in pair.get("A", {}) and key in pair.get("B", {})]
    improvements = [a - b if lower_is_better else 100 * (b - a) for a, b in matched]
    tolerance = 1e-12
    outcome = {
        "task": document["task"], "allocatedPairs": document["design"]["pairs"], "scoredPairs": len(matched),
        "deliveryCount": {label: sum(key in arm for arm in items) for label, items in arms.items()},
        "winTieLoss": [sum(delta > tolerance for delta in improvements),
                       sum(abs(delta) <= tolerance for delta in improvements),
                       sum(delta < -tolerance for delta in improvements)],
        "meanHoldoutScores": [mean(column) for column in zip(*matched)] if matched else [],
        "deltaUnits": "absolute nRMSE reduction" if lower_is_better else "percentage points",
    }
    if improvements:
        generator = np.random.default_rng(20261127)
        trials = generator.choice(improvements, size=(10_000, len(improvements)), replace=True).mean(axis=1)
        outcome.update(meanImprovement=mean(improvements), medianImprovement=median(improvements),
                       bootstrap95=np.quantile(trials, [0.025, 0.975]).tolist())
        if lower_is_better:
            outcome["relativeReduction"] = mean(improvements) / outcome["meanHoldoutScores"][0]
    for label, items in arms.items():
        model_calls = [arm["ideation"] for arm in items if "ideation" in arm]
        token_counts = [call["tokens"] for call in model_calls if call["tokens"] is not None]
        outcome[f"arm{label}"] = {
            "failedArms": sum("error" in arm for arm in items),
            "validModelOutputs": sum("weights" in call for call in model_calls),
            "meanModelSeconds": mean(call["wallSeconds"] for call in model_calls) if model_calls else None,
            "meanTokens": mean(token_counts) if token_counts else None,
            "tokenObservations": len(token_counts),
            "meanArmWallSeconds": mean(arm["wallSeconds"] for arm in items) if items else None,
            "executionCount": sum(len(experiment["executionIds"]) for arm in items for experiment in arm["experiments"]),
        }
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+")
    args = parser.parse_args()
    print(json.dumps([summarize(json.loads(path.read_text(encoding="utf-8"))) for path in args.reports], indent=2))


if __name__ == "__main__":
    main()
