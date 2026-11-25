import os
import csv
import random
import numpy as np
import torch
import torch.nn as nn
import timm
from pathlib import Path
import pandas as pd

from dataclasses import dataclass
from torchvision import datasets, transforms
from torch.utils.data import DataLoader, Subset
from sklearn.model_selection import StratifiedShuffleSplit
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.tree import DecisionTreeClassifier

# =====================================
# Config
# =====================================
class Config:
    # Training
    BATCH_SIZE = 32
    RANDOM_SEED = 42
    WEIGHT_DECAY = 0.05
    LR = 1e-3
    
    # Dataset
    DATA_DIR = ""
    
    # Output
    RESULT_DIR = ""
    MODEL_DIR = ""
    LOG_DIR = ""
    GRAPH_DIR = ""
    EVAL_DIR = ""

CFG = Config()

# =====================================
# Utils
# =====================================

def create_directories():
    for d in [
        CFG.RESULT_DIR, 
        CFG.MODEL_DIR, 
        CFG.LOG_DIR, 
        CFG.GRAPH_DIR, 
        CFG.EVAL_DIR, 
    ]:
        os.makedirs(d, exist_ok=True)

def seed_everything(seed=42):
    random.seed(seed)
    






# =====================================
# Logger
# =====================================






# =====================================
# Transform
# =====================================

def add_pm_features(data: pd.DataFrame) -> pd.DataFrame:
    return data.assign(
        pm25_diff=data["indoor_pm25"] - data["outdoor_pm25"],
        pm10_diff=data["indoor_pm10"] - data["outdoor_pm10"],
    )

def add_ventilation_labels(data: pd.DataFrame) -> pd.DataFrame:
    indoor_need = (
        (data["humidity"] >= 65)
        | (data["indoor_pm25"] >= 35)
        | (data["indoor_pm10"] >= 80)
    )
    outdoor_below_limits = (
        (data["outdoor_pm25"] < 35) & (data["outdoor_pm10"] < 80)
    )
    outdoor_not_dustier = (
        (data["pm25_diff"] >= 0) & (data["pm10_diff"] >= 0)
    )

    recommend = indoor_need & outdoor_below_limits & outdoor_not_dustier
    return data.assign(label=np.where(recommend, "VENTILATE", "HOLD"))






# =====================================
# Dataset
# =====================================

SENSOR_COLUMNS = [
    "temperature",
    "humidity",
    "indoor_pm25",
    "outdoor_pm25",
    "indoor_pm10",
    "outdoor_pm10",
]


def load_dataset(csv_path: Path) -> pd.DataFrame:
    row_keys = ["home_id", "room", "timestamp"]
    data = pd.read_csv(csv_path, usecols=row_keys + SENSOR_COLUMNS)
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True)

    if data.duplicated(subset=row_keys).any():
        raise ValueError("같은 집·방·시각에 중복된 측정 기록이 있습니다.")
    
    data = data.dropna(subset=SENSOR_COLUMNS)
    return data.sort_values(row_keys, ignore_index=True)

def split_by_home(data: pd.DataFrame):
    train = data.loc[data["home_id"].isin(["p1", "p2", "p3", "p4", "p5"])]
    validation = data.loc[data["home_id"] == "p6"]
    test = data.loc[data["home_id"] == "p7"]
    return train, validation, test





# =====================================
# Model
# =====================================

FEATURE_COLUMNS = SENSOR_COLUMNS + ["pm25_diff", "pm10_diff"]
LABEL_ORDER = ["HOLD", "VENTILATE"]


def train_model(train: pd.DataFrame) -> DecisionTreeClassifier:
    model = DecisionTreeClassifier(max_depth=6, random_state=CFG.RANDOM_SEED)
    model.fit(train[FEATURE_COLUMNS], train["label"])
    return model





# =====================================
# Bootstrap
# =====================================







# =====================================
# Main
# =====================================
def main():
    csv_path = Path(__file__).resolve().parent / "data" / "ventilation_pm.csv"
    data = load_dataset(csv_path)
    data = add_pm_features(data)
    data = add_ventilation_labels(data)

    print(data["label"].value_counts().to_string())
    
    train, validation, test = split_by_home(data)

    for name, part in [("학습", train), ("검증", validation), ("테스트", test)]:
        print(f"\n{name} 데이터: {len(part):,}행")
        print(part["label"].value_counts().to_string())

    print(f"전체 기록: {len(data):,}행")
    print(data.head().to_string(index=False))
    print("\n센서별 결측치")
    print(data[SENSOR_COLUMNS].isna().sum().to_string())
    
    model = train_model(train)

    actual = validation["label"]
    predicted = model.predict(validation[FEATURE_COLUMNS])

    print(classification_report(
        actual, predicted, labels=LABEL_ORDER, digits=5, zero_division=0
    ))
    print(confusion_matrix(actual, predicted, labels=LABEL_ORDER))
    
    print("\n최종 테스트 결과 (p7)")
    actual = test["label"]
    predicted = model.predict(test[FEATURE_COLUMNS])

    print(classification_report(
        actual, predicted, labels=LABEL_ORDER, digits=5, zero_division=0
    ))
    print(confusion_matrix(actual, predicted, labels=LABEL_ORDER))



if __name__ == "__main__":
    main()
