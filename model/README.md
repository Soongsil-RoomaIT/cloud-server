# 창문 동작 예측 모델 — CO₂ 제외

온도·습도와 **현재 창문 상태**로 5분 뒤 창문 상태의 변화를 예측하는 CPU 학습 코드입니다. 원시 데이터에서 아래 항목만 추출하며, CO₂·eCO₂·TVOC·다른 가스값과 가스로 만든 정답·파생변수는 사용하지 않습니다. 학습·예측 CSV에 허용하지 않은 열이 있으면 오류로 차단합니다. 오염가스 센서는 모델명·단위·보정 방법 확인 후 별도로 검토합니다.

이 모델의 정답은 **사람이 실제로 한 행동**입니다. 환기에 가장 좋은 행동이나 공기질 개선 효과가 입증된 정답은 아닙니다. 처음에는 웹 추천용으로 평가하고, 실제 방에서 기록을 모은 다음 효과를 확인해야 합니다.

## 실행

저장소 루트 `CloudAIoT`에서 실행합니다. Python **3.12 권장**(3.11도 지원), 인터넷 연결과 `curl`이 필요합니다. Node 서버와 독립적으로 실행되며 GPU가 필요 없습니다. 기존 루트 `.venv` 및 `model.py`, `predict.py` 초안과 별개입니다.

```powershell
py -3.12 -m venv model/.venv
.\model\.venv\Scripts\python.exe -m pip install -r model/requirements.txt

# 공개 원본 약 299 MB 다운로드 → 해시 검증 → CO₂ 없는 CSV 생성
.\model\.venv\Scripts\python.exe -m model.prepare_ucl --download

# p1~p5 학습 / p6 검증·모델 선택 / p7 최종 평가
.\model\.venv\Scripts\python.exe -m model.train

# 예시 CSV는 동작 확인용 가상 값이며 과거 데이터 재생으로 실행
.\model\.venv\Scripts\python.exe -m model.infer --history model/examples/history.csv

# 자동 검증
.\model\.venv\Scripts\python.exe -m unittest discover -s model/tests -v
```

Python 3.12가 `py`에 등록되지 않았다면 설치된 Python 3.12 실행 파일의 절대 경로로 첫 명령을 실행합니다. 다운로드를 한 번 완료하면 이후에는 `--download` 없이 준비할 수 있습니다. 다른 PC에서는 원본과 학습 결과를 위 명령으로 다시 만듭니다. `data/`, `artifacts/`, `.venv/`는 Git에서 제외합니다. 원본 파일의 크기와 SHA-256은 `ucl_manifest.json`에 고정되어 있습니다. 알 수 없는 pickle 파일을 불러오는 기능은 제공하지 않습니다.

## 파일과 결과

| 파일 | 역할 |
|---|---|
| `prepare_ucl.py` | 공식 파일 다운로드·해시 검사, 방별 센서/창문 대응, 가스 없는 CSV 추출 |
| `features.py` | 학습·예측이 함께 쓰는 과거 15분 입력 계산과 정답 생성 |
| `train.py` | 기준 모델·로지스틱 회귀·랜덤 포레스트 학습 및 평가 |
| `infer.py` | 최근 기록을 입력받아 추천 JSON 출력 |
| `data/windows.csv` | 학습용 6열 CSV |
| `data/windows.audit.json` | 원본 열 대응, 창문 상태 변환, 제외 내역 |
| `artifacts/window_model.joblib` | 검증 집에서 선택한 모델과 입력 명세·임계값 |
| `artifacts/report.json` | 집별 분리 내역, 클래스별 정밀도·재현율·F1, 혼동행렬, 버전·입력 해시 |
| `BASELINE_RESULTS.md` | 첫 실제 데이터 실행 결과 및 한계 |

모델 선택과 동작 임계값은 **p6 검증 데이터만** 사용합니다. p7은 선택 완료 후 평가합니다. 기본 학습 행 수는 30만 건으로 제한하며, 드문 OPEN/CLOSE를 모두 보존한 뒤 HOLD를 고정 난수로 추출합니다. 검증·평가는 모든 유효 행과 원래 클래스 비율을 유지합니다. 변경 예:

```powershell
.\model\.venv\Scripts\python.exe -m model.train --max-train-rows 600000 --trees 240
```

분리할 집은 `--validation-homes p6 --test-homes p7`로 지정합니다. 동일 집의 다른 창문도 같은 집에 속합니다. 시점별 무작위 분리로 이웃 기록이 학습과 평가에 섞이지 않습니다. 일곱 집 중 두 집만 검증·평가에 쓰는 첫 실험이므로 결과의 일반화에는 한계가 있습니다. 반복 실험은 검증 집으로 하고 최종 평가 집의 점수를 보고 설정을 조정하지 않습니다.

## 입력과 정답

허용 CSV 열은 정확히 다음 6개입니다. 온도는 °C, 상대습도는 %, 시각은 시간대가 포함된 ISO 형식입니다.

```csv
home_id,window_id,timestamp,temperature,humidity,window_open
room-001,window-1,2026-11-18T14:00:00+09:00,24.0,58.0,0
```

- `window_open`: **0=닫힘, 1=열림**. 모터 명령을 보냈다는 이유만으로 상태를 추정하지 않습니다. 확인되지 않은 상태는 빈 값으로 기록합니다.
- 입력 10개: 온도·습도·현재 상태, 온도/습도의 5분·15분 변화량, 최근 15분의 네 관측값 평균, 현재 상태를 연속 관측한 시간(최대 24시간).
- `OPEN`: t에서 닫혀 있고 t+5분에서 열려 있음.
- `CLOSE`: t에서 열려 있고 t+5분에서 닫혀 있음.
- `HOLD`: 두 시점의 상태가 같음. 5분 사이에 열었다 다시 닫는 짧은 동작은 이 정답으로 구별하지 못합니다.

입력은 t-15분~t만 사용합니다. 다음 시점의 온도·습도는 정답이나 입력에 쓰지 않습니다. 핵심 값 누락, 5분 간격 중단, 비정상 값은 연속 이력을 끊습니다. 보간이나 뒤 시점 값으로 채우지 않습니다. 최초 15분 이력이 없으면 `INSUFFICIENT_DATA`와 `HOLD`를 반환합니다. 현재 값이 없을 때 과거의 정상 행으로 돌아가서 예측하지 않습니다.

## 실제 장비 연결 시

라즈베리파이 원본은 빠르게 수집해도 되며, 학습 CSV와 맞는 5분 간격 기록을 저장하고 **5분마다 한 번** 예측합니다. 한 행의 측정 시각까지 도착한 최신 온도·습도와 확인된 창문 상태를 사용합니다. 시간 구간의 미래 값이나 다음 창문 이벤트를 섞지 않습니다.

장비 연결 프로그램은 `model.infer.predict(artifact, readings, now=현재시각)`를 호출하면 됩니다. `readings`는 한 창문의 최근 이력이 담긴 pandas DataFrame입니다. 실제 실행에서는 `now`를 반드시 전달해 5분 초과 지연·미래 시각을 막습니다. CLI도 `--now "2026-11-18T14:16:00+09:00"`를 지원합니다. 이를 생략한 CLI는 과거 기록 재생용입니다.

출력은 `action`, `status`, `scores`, `threshold` 등입니다. `scores`는 클래스 가중치를 사용한 **보정되지 않은 점수**이며 성공률·안전 확률이 아닙니다. 이미 열려 있는데 OPEN, 이미 닫혀 있는데 CLOSE는 반환하지 않습니다. 늦은 값, 이력 부족은 보류합니다. 명령을 자동 전송하지 않습니다. 강수·실외 오염·장비 고장·수동 제어 우선권은 이후 서버 정책으로 결합해야 합니다.

**현재 Node 서버에 모델을 연결하는 작업은 아직 별도입니다.** 서버/엣지/프론트의 CO₂ 필수 입력 계약도 실제 센서 구성에 맞게 바꿔야 합니다. CO₂를 0으로 채워 보내지 마세요. 현재 코드 추가 범위는 오프라인 학습·평가·추천 예측입니다.

## 원본과 전처리 근거

[UCL 7가구 데이터 V2](https://data.mendeley.com/datasets/47gjkbm29h/2), DOI [10.17632/47gjkbm29h.2](https://doi.org/10.17632/47gjkbm29h.2), CC BY 4.0.

Van Rooyen, Cairan; Fenech, Benjamin; Dimitroulopoulou, Sani; Davies, Mike; Elwell, Cliff (2026), “Longitudinal environmental and ventilation practice data from seven occupied homes in England”, Mendeley Data, V2.

수정 사항: 온도·습도와 같은 방의 창문만 추출하고, 가스·미세먼지·문·다른 방 센서는 제외했습니다. 한 창문이 원본의 여러 방 대응 목록에 반복되어 있어도 창문 이름에 해당하는 방만 한 번 사용합니다. 원본 전체의 516,077시점과 이 CSV의 ‘시점×창문’ 행 수는 다릅니다. 여러 창문의 같은 시점 값은 독립적인 집 표본이 아닙니다.

원본 이벤트는 **0=열림, 1=닫힘**으로 해석해 `window_open=1-source_state`로 변환합니다. 제공자의 `open_mean_mins`와 원본 0 상태의 `mins_next_event` 평균을 대조했습니다. 예를 들어 p5 거실 창문의 0 상태 평균 70.513분이 제공된 개방 평균 70.5분과 일치합니다. `fraction_time_open`은 이 검증에 사용하지 않습니다. 이 근거 값은 추출 감사 파일에도 기록합니다.

5분 측정 시각의 상태는 원본 `event_dict`에서 그 시각 이전/동일 시각의 마지막 이벤트로 다시 구합니다. 아직 일어나지 않은 같은 5분 구간의 이벤트를 가져오지 않고 첫 이벤트 이전은 알 수 없음으로 남깁니다. 원본의 시간대 없는 시각은 영국 현지 시간으로 가정해 UTC로 변환하고, 서머타임으로 모호하거나 존재하지 않는 시각은 버립니다. 원 저자가 처리한 온습도 데이터 자체의 보정·결측 처리 방식은 추가 검증 대상입니다.

평가 방식 참고: [scikit-learn 평가 지표](https://scikit-learn.org/stable/modules/model_evaluation.html). 전체 정확도보다 OPEN/CLOSE별 정밀도·재현율과 항상 HOLD인 기준 모델을 함께 보세요.
