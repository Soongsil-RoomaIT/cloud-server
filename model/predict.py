import joblib
import pandas as pd

from model import FEATURE_COLUMNS, CFG, add_pm_features


def main():
    model = joblib.load(CFG.MODEL_PATH)
    reading = pd.DataFrame([{
        "temperature": 26.0,
        "humidity": 72.0,
        "indoor_pm25": 40.0,
        "outdoor_pm25": 12.0,
        "indoor_pm10": 60.0,
        "outdoor_pm10": 25.0,
    }])

    features = add_pm_features(reading)[FEATURE_COLUMNS]
    prediction = model.predict(features)[0]
    print(f"환기 판단: {prediction}")


if __name__ == "__main__":
    main()