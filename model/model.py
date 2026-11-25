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







# =====================================
# Model
# =====================================







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

    print(f"전체 기록: {len(data):,}행")
    print(data.head().to_string(index=False))
    print("\n센서별 결측치")
    print(data[SENSOR_COLUMNS].isna().sum().to_string())



if __name__ == "__main__":
    main()
