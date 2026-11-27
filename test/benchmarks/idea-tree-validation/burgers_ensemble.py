"""Freeze component predictions for the CodePDE Burgers refinement comparison."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from score import CODEPDE_COMMIT, digest, split_burgers, upstream_burgers

COMPONENTS = [
    "512-point Fourier Strang splitting, CFL 0.22",
    "256-point Fourier Strang splitting, CFL 0.22",
    "1024-point Fourier Strang splitting, CFL 0.40",
    "1024-point Fourier Strang splitting, CFL 0.12",
]


def split_solve(initial, times, size, safety):
    nu = 0.01 / np.pi
    full_size = initial.shape[1]
    assert full_size % size == 0
    modes = 2 * np.pi * np.fft.rfftfreq(size, d=1 / size)
    mask = np.arange(modes.size) <= size // 3
    coarse = initial[:, ::full_size // size]
    frequency = np.fft.rfft(coarse)
    result = np.empty((len(initial), len(times), full_size), dtype=np.float32)
    result[:, 0] = initial
    stable_dt = safety / (size * max(0.01, float(np.max(np.abs(coarse)))))

    def rhs(value):
        real = np.fft.irfft(value, n=size)
        return -0.5j * modes * mask * np.fft.rfft(real * real)

    for index, duration in enumerate(np.diff(times), 1):
        count = max(1, int(np.ceil(duration / stable_dt)))
        dt = float(duration) / count
        decay = np.exp(-0.5 * dt * nu * modes * modes)
        for _ in range(count):
            frequency *= decay
            k1 = rhs(frequency)
            k2 = rhs(frequency + 0.5 * dt * k1)
            k3 = rhs(frequency + 0.5 * dt * k2)
            k4 = rhs(frequency + dt * k3)
            frequency = decay * (frequency + dt * (k1 + 2 * k2 + 2 * k3 + k4) / 6)
        if size < full_size:
            coefficients = frequency.copy()
            coefficients[:, -1] *= 0.5
            result[:, index] = np.fft.irfft(coefficients, n=full_size) * (full_size / size)
        else:
            result[:, index] = np.fft.irfft(frequency, n=full_size)
    if not np.isfinite(result).all():
        raise ValueError("Solver produced non-finite values")
    return result


def prepare(data, output, source):
    output.mkdir(parents=True, exist_ok=True)
    upstream_burgers(source)  # verifies the pinned checkout before launch
    dev_path, test_path = data / "development.hdf5", data / "test.hdf5"
    manifest = {"upstreamCommit": CODEPDE_COMMIT, "developmentSha256": digest(dev_path), "testSha256": digest(test_path),
                "components": COMPONENTS, "developmentStride": [1, 5, 128], "files": {}}
    for stage, path in (("dev", dev_path), ("test", test_path)):
        initial, times, reference = split_burgers(path, stage)
        if stage == "dev":
            # Observe each trajectory on a fixed sparse grid. Exclude the
            # starting frame, for which every solver reports the given input.
            split = np.s_[:, 1::5, ::128]
            target = reference[split].ravel()
            columns = []
        for index, (size, cfl) in enumerate(((512, 0.22), (256, 0.22), (1024, 0.40), (1024, 0.12))):
            start = time.monotonic()
            # Use the same fixed batch layout in development and test. The
            # CFL calculation sees only initial conditions from its own batch.
            chunks = [split_solve(initial[i:i + 10], times, size, cfl) for i in range(0, len(initial), 10)]
            result = np.concatenate(chunks)
            if stage == "dev":
                columns.append(result[split].ravel())
            else:
                file = output / f"test-{index}.npy"
                np.save(file, result, allow_pickle=False)
                manifest["files"][file.name] = digest(file)
            print(stage, index, round(time.monotonic() - start, 2), flush=True)
        if stage == "dev":
            (output / "dev-input.json").write_text(json.dumps(np.round(np.column_stack(columns).astype(float), 9).tolist(), separators=(",", ":")))
            (output / "dev-reference.json").write_text(json.dumps([{"id": str(i), "value": float(value)} for i, value in enumerate(target)], separators=(",", ":")))
            for name in ("dev-input.json", "dev-reference.json"):
                manifest["files"][name] = digest(output / name)
            # Ideation and development scoring can begin while test-input
            # simulations run in the independent grading workspace.
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "grader-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def grade(data, output, source, locked, report_path):
    result = json.loads(locked.read_text())
    manifest = json.loads((output / "grader-manifest.json").read_text())
    assert len(result["pairs"]) == result["design"]["pairs"]
    assert manifest["testSha256"] == digest(data / "test.hdf5")
    assert manifest["testSha256"] == result["manifest"]["testSha256"]
    _, _, reference = split_burgers(data / "test.hdf5", "test")
    metric = upstream_burgers(source)["compute_nrmse"]
    predictions = []
    for index in range(4):
        path = output / f"test-{index}.npy"
        assert digest(path) == manifest["files"][path.name]
        predictions.append(np.load(path, mmap_mode="r", allow_pickle=False))
    scores = {}
    for pair in result["pairs"]:
        for arm in pair["arms"]:
            if "selected" not in arm:
                continue
            key = tuple(arm["selected"])
            if key not in scores:
                mixed = sum(weight * column.astype(np.float64) for weight, column in zip(key, predictions) if weight)
                scores[key] = float(metric(mixed, reference))
            arm["testNrmse"] = scores[key]
    result["holdoutCount"] = len(reference)
    result["lockedChoicesSha256"] = hashlib.sha256(locked.read_bytes()).hexdigest()
    report_path.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "grade"])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codepde", type=Path, required=True)
    parser.add_argument("--locked", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.operation == "prepare":
        prepare(args.data, args.output, args.codepde)
    else:
        grade(args.data, args.output, args.codepde, args.locked, args.report)


if __name__ == "__main__":
    main()
