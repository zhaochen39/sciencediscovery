"""CPU execution and isolated grading for a paired JiuwenSwarm selection pilot."""
import argparse
import ast
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import h5py
import numpy as np
import pyarrow.parquet as pq
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline

CODEPDE_COMMIT = "26938c5832ddd0a957426dff6f702b54649c14af"
BURGERS = {
    "seed": "Upstream NumPy pseudospectral RK4 with explicit viscosity and adaptive time stepping.",
    "smoothing": "Same upstream solver with periodic three-point smoothing before integration, retaining the exact initial frame.",
    "smaller-dt": "Same upstream solver with the stable timestep halved, at higher computational cost.",
    "split-viscosity": "Fourier Strang splitting of exact linear diffusion and dealiased nonlinear advection with RK4.",
}
IMDB = {
    "unigram": "Word unigrams, binary classification with L2 logistic regression, C=4.",
    "stopword": "Word unigrams with English stop words excluded, C=4.",
    "word-ngram": "Word unigrams and bigrams, C=4.",
    "char-ngram": "Character 3–5-grams inside words, C=4.",
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def split_burgers(path, stage):
    with h5py.File(path) as data:
        target = np.array(data["tensor"])
        t_coordinate = np.array(data["t-coordinate"])
        if target.ndim != 3 or target.shape[0] != (50 if stage == "dev" else 100):
            raise ValueError("Expected the published CodePDE development or test split")
    return target[:, 0].copy(), t_coordinate, target


def spectral_split(u0, times, nu):
    grid_size = u0.shape[1]
    k = 2 * np.pi * np.fft.rfftfreq(grid_size, d=1 / grid_size)
    mask = np.arange(k.size) <= grid_size // 3
    result = np.empty((u0.shape[0], times.size, grid_size))
    result[:, 0] = u0
    u_hat = np.fft.rfft(u0)
    dt_bound = 0.22 / (grid_size * max(0.01, float(np.max(np.abs(u0)))))
    def rhs(current):
        u = np.fft.irfft(current, n=grid_size)
        return (-0.5j * k) * mask * np.fft.rfft(u * u)
    for index, duration in enumerate(np.diff(times), 1):
        steps = int(np.ceil(duration / dt_bound))
        if steps == 0:
            result[:, index] = result[:, index - 1]
            continue
        dt = duration / steps
        decay = np.exp(-0.5 * dt * nu * k * k)
        for _ in range(steps):
            u_hat *= decay
            k1 = rhs(u_hat)
            k2 = rhs(u_hat + 0.5 * dt * k1)
            k3 = rhs(u_hat + 0.5 * dt * k2)
            k4 = rhs(u_hat + dt * k3)
            u_hat = decay * (u_hat + dt * (k1 + 2 * k2 + 2 * k3 + k4) / 6)
        result[:, index] = np.fft.irfft(u_hat, n=grid_size)
    return result


def upstream_burgers(checkout):
    revision = subprocess.check_output(["git", "-C", checkout, "rev-parse", "HEAD"], text=True).strip()
    if revision != CODEPDE_COMMIT:
        raise ValueError("CodePDE checkout must be at the recorded commit")
    paths = ["solvers/burgers/nu_0.01/seeds/implementation_2.py", "solvers/burgers/evaluator.py"]
    source = [subprocess.check_output(["git", "-C", checkout, "show", f"HEAD:{item}"], text=True) for item in paths]
    functions = {"np": np}
    exec(compile(source[0], paths[0], "exec"), functions)
    # Load the exact upstream metric without importing its solver or plotting dependencies.
    metric = next(node for node in ast.parse(source[1]).body if isinstance(node, ast.FunctionDef) and node.name == "compute_nrmse")
    exec(compile(ast.Module(body=[metric], type_ignores=[]), paths[1], "exec"), functions)
    return functions


def burgers(args):
    data = args.data / ("development.hdf5" if args.split == "dev" else "test.hdf5")
    inputs, coordinates, expected = split_burgers(data, args.split)
    methods = upstream_burgers(args.codepde)
    scores = {}
    for option in args.options:
        start = time.monotonic()
        if option == "split-viscosity":
            result = spectral_split(inputs.copy(), coordinates, 0.01 / np.pi)
        else:
            u0 = inputs.copy()
            if option == "smoothing":
                u0 = 0.5 * u0 + 0.25 * (np.roll(u0, 1, axis=1) + np.roll(u0, -1, axis=1))
            local = methods.copy()
            solver = type(methods["solver"])(methods["solver"].__code__, local)
            if option == "smaller-dt":
                local["estimate_stable_dt"] = lambda *parameters: methods["estimate_stable_dt"](*parameters) * 0.5
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink):
                result = solver(u0, coordinates, 0.01 / np.pi)
            result[:, 0] = inputs
        runtime = time.monotonic() - start
        if result.shape != expected.shape or not np.isfinite(result).all():
            raise ValueError(f"Invalid solver result: {option}")
        scores[option] = {"score": float(methods["compute_nrmse"](result, expected)), "computeSeconds": runtime}
    return {"count": len(expected), "dataSha256": digest(data), "scores": scores}


def imdb(args):
    train = args.data / "train-00000-of-00001.parquet"
    train_values = pq.read_table(train, columns=["text", "label"]).to_pydict()
    text, labels = train_values["text"], train_values["label"]
    if args.split == "dev":
        text, dev, labels, expected = train_test_split(text, labels, test_size=0.2, random_state=173, stratify=labels)
        data = train
    else:
        data = args.data / "test-00000-of-00001.parquet"
        dev = pq.read_table(data, columns=["text"])["text"].to_pylist()
        expected = None
    choices = {
        "unigram": {}, "stopword": {"stop_words": "english"}, "word-ngram": {"ngram_range": (1, 2)},
        "char-ngram": {"analyzer": "char_wb", "ngram_range": (3, 5)},
    }
    scores = {}
    predictions = {}
    for option in args.options:
        start = time.monotonic()
        pipeline = make_pipeline(TfidfVectorizer(min_df=3, max_features=120_000, **choices[option]),
                                 LogisticRegression(C=4, random_state=173, max_iter=300))
        pipeline.fit(text, labels)
        scores[option] = {"computeSeconds": time.monotonic() - start}
        started = time.monotonic()
        predictions[option] = pipeline.predict_proba(dev)
        scores[option]["computeSeconds"] += time.monotonic() - started
    if expected is None:
        # The final choices and predictions are frozen before accessing test labels.
        expected = pq.read_table(data, columns=["label"])["label"].to_numpy()
    for option, prediction in predictions.items():
        # MLAgentBench imdb/scripts/eval.py uses argmax of the two columns at each official idx.
        scores[option]["score"] = float(np.mean(np.argmax(prediction, axis=1) == np.asarray(expected)))
    return {"count": len(expected), "dataSha256": digest(data), "scores": scores}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=["burgers", "imdb"])
    parser.add_argument("split", choices=["dev", "test"])
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--codepde", type=Path)
    parser.add_argument("--options", nargs="+")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.options = args.options or list(BURGERS if args.task == "burgers" else IMDB)
    report = burgers(args) if args.task == "burgers" else imdb(args)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
