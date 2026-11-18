"""Offline recommendation CLI; loads only a locally trusted model artifact."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import pandas as pd

from .features import FEATURES, KEYS, LABELS, STEP, build, validate
from .train import action_probabilities, decide


def predict(artifact, readings, *, now=None):
    if artifact.get("schema_version") != 1 or artifact.get("features") != FEATURES:
        raise ValueError("Unsupported model schema or unexpected features")
    x = validate(readings)
    if x.empty or len(x[KEYS].drop_duplicates()) != 1:
        raise ValueError("Prediction needs exactly one home/window")
    # Unknown current values must not fall back to an earlier valid row.
    current_time = x.timestamp.iloc[-1]
    rows = build(readings, labelled=False)
    if rows.empty or rows.timestamp.iloc[-1] != current_time:
        return {"action": "HOLD", "status": "INSUFFICIENT_DATA", "reason": "Need four valid contiguous five-minute rows ending at the latest reading"}
    if now is not None:
        now = pd.Timestamp(now)
        if now.tzinfo is None:
            raise ValueError("now must include a timezone")
        if current_time > now or now - current_time > STEP:
            return {"action": "HOLD", "status": "STALE_DATA", "reason": "Latest reading is future-dated or more than five minutes old"}
    latest = rows.iloc[[-1]]
    probs = action_probabilities(artifact["estimator"], latest[FEATURES])
    action = decide(probs, artifact["threshold"])[0]
    return {"action": str(action), "status": "RECOMMENDATION_ONLY", "model": artifact["model_name"],
            "measured_at": current_time.isoformat(), "horizon_minutes": 5,
            "scores": {label: float(probs[0, i]) for i, label in enumerate(LABELS)},
            "threshold": artifact["threshold"], "score_note": "Uncalibrated classifier scores; not success or safety probabilities"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=Path("model/artifacts/window_model.joblib"))
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--now", help="ISO 8601 time for live freshness checking; omit for historical replay")
    args = parser.parse_args()
    result = predict(joblib.load(args.model), pd.read_csv(args.history), now=args.now)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
