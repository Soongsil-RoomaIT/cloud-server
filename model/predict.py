import json
import sys

import joblib
import pandas as pd

from model import CFG, FEATURE_COLUMNS, add_pm_features


def predict(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object with indoor and outdoor snapshots.")

    indoor = payload.get("indoor")
    outdoor = payload.get("outdoor")
    if not isinstance(indoor, dict) or not isinstance(outdoor, dict):
        raise ValueError("Both indoor and outdoor must be JSON objects.")

    if outdoor.get("stale") is True:
        return {"action": "HOLD", "status": "STALE_OUTDOOR_DATA"}

    # Both API responses use pm25/pm10. Their source determines the feature name.
    fields = {
        "temperature": (indoor.get("temperature"), -80, 100),
        "humidity": (indoor.get("humidity"), 0, 100),
        "indoor_pm25": (indoor.get("pm25"), 0, 10000),
        "outdoor_pm25": (outdoor.get("pm25"), 0, 10000),
        "indoor_pm10": (indoor.get("pm10"), 0, 10000),
        "outdoor_pm10": (outdoor.get("pm10"), 0, 10000),
    }
    unavailable = [
        name for name, (value, low, high) in fields.items()
        if type(value) not in (int, float) or not low <= value <= high
    ]
    if unavailable:
        return {
            "action": "HOLD",
            "status": "INSUFFICIENT_DATA",
            "unavailable_fields": unavailable,
        }

    reading = {name: value for name, (value, _, _) in fields.items()}
    features = add_pm_features(pd.DataFrame([reading]))[FEATURE_COLUMNS]
    model = joblib.load(CFG.MODEL_PATH)
    return {"action": str(model.predict(features)[0]), "status": "OK"}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read())
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(json.dumps({"status": "INVALID_INPUT", "message": "Expected valid JSON on stdin."}))
        return 2

    try:
        result = predict(payload)
    except ValueError as error:
        print(json.dumps({"status": "INVALID_INPUT", "message": str(error)}))
        return 2
    except FileNotFoundError:
        print(json.dumps({"status": "MODEL_UNAVAILABLE", "message": "Run model.py to train and save the model."}))
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
