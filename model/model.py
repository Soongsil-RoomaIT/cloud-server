import os
import csv
import random
import numpy as np
import torch
import torch.nn as nn
import timm

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










# =====================================
# Dataset
# =====================================









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
    pass



if __name__ == "__main__":
    main()
