"""Prepare frozen IMDb component predictions for the paired product journey.

Fit the same four TF-IDF + logistic models using only the registered training split.
Write labels separately so the product can stage development inputs without labels.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline

from score import digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    train_path = args.data / "train-00000-of-00001.parquet"
    test_path = args.data / "test-00000-of-00001.parquet"
    train = pq.read_table(train_path, columns=["text", "label"]).to_pydict()
    train_text, dev_text, train_labels, dev_labels = train_test_split(
        train["text"], train["label"], test_size=0.2, random_state=173, stratify=train["label"]
    )
    test_text = pq.read_table(test_path, columns=["text"])["text"].to_pylist()
    args.output.mkdir(parents=True, exist_ok=True)
    dev_columns = []
    test_columns = []
    for options in (
        {}, {"stop_words": "english"}, {"ngram_range": (1, 2)}, {"analyzer": "char_wb", "ngram_range": (3, 5)}
    ):
        model = make_pipeline(TfidfVectorizer(min_df=3, max_features=120_000, **options),
                              LogisticRegression(C=4, random_state=173, max_iter=300))
        model.fit(train_text, train_labels)
        dev_columns.append(np.round(model.predict_proba(dev_text)[:, 1], 10))
        test_columns.append(np.round(model.predict_proba(test_text)[:, 1], 10))
        print(f"Prepared component {len(dev_columns)}", flush=True)
    for split, columns, labels in (
        ("dev", dev_columns, dev_labels), ("test", test_columns, pq.read_table(test_path, columns=["label"])["label"].to_pylist())
    ):
        (args.output / f"{split}-input.json").write_text(json.dumps(np.column_stack(columns).tolist(), separators=(",", ":")))
        (args.output / f"{split}-reference.json").write_text(json.dumps([
            {"id": str(i), "value": y} for i, y in enumerate(labels)
        ], separators=(",", ":")))
    (args.output / "manifest.json").write_text(json.dumps({
        "trainingSha256": digest(train_path), "testSha256": digest(test_path), "developmentSeed": 173,
        "components": ["unigram", "stopword", "word-ngram", "char-ngram"],
        "files": {file.name: digest(file) for file in sorted(args.output.glob("*-*.json"))},
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
