"""Download pinned UCL/Mendeley V2 files and export only the approved columns."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import pickle
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

from .features import COLUMNS

HERE = Path(__file__).resolve().parent
ALLOWED_GLOBALS = {
    "pandas.core.frame": {"DataFrame"},
    "pandas.core.internals.managers": {"BlockManager"},
    "pandas._libs.internals": {"_unpickle_block"},
    "numpy._core.multiarray": {"_reconstruct"},
    "numpy.core.multiarray": {"_reconstruct"},
    "numpy": {"ndarray", "dtype"}, "builtins": {"slice"},
    "pandas.core.indexes.base": {"_new_Index", "Index"},
    "pandas.core.indexes.datetimes": {"_new_DatetimeIndex", "DatetimeIndex"},
    "pandas._libs.arrays": {"__pyx_unpickle_NDArrayBacked"},
    "pandas.core.arrays.datetimes": {"DatetimeArray"},
    "pandas.core.indexes.range": {"RangeIndex"},
}


class UclUnpickler(pickle.Unpickler):
    """Only the constructors used by the pinned numeric pandas dataset.

    This is defence in depth after SHA-256 verification, not a general-purpose
    pickle security boundary. Do not pass arbitrary user pickle files here.
    """
    def find_class(self, module, name):
        if name not in ALLOWED_GLOBALS.get(module, set()):
            raise pickle.UnpicklingError(f"Unexpected pickle global: {module}.{name}")
        return getattr(importlib.import_module(module), name)


def sha256(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def obtain(entry, raw_dir, download=False):
    path = Path(raw_dir) / f"{entry['home']}_outputs.pkl"
    if path.exists() and path.stat().st_size == entry["size"] and sha256(path) == entry["sha256"]:
        return path
    if not download:
        raise ValueError(f"Missing or invalid {path}; run again with --download")
    curl = shutil.which("curl.exe" if os.name == "nt" else "curl")
    if not curl:
        raise ValueError("curl is required for --download; alternatively place verified files in --raw-dir")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".pkl.part")
    url = f"https://data.mendeley.com/public-files/datasets/47gjkbm29h/files/{entry['file_id']}/file_downloaded"
    subprocess.run([curl, "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--retry", "3",
                    "--connect-timeout", "30", "--max-time", "600",
                    "--continue-at", "-", "--output", str(part), url], check=True)
    if part.stat().st_size != entry["size"] or sha256(part) != entry["sha256"]:
        raise ValueError(f"Source size/SHA-256 mismatch: {part}; not loading this file")
    part.replace(path)
    return path


def convert_home(payload, home):
    frame = payload[home].sort_index()
    if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.has_duplicates:
        raise ValueError(f"{home}: expected unique datetime index")
    rooms = payload[f"{home}_rooms_and_events"]
    event_dict = payload[f"{home}_event_dict"]
    statistics = payload[f"{home}_event_stats"]
    exported, mappings, skipped = [], [], []
    # Source data's naive UK clock is made explicit. DST-ambiguous/nonexistent
    # timestamps are discarded instead of guessing and creating duplicate UTC.
    index = frame.index
    localized = index.tz_localize("Europe/London", ambiguous="NaT", nonexistent="NaT") if index.tz is None else index
    for room, columns in rooms.items():
        for event_col in columns:
            if "window" not in event_col or not event_col.endswith("_event"):
                continue  # Never mix doors into window labels.
            if event_col.split("_window", 1)[0] != room:
                continue  # Source maps also associate neighbouring rooms; use its own room once.
            temp, humidity = f"{room}_temperature", f"{room}_humidity"
            if temp not in frame.columns or humidity not in frame.columns:
                skipped.append({"window": event_col, "reason": "No matching room temperature/humidity"})
                continue
            events = event_dict[event_col][["date", event_col]].copy()
            events["date"] = pd.to_datetime(events.date)
            if not events[event_col].dropna().isin([0, 1]).all():
                raise ValueError(f"Unexpected event encoding: {home}/{event_col}")
            if not events.date.is_monotonic_increasing:
                events = events.sort_values("date", kind="stable")
            events = events.drop_duplicates("date", keep="last")
            # Use the last event at/before each measurement time. In particular,
            # do not use a future event in the same five-minute bin or backfill
            # the unknown state before the very first recorded event.
            states = pd.merge_asof(pd.DataFrame({"date": index}).sort_values("date"), events,
                                   on="date", direction="backward")[event_col].to_numpy()
            # Original event encoding: 0 OPEN, 1 CLOSED. This also agrees with
            # the author's open_mean_mins summaries (not fraction_time_open).
            result = pd.DataFrame({"home_id": home, "window_id": event_col,
                                   "timestamp": localized.tz_convert("UTC"),
                                   "temperature": frame[temp].to_numpy(),
                                   "humidity": frame[humidity].to_numpy(),
                                   "window_open": np.where(pd.isna(states), np.nan, 1 - states)})
            result = result[result.timestamp.notna()]
            exported.append(result[COLUMNS])
            stat = statistics[statistics.event == event_col]
            event_source = event_dict[event_col]
            open_duration = event_source.loc[event_source[event_col] == 0, "mins_next_event"].mean()
            mappings.append({"window": event_col, "temperature": temp, "humidity": humidity,
                             "rows": len(result), "source_open_value": 0,
                             "source_mean_state0_minutes": float(open_duration) if pd.notna(open_duration) else None,
                             "author_open_mean_minutes": float(stat.open_mean_mins.iloc[0]) if not stat.empty else None})
    if not exported:
        raise ValueError(f"No usable room/window pairs in {home}")
    return pd.concat(exported, ignore_index=True), {"home": home, "mappings": mappings, "skipped": skipped}


def prepare(raw_dir, output, *, download=False, homes=None):
    manifest = json.loads((HERE / "ucl_manifest.json").read_text(encoding="utf-8"))
    chosen = homes or [entry["home"] for entry in manifest["files"]]
    if set(chosen) - {entry["home"] for entry in manifest["files"]}:
        raise ValueError("Unknown home; choose p1..p7")
    summaries = []
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".csv.part")
    first = True
    for entry in manifest["files"]:
        if entry["home"] not in chosen:
            continue
        path = obtain(entry, raw_dir, download)
        # Exact hash is checked before any pickle constructor can execute.
        with path.open("rb") as file:
            payload = UclUnpickler(file).load()
        rows, summary = convert_home(payload, entry["home"])
        rows.to_csv(temporary, mode="w" if first else "a", header=first, index=False)
        first = False
        summaries.append(summary)
        print(f"Prepared {entry['home']}: {len(rows):,} rows, {len(summary['mappings'])} windows", flush=True)
        del payload, rows
    temporary.replace(output)
    audit = {"dataset": manifest["doi"], "license": manifest["license"],
             "columns": COLUMNS, "gas_features": [], "source_open_value": 0,
             "state_sampling": "Last recorded event at or before t; unknown before first event",
             "source_timezone_assumption": "Europe/London for naive source clocks; ambiguous DST rows dropped",
             "homes": summaries}
    output.with_suffix(".audit.json").write_text(json.dumps(audit, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=Path("model/data/raw"))
    parser.add_argument("--out", type=Path, default=Path("model/data/windows.csv"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--homes", nargs="+", choices=[f"p{i}" for i in range(1, 8)])
    args = parser.parse_args()
    prepare(args.raw_dir, args.out, download=args.download, homes=args.homes)


if __name__ == "__main__":
    main()
