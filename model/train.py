"""Run from repository root: python -m model.train --data ... --out ..."""
from __future__ import annotations

import argparse
import json
import platform
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score, average_precision_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURES, LABELS, build
from .prepare_ucl import sha256


def split_homes(rows, validation_homes, test_homes):
    val, test = set(validation_homes), set(test_homes)
    homes = set(rows.home_id)
    if not val or not test or val & test or not (val | test) <= homes:
        raise ValueError("Validation/test homes must exist, be nonempty and disjoint")
    parts = {"train": rows[~rows.home_id.isin(val | test)],
             "validation": rows[rows.home_id.isin(val)], "test": rows[rows.home_id.isin(test)]}
    if any(p.empty for p in parts.values()):
        raise ValueError("Need at least three homes with usable histories")
    return parts


def action_probabilities(estimator, x):
    raw = estimator.predict_proba(x)
    probs = np.zeros((len(x), len(LABELS)))
    for i, label in enumerate(estimator.classes_):
        probs[:, LABELS.index(label)] = raw[:, i]
    # Transfer physically impossible actions to HOLD. Evaluation and inference
    # must apply the same policy, rather than reporting unmasked classifier F1.
    for action, impossible in [("OPEN", x.window_open.to_numpy() == 1),
                               ("CLOSE", x.window_open.to_numpy() == 0)]:
        i = LABELS.index(action)
        probs[impossible, 0] += probs[impossible, i]
        probs[impossible, i] = 0
    return probs


def decide(probs, threshold):
    action = np.argmax(probs[:, 1:], axis=1) + 1
    score = probs[np.arange(len(probs)), action]
    return np.asarray(LABELS)[np.where(score >= threshold, action, 0)]


def evaluate(rows, probs, threshold):
    prediction = decide(probs, threshold)
    report = classification_report(rows.label, prediction, labels=LABELS, output_dict=True, zero_division=0)
    ap = {}
    for label, state in [("OPEN", 0), ("CLOSE", 1)]:
        mask = rows.window_open.to_numpy() == state
        target = rows.label.to_numpy()[mask] == label
        ap[label] = float(average_precision_score(target, probs[mask, LABELS.index(label)])) if target.any() else None
    return {"threshold": float(threshold), "classification_report": report,
            "confusion_matrix": confusion_matrix(rows.label, prediction, labels=LABELS).tolist(),
            "label_order": LABELS, "eligible_state_average_precision": ap}


def counts(rows):
    return {"rows": len(rows), "homes": sorted(rows.home_id.unique().tolist()),
            "windows": rows[["home_id", "window_id"]].drop_duplicates().shape[0],
            "labels": {label: int((rows.label == label).sum()) for label in LABELS}}


def fit(data, output, validation_homes, test_homes, *, max_train_rows=300000, trees=160):
    if trees < 1 or max_train_rows < 3:
        raise ValueError("trees must be positive; max_train_rows must be at least 3")
    source = pd.read_csv(data)
    rows = build(source)
    parts = split_homes(rows, validation_homes, test_homes)
    train = parts["train"]
    if set(train.label) != set(LABELS):
        raise ValueError("Training homes must contain HOLD, OPEN and CLOSE examples")
    # This is a training-only resource limit. Never sample validation/test;
    # keep all rare actions if they fit, then sample the numerous HOLD rows.
    if len(train) > max_train_rows:
        actions = train[train.label != "HOLD"]
        if len(actions) >= max_train_rows:
            raise ValueError("Increase --max-train-rows above the number of action rows")
        train = pd.concat([actions, train[train.label == "HOLD"].sample(max_train_rows - len(actions), random_state=42)])
    candidates = {
        "always_hold": DummyClassifier(strategy="constant", constant="HOLD"),
        "logistic_regression": make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000, random_state=42)),
        "random_forest": RandomForestClassifier(n_estimators=trees, max_depth=14, min_samples_leaf=30,
                                                 class_weight="balanced_subsample", n_jobs=4, random_state=42),
    }
    validation = {}
    models = {}
    thresholds = {}
    for name, estimator in candidates.items():
        print(f"Training {name}: {len(train):,} rows", flush=True)
        estimator.fit(train[FEATURES], train.label)
        probs = action_probabilities(estimator, parts["validation"][FEATURES])
        options = []
        for threshold in [0.2, 0.35, 0.5, 0.65, 0.8]:
            predicted = decide(probs, threshold)
            score = f1_score(parts["validation"].label, predicted, labels=LABELS, average="macro", zero_division=0)
            options.append((score, threshold))
        _, threshold = max(options)  # Prefer higher threshold on exact ties.
        validation[name] = evaluate(parts["validation"], probs, threshold)
        models[name] = estimator
        thresholds[name] = threshold
    selected = max(candidates, key=lambda name: validation[name]["classification_report"]["macro avg"]["f1-score"])
    # Lock model and threshold before touching the held-out home's outcomes.
    test_results = {name: evaluate(parts["test"], action_probabilities(models[name], parts["test"][FEATURES]), thresholds[name]) for name in models}
    report = {
        "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
        "task": "Observed human window action at t+5 minutes; not optimal ventilation",
        "input_csv_sha256": sha256(data),
        "input_rows": len(source), "usable_rows": len(rows), "features": FEATURES,
        "gas_features": [], "horizon_minutes": 5, "history_minutes": 15,
        "split": {name: counts(part) for name, part in parts.items()}, "fit_sample": counts(train),
        "selection": "Highest validation macro-F1, with home-disjoint train/validation/test",
        "selected_model": selected, "selected_threshold": thresholds[selected],
        "validation": validation, "test": test_results,
        "versions": {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scikit_learn": sklearn.__version__},
        "limitations": ["Human behaviour is not an optimal or safety label.",
                        "Class-weighted scores are not calibrated probabilities.",
                        "UK homes can differ substantially from a Korean studio.",
                        "No outdoor air-quality, gas, rain or motor feedback features.",
                        "Recommendation-only; no automatic device commands are sent."],
    }
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    joblib.dump({"schema_version": 1, "features": FEATURES, "estimator": models[selected],
                 "threshold": thresholds[selected], "model_name": selected,
                 "horizon_minutes": 5, "history_minutes": 15}, out / "window_model.joblib", compress=3)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Selected: {selected}; validation macro-F1={validation[selected]['classification_report']['macro avg']['f1-score']:.4f}", flush=True)
    print(f"Held-out test macro-F1={test_results[selected]['classification_report']['macro avg']['f1-score']:.4f}", flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("model/data/windows.csv"))
    parser.add_argument("--out", type=Path, default=Path("model/artifacts"))
    parser.add_argument("--validation-homes", nargs="+", default=["p6"])
    parser.add_argument("--test-homes", nargs="+", default=["p7"])
    parser.add_argument("--max-train-rows", type=int, default=300000)
    parser.add_argument("--trees", type=int, default=160)
    args = parser.parse_args()
    fit(args.data, args.out, args.validation_homes, args.test_homes, max_train_rows=args.max_train_rows, trees=args.trees)


if __name__ == "__main__":
    main()
