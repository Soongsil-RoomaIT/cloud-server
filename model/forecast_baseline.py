"""Compare a one-hour indoor forecast with a persistence baseline."""

import argparse
import hashlib
import json
from datetime import timedelta
from pathlib import Path

import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


DATA_PATH = Path(__file__).resolve().parent / "data" / "ventilation_pm.csv"
METRICS = ["temperature", "humidity"]
BUCKET_MINUTES = 10
HORIZON_MINUTES = 60
HORIZON = timedelta(minutes=HORIZON_MINUTES)
HISTORY_BUCKETS = 12


def load_series(csv_path: Path, home: str, room: str) -> pd.DataFrame:
    data = pd.read_csv(csv_path, usecols=["home_id", "room", "timestamp", *METRICS])
    indoor = data.loc[(data["home_id"] == home) & (data["room"] == room), ["timestamp", *METRICS]].copy()
    if indoor.empty:
        raise ValueError(f"No records for {home}/{room}")
    indoor["timestamp"] = pd.to_datetime(indoor["timestamp"], utc=True)
    indoor = indoor.set_index("timestamp").sort_index()
    if not indoor.index.is_unique:
        raise ValueError("Duplicate timestamps for the selected room")

    buckets = indoor.resample(f"{BUCKET_MINUTES}min", label="right", closed="right")
    # The source records every 5 minutes. Keep complete bins and preserve gaps.
    return buckets.mean().where(buckets.count() == 2)


def prepare_examples(series: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    inputs = pd.concat(
        [series.shift(lag).add_suffix(f"_lag{lag}") for lag in range(HISTORY_BUCKETS)],
        axis=1,
    )
    targets = series.shift(-(HORIZON_MINUTES // BUCKET_MINUTES))
    valid = inputs.notna().all(axis=1) & targets.notna().all(axis=1)
    return inputs.loc[valid], targets.loc[valid]


def evaluate(csv_path: Path, home: str, room: str, output: Path | None = None) -> dict:
    series = load_series(csv_path, home, room)
    inputs, targets = prepare_examples(series)
    if len(inputs) < 5:
        raise ValueError("Not enough complete history and target pairs")

    validation_start = inputs.index[len(inputs) * 4 // 5]
    # Training targets must have been observed before validation starts.
    train = inputs.index + HORIZON < validation_start
    validation = inputs.index >= validation_start
    if not train.any():
        raise ValueError("Not enough training data before the validation boundary")

    model = make_pipeline(StandardScaler(), Ridge(alpha=1.0))
    model.fit(inputs.loc[train], targets.loc[train])
    if output is not None:
        export_model(model, output)
    predictions = model.predict(inputs.loc[validation])
    actual = targets.loc[validation]
    baseline = series.loc[actual.index, METRICS]
    metrics = [
        {
            "metric": name,
            "ridge_mae": mean_absolute_error(actual[name], predictions[:, index]),
            "baseline_mae": mean_absolute_error(actual[name], baseline[name]),
        }
        for index, name in enumerate(METRICS)
    ]
    return {
        "home": home,
        "room": room,
        "horizon_minutes": HORIZON_MINUTES,
        "training_rows": int(train.sum()),
        "validation_rows": int(validation.sum()),
        "validation_start": validation_start.isoformat(),
        "metrics": metrics,
    }


def export_model(model, path: Path) -> None:
    scaler = model.named_steps["standardscaler"]
    ridge = model.named_steps["ridge"]
    coefficients = ridge.coef_ / scaler.scale_
    intercepts = ridge.intercept_ - coefficients @ scaler.mean_
    metrics = {
        name: {"intercept": float(intercepts[i]), "coefficients": coefficients[i].tolist()}
        for i, name in enumerate(METRICS)
    }
    fingerprint = hashlib.sha256(json.dumps(metrics, sort_keys=True).encode()).hexdigest()[:12]
    artifact = {"schemaVersion": 1, "modelVersion": f"ridge-{fingerprint}", "metrics": metrics}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(artifact, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA_PATH)
    parser.add_argument("--home", default="p1")
    parser.add_argument("--room", default="living")
    parser.add_argument("--out", type=Path, help="Export model coefficients for Cloud Server")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.data, args.home, args.room, args.out), indent=2))


if __name__ == "__main__":
    main()
