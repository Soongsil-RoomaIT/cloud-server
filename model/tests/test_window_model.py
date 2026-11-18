import io
import json
import os
import pickle
import tempfile
import unittest
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

from model.features import COLUMNS, FEATURES, LABELS, build, validate
from model.infer import predict
from model.prepare_ucl import UclUnpickler, convert_home, obtain
from model.train import action_probabilities, fit, split_homes


def history(n=12, home="p1"):
    return pd.DataFrame({"home_id": home, "window_id": "living_window_event",
                         "timestamp": pd.date_range("2026-01-01", periods=n, freq="5min", tz="UTC").astype(str),
                         "temperature": 23 + np.arange(n) / 10, "humidity": 50 + np.arange(n) / 10,
                         "window_open": ([0] * 4 + [1] * 4 + [0] * 4) * (n // 12) + [0] * (n % 12)})


class FixedClassifier:
    classes_ = np.array(LABELS)

    def predict_proba(self, x):
        return np.tile([0.05, 0.9, 0.05], (len(x), 1))


def artifact():
    return {"schema_version": 1, "features": FEATURES, "estimator": FixedClassifier(),
            "threshold": 0.5, "model_name": "test_fixture"}


class FeatureTests(unittest.TestCase):
    def test_gas_and_unapproved_features_are_rejected(self):
        for name in ["co2", "co2_mean", "eco2", "gas", "label", "temperature_future"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                build(history().assign(**{name: 999}))
        self.assertTrue(all("co2" not in name for name in FEATURES))

    def test_actions_and_strictly_past_features(self):
        x = history()
        before = build(x)
        self.assertEqual(before.label.tolist()[:5], ["OPEN", "HOLD", "HOLD", "HOLD", "CLOSE"])
        x.loc[4:, "temperature"] = 30
        after = build(x)
        assert_frame_equal(before.iloc[[0]][FEATURES], after.iloc[[0]][FEATURES])
        self.assertAlmostEqual(before.temperature_mean_15m.iloc[0], 23.15)

    def test_gaps_and_missing_values_do_not_bridge_histories(self):
        x = history()
        x.loc[5, "temperature"] = np.nan
        result = build(x, labelled=False)
        self.assertFalse(pd.Timestamp(x.timestamp[8]) in result.timestamp.tolist())
        self.assertTrue(pd.Timestamp(x.timestamp[9]) in result.timestamp.tolist())
        x = history().drop(index=5)
        self.assertFalse(pd.Timestamp(x.timestamp[8]) in build(x, labelled=False).timestamp.tolist())

    def test_bad_current_and_future_states_are_not_silently_filled(self):
        x = history()
        x.loc[4, "window_open"] = np.nan
        self.assertNotIn(pd.Timestamp(x.timestamp[3]), build(x).timestamp.tolist())
        x.loc[11, "window_open"] = 2
        self.assertEqual(predict(artifact(), x)["status"], "INSUFFICIENT_DATA")

    def test_timestamp_and_unique_keys_validation(self):
        with self.assertRaises(ValueError):
            validate(pd.concat([history(), history()]))
        with self.assertRaises(ValueError):
            validate(history().assign(timestamp="2026-01-01 00:00:00"))

    def test_households_are_disjoint(self):
        x = build(pd.concat([history(home=f"p{i}") for i in range(1, 5)]))
        parts = split_homes(x, ["p3"], ["p4"])
        self.assertEqual(set(parts["train"].home_id), {"p1", "p2"})
        self.assertEqual(set(parts["validation"].home_id), {"p3"})
        self.assertEqual(set(parts["test"].home_id), {"p4"})
        with self.assertRaises(ValueError):
            split_homes(x, ["p3"], ["p3"])


class PreparationTests(unittest.TestCase):
    def payload(self):
        x = history(12)
        index = pd.to_datetime(x.timestamp).dt.tz_localize(None)
        frame = pd.DataFrame({"living_temperature": x.temperature.to_numpy(),
                              "living_humidity": x.humidity.to_numpy(),
                              "living_co2": 800}, index=index)
        col = "living_window_event"
        event = pd.DataFrame({"date": [index.iloc[0] + pd.Timedelta(minutes=2), index.iloc[2] + pd.Timedelta(minutes=2)],
                              col: [1., 0.], "mins_next_event": [10., 30.]})
        return {"p1": frame, "p1_rooms_and_events": {"living": [col]},
                "p1_event_dict": {col: event},
                "p1_event_stats": pd.DataFrame({"event": [col], "open_mean_mins": [30.]})}

    def test_source_encoding_asof_and_complete_gas_exclusion(self):
        p = self.payload()
        rows, _ = convert_home(p, "p1")
        self.assertEqual(rows.columns.tolist(), COLUMNS)
        self.assertTrue(pd.isna(rows.window_open.iloc[0]))  # No future backfill.
        self.assertEqual(rows.window_open.iloc[2], 0)  # Event at :12 is not known at :10.
        self.assertEqual(rows.window_open.iloc[3], 1)  # Source 0 becomes OPEN.
        p["p1"]["living_co2"] = 100000
        same, _ = convert_home(p, "p1")
        assert_frame_equal(rows, same)

    def test_unknown_pickle_globals_are_blocked(self):
        with self.assertRaises(pickle.UnpicklingError):
            UclUnpickler(io.BytesIO(pickle.dumps(os.system))).load()

    def test_shared_room_associations_do_not_duplicate_windows(self):
        p = self.payload()
        p["p1_rooms_and_events"]["kitchen"] = ["living_window_event"]
        p["p1"]["kitchen_temperature"] = 30
        p["p1"]["kitchen_humidity"] = 80
        rows, audit = convert_home(p, "p1")
        self.assertEqual(len(rows), 12)
        self.assertEqual(audit["mappings"][0]["temperature"], "living_temperature")

    def test_invalid_hash_never_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "p1_outputs.pkl").write_bytes(b"untrusted")
            with self.assertRaises(ValueError):
                obtain({"home": "p1", "size": 9, "sha256": "0" * 64}, tmp)


class InferenceTests(unittest.TestCase):
    def test_inference_uses_last_row_without_future_label(self):
        x = history(4)
        self.assertEqual(predict(artifact(), x)["action"], "OPEN")
        self.assertEqual(predict(artifact(), x.assign(window_open=1))["action"], "HOLD")

    def test_stale_future_and_multiwindow_inputs(self):
        x = history(4)
        self.assertEqual(predict(artifact(), x, now="2026-01-01T00:21:00Z")["status"], "STALE_DATA")
        self.assertEqual(predict(artifact(), x, now="2025-12-31T23:59:00Z")["status"], "STALE_DATA")
        with self.assertRaises(ValueError):
            predict(artifact(), pd.concat([x, history(4, home="p2")]))

    def test_impossible_action_probability_moves_to_hold(self):
        rows = build(history(4).assign(window_open=1), labelled=False)
        p = action_probabilities(FixedClassifier(), rows[FEATURES])
        self.assertEqual(p[0, 1], 0)
        self.assertAlmostEqual(p[0].sum(), 1)

    def test_real_fit_save_load_and_predict(self):
        data = pd.concat([history(120, home=f"p{i}") for i in [1, 2, 3]])
        with tempfile.TemporaryDirectory() as tmp:
            csv = Path(tmp, "data.csv")
            data.to_csv(csv, index=False)
            report = fit(csv, Path(tmp, "out"), ["p2"], ["p3"], trees=2)
            stored = joblib.load(Path(tmp, "out/window_model.joblib"))
            self.assertEqual(stored["features"], FEATURES)
            self.assertEqual(report["gas_features"], [])
            self.assertEqual(predict(stored, history(4))["status"], "RECOMMENDATION_ONLY")
            self.assertEqual(json.loads(Path(tmp, "out/report.json").read_text(encoding="utf-8"))["split"]["test"]["homes"], ["p3"])


if __name__ == "__main__":
    unittest.main()
