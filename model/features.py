"""One causal feature builder shared by training and inference.

Input is a five-minute series, one row per home/window/time. Unknown fields
(including every gas field) are rejected instead of silently becoming features.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

STEP = pd.Timedelta(minutes=5)
KEYS = ["home_id", "window_id"]
COLUMNS = KEYS + ["timestamp", "temperature", "humidity", "window_open"]
FEATURES = [
    "temperature", "humidity", "window_open",
    "temperature_delta_5m", "humidity_delta_5m",
    "temperature_delta_15m", "humidity_delta_15m",
    "temperature_mean_15m", "humidity_mean_15m",
    "minutes_in_observed_state",
]
LABELS = ["HOLD", "OPEN", "CLOSE"]


def validate(frame: pd.DataFrame) -> pd.DataFrame:
    if set(frame.columns) != set(COLUMNS) or frame.columns.duplicated().any():
        raise ValueError(f"CSV columns must be exactly {COLUMNS}; no gas columns allowed")
    x = frame[COLUMNS].copy()
    if x[KEYS].isna().any().any() or (x[KEYS].astype(str).apply(lambda s: s.str.strip()) == "").any().any():
        raise ValueError("home_id and window_id must be nonempty")
    x[KEYS] = x[KEYS].astype(str)
    # Require explicit timezone offsets, including Z. Naive timestamps could
    # otherwise silently turn a local clock into UTC.
    if not x.timestamp.astype(str).str.contains(r"(?:Z|[+-]\d{2}:\d{2})$", regex=True).all():
        raise ValueError("timestamp must be ISO 8601 with timezone offset or Z")
    x["timestamp"] = pd.to_datetime(x.timestamp, utc=True, format="mixed", errors="raise")
    if x.duplicated(KEYS + ["timestamp"]).any():
        raise ValueError("Duplicate home/window/timestamp")
    for col, low, high in [("temperature", -40, 80), ("humidity", 0, 100)]:
        x[col] = pd.to_numeric(x[col], errors="coerce")
        x.loc[~x[col].between(low, high), col] = np.nan
    x["window_open"] = pd.to_numeric(x.window_open, errors="coerce")
    x.loc[~x.window_open.isin([0, 1]), "window_open"] = np.nan
    return x.sort_values(KEYS + ["timestamp"]).reset_index(drop=True)


def build(frame: pd.DataFrame, *, labelled: bool = True) -> pd.DataFrame:
    """Use t-15..t for X; use only t+5 window state for the training target.

    No interpolation, backwards fill, centred rolling windows, or cross-gap
    windows. Missing core measurements break the history. State duration is
    time since its first *observed* value, capped at 24 h, not claimed true age.
    """
    x = validate(frame)
    pieces = []
    for _, group in x.groupby(KEYS, sort=False):
        g = group.copy()
        valid = g[["temperature", "humidity", "window_open"]].notna().all(axis=1)
        boundary = g.timestamp.diff().ne(STEP) | ~valid | ~valid.shift(fill_value=False)
        g["_segment"] = boundary.cumsum()
        for _, segment in g[valid].groupby("_segment", sort=False):
            s = segment.copy()
            for col in ["temperature", "humidity"]:
                s[f"{col}_delta_5m"] = s[col] - s[col].shift(1)
                s[f"{col}_delta_15m"] = s[col] - s[col].shift(3)
                s[f"{col}_mean_15m"] = s[col].rolling(4, min_periods=4).mean()
            changed = s.window_open.ne(s.window_open.shift())
            started = s.timestamp.where(changed).ffill()
            s["minutes_in_observed_state"] = ((s.timestamp - started).dt.total_seconds() / 60).clip(upper=1440)
            if labelled:
                # Target does not depend on the next temperature/humidity.
                future = g.set_index("timestamp").window_open.reindex(s.timestamp + STEP).to_numpy()
                s["label"] = np.where(s.window_open == future, "HOLD", np.where(future == 1, "OPEN", "CLOSE"))
                s.loc[pd.isna(future), "label"] = None
            keep = s[FEATURES].notna().all(axis=1)
            if labelled:
                keep &= s.label.notna()
            pieces.append(s.loc[keep, KEYS + ["timestamp"] + FEATURES + (["label"] if labelled else [])])
    columns = KEYS + ["timestamp"] + FEATURES + (["label"] if labelled else [])
    return pd.concat(pieces, ignore_index=True) if pieces else pd.DataFrame(columns=columns)
