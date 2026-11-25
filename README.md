# RoomaIT Cloud Server

자취방 원격 케어 시스템의 C 담당 클라우드 서버입니다. 팀 프론트엔드의 모니터링·기기 제어 API와 실시간 메시지를 제공하고, 엣지 데이터 수집·저장·자동화 판단을 담당합니다. **기본 실행은 실제 장비를 사용하지 않는 로컬 데모입니다.**

## 지금 실행하기

Node.js 24 LTS 권장 (최소 22). `CloudAIoT` 폴더에서 실행합니다.

```powershell
npm install
npm run frontend:setup
npm start
```

- 팀 대시보드: http://localhost:8081
- 서버 실습 콘솔: http://localhost:8081/demo
- 상태 확인: http://localhost:8081/health
- 종료: 실행한 터미널에서 Ctrl+C

기본 포트를 8081로 정해 D 담당 Gateway(8080)와 분리했습니다. 필요하면 `.env.example`을 `.env`로 복사해 설정합니다. 로컬 데모에는 MQTT·PostgreSQL·날씨 API 키가 필요 없습니다. 약 6시간의 가상 차트 데이터와 5초 주기 가상 센서를 제공합니다. **가상 데이터·설정·이력은 재시작 시 초기화**됩니다.

`frontend:setup`은 팀 `frontend/feat/control-page`를 `.local/frontend`에 복제해 목업을 끄고 빌드합니다. 이 폴더는 Git에 포함되지 않으며 팀 프론트엔드 원격 저장소를 수정하지 않습니다. 기존 로컬 checkout이 있으면 그 브랜치를 유지합니다. 현재 팀 lockfile의 누락 항목 때문에 이 checkout에서는 `npm install`로 의존성을 맞춥니다. 서버는 빌드 파일을 제공하므로 별도 Vite 서버가 필요 없습니다. 포트를 바꾸면 `powershell -File scripts/setup-frontend.ps1 -Port 18080`로 다시 빌드하고 `.env`의 PORT와 CORS_ORIGINS도 맞춥니다.

## 구현된 기능

- 센서 최신값, 1시간·24시간·7일 평균 이력, 기기 목록, 엣지 상태 REST API
- 표준 `ws` WebSocket: 연결 직후 edge.status, 15초 heartbeat, JSON ping 응답, 센서·기기·복구·명령 결과 이벤트
- 비동기 원격 명령(202), 24시간 Idempotency-Key 중복 방지, 실행 확인·오류·타임아웃 기록
- SAD v1.4 온습도·외기 미세먼지·강수 규칙, 엣지 현관문 예약 표시, MQ-2 감지 상태·알림
- 자동화 사용 여부, 승인 후 실행/완전 자동 설정, 수동 조작 후 10분 자동화 보류
- 추천 근거, 명령 이력, 웹 실시간 알림과 읽음 처리
- 팀 `edge_agent`의 실제 MQTT 토픽·Unix timestamp·이벤트 형식 변환
- PostgreSQL 스키마와 저장 어댑터, 기상청 예보·최근 2시간 실황 조회 어댑터

자동화는 기본 OFF입니다. 웹에서 자동화를 켜면 규칙을 자동 실행하고, `/demo`에서는 승인 후 실행 모드도 시험할 수 있습니다. `/demo`에서 설정 후 습도 75% 입력, 환기 추천 승인, 실행 이벤트를 확인할 수 있습니다. 데모 센서가 5초 후 원래 값으로 돌아가면 오래된 추천은 만료됩니다.

## API

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/sensors/latest` | 온습도·미세먼지 등 센서값과 gasDetected, 첫 측정 전 503 |
| GET | `/api/sensors/history?range=1h\|24h\|7d` | 각각 60·300·3600초 버킷 평균 |
| GET | `/api/devices` | actions/stateSource/autoCloseAt 포함 기기 목록 |
| GET | `/api/edge/status` | online/offlineMode/lastSeenAt |
| POST | `/api/devices/:id/commands` | `{ "action": "OPEN" }`, Idempotency-Key 권장 |
| GET | `/api/commands`, `/api/commands/:id` | 최근 명령 이력·상세 |
| GET | `/api/outdoor` | 외기 온습도·강수확률·PM2.5·PM10, 발표/조회 시각, 전후 2시간 자료 |
| GET | `/api/forecast` | 1시간 뒤 실내 습도·온도 예측. 모델 준비 중에는 빈 metrics와 안내 문구 |
| GET | `/api/recommendations` | 저장된 기준값 추천 이력 |
| POST | `/api/recommendations/:id/apply`, `/reject`, `/revert` | 기준값 추천 적용·거절·되돌리기. 중복 처리 시 409 |
| POST | `/api/decisions/:id/approve`, `/reject` | 추천 승인·거절 |
| GET, PUT | `/api/automation` | 전체 스위치, 규칙별 기준값·사용 여부 조회와 수정 |
| GET, PUT | `/api/settings/automation` | 자동화 설정 전체 조회·저장 |
| GET | `/api/notifications` | 웹 알림 목록 |
| PATCH | `/api/notifications/:id/read` | 읽음 처리 |
| WS | `/ws` | 실시간 메시지 |

예측 모델이 완성되면 모델 실행 측에서 PostgreSQL의 `prediction` 테이블에 계산 시각(`generated_at`), 모델 버전(`model_version`), 예측 기반 제어 사용 여부(`control_enabled`), 지표 배열(`metrics`)을 한 행으로 저장합니다. 각 지표에는 `metric`(humidity 또는 temperature), `predicted`, `baseline`, `actual`, `mae`, `baselineMae`를 넣습니다. 미확정 수치는 null입니다. API는 가장 최근 행을 반환하고, 연결 중인 WebSocket에는 기본 15초마다 변경을 확인해 같은 형식의 `forecast.update`를 보냅니다.

기준값 추천의 조회·적용·거절·되돌리기는 기존 API를 사용합니다. SAD v1.4의 환경 데이터 기반 추천 계산 방식은 팀 설계가 진행 중입니다.

기본 자동제어 기준은 습도 70% 초과·60% 미만, 온도 30°C 초과, 외기 PM2.5 35·PM10 80 µg/m³ 초과 및 향후 2시간 강수확률 60%입니다. 환기에는 실내보다 낮은 외기 습도와 정상 외기 미세먼지가 필요합니다. 알려진 외기 조건 때문에 환기가 막히고 실내 습도가 높으면 제습기를 켭니다. 환기를 위해 열린 창문은 습도 규칙으로 다시 닫기 전에 30분간 유지합니다. 외기 미세먼지 악화에 따른 닫기는 이 시간과 별도로 판단합니다.

엣지는 현관문 타이머와 가스 감지 시 창문 LED 열기를 맡습니다. 클라우드는 예약 시각을 표시하고 가스 감지·해제 이벤트를 Gateway 알림으로 전달합니다. 활성 감지 상태는 값이 `null`이 되어도 유지되며 이후의 해제 신호로 해제됩니다.

동작 완료는 실제 ACK 또는 현관문 센서 확인으로 판단합니다. 타임아웃은 기기가 움직이지 않았다는 보장이 아니라 **정해진 시간 안에 확인하지 못했다는 뜻**입니다. 명령을 자동 재전송하지 않습니다. 결정 상태에는 초안 외에 `FAILED`, `EXPIRED`가 있습니다.

## 팀 코드와의 관계

팀 저장소 비교 및 담당별 연결 항목은 [TEAM_INTEGRATION.md](docs/TEAM_INTEGRATION.md), 엣지 토픽과 메시지는 [MQTT.md](docs/MQTT.md), 데이터 구조는 [DATA_MODEL.md](docs/DATA_MODEL.md), 요구사항별 확인 범위는 [ACCEPTANCE.md](docs/ACCEPTANCE.md)에 정리했습니다.

기존 엣지는 액추에이터 `set()` 호출 성공을 `remote_command`로 발행하지만, 하드웨어 드라이버의 `set()`은 비동기 동작 수락입니다. 따라서 그 이벤트를 실제 완료 ACK로 바꾸지 않습니다. 창문·가전의 완료 피드백, commandId·만료 처리, 제습기 등록이 엣지에 추가되어야 실제 장비 전체 제어가 완성됩니다. 처음부터 확인된 상태가 없는 기기는 서버 시작 시각과 `UNKNOWN` / `ASSUMED`를 반환합니다. 기기 상태를 받은 뒤 기본 출처는 창문 `COMMANDED`, 현관문 `SENSOR`, 버튼 서보 가전 `ASSUMED`입니다. 엣지가 LED 대체 가전에 `COMMANDED`를 명시하면 그대로 전달합니다. 현관문 카운트다운은 엣지가 보고한 예약 시각을 사용합니다.

팀 [backend/main](https://github.com/Soongsil-RoomaIT/backend/tree/main) Gateway에 내부 알림을 전송합니다. SAD v1.4 팀 배포는 로그인 없이 운영하며, Cloud Server의 JWT 설정은 별도로 구성할 수 있습니다. 기본 알림 목록/WS 알림은 **브라우저가 꺼져 있을 때의 FCM push가 아닙니다**. 실제 푸시 자격 증명이나 타인에게 알림 전송을 설정하지 않았습니다.

## 실제 서비스로 전환하기

1. Docker Desktop을 실행한 뒤 `docker compose up -d`로 로컬 PostgreSQL·Mosquitto를 띄웁니다. 이 구성은 localhost 개발 전용입니다.
2. `.env`에서 `DEMO_MODE=false`, DATABASE_URL, MQTT_URL을 설정합니다. `.env.example`의 예시를 참고합니다. 팀 v1.4 엣지는 `MQTT_PROTOCOL=roomait-v1`, `MQTT_TOPIC_PREFIX=roomcare/room-001`을 사용합니다.
3. `npm run db:init`, `npm start`를 실행합니다. 실제 모드는 가상 데이터 없이 시작하며, 엣지 측정이 들어오기 전 센서 API는 503입니다.
4. 기상청 활용 신청 후 **디코딩된** 서비스키와 실제 위치 격자(KMA_NX/NY)를 설정합니다. 기본 60/127은 예시이며 사용자의 위치를 추정한 것이 아닙니다.
5. 실제 장비를 연결하기 전 팀 연동 문서의 엣지 완료 ACK·인증·Gateway·단일 자동화 소유자 항목을 맞추고 인수시험을 수행합니다.

기상청 데이터는 [단기예보 조회서비스](https://www.data.go.kr/data/15084084/openapi.do)를 사용합니다. 외기 카드의 미세먼지는 [에어코리아 측정소별 실시간 측정정보](https://www.data.go.kr/data/15073861/openapi.do)를 사용합니다. 실행 환경에 `AIRKOREA_SERVICE_KEY`(디코딩 키)와 `AIRKOREA_STATION_NAME`(해당 지역 측정소명)을 설정하세요. 컨테이너로 실행한다면 두 변수도 cloud-server 컨테이너에 전달해야 합니다. 외기 API는 키가 없는 항목에 null과 안내 메시지를 반환합니다. publishedAt은 기상청 예보 발표 시각(대기질만 있을 때는 측정 시각), fetchedAt은 가장 최근 성공한 조회 시각입니다. 어느 출처든 마지막 조회가 3시간을 넘기거나 대기질 측정이 3시간을 넘기면 stale로 표시합니다. 기존 자동화는 기상청 예보를 사용하며 강수확률에 따른 닫기 판단이 가능합니다. 예측은 학습 모델이 아닌 설명 가능한 규칙이며 과거 2시간 실황은 조회·표시용입니다.

서버 기본 bind는 127.0.0.1입니다. `API_BEARER_TOKEN`은 로컬 연동 점검용 공통 토큰입니다. JWT_ISSUER_URI, JWT_JWK_SET_URI, JWT_AUDIENCE, ROOM_ALLOWED_SUBJECTS를 설정하면 Keycloak RS256 서명·issuer·audience·exp·sub와 해당 공간 사용자 권한을 직접 검증합니다. 토큰 인증 시 WS는 첫 auth 메시지 또는 D Gateway가 전달하는 Authorization handshake 헤더를 받습니다. 현재 팀 프론트엔드는 auth 메시지를 아직 구현하지 않아 기본 데모에서는 인증을 비워 둡니다. `NODE_ENV=production`은 데모 및 JWT 설정 없는 실행을 거부합니다.

실서비스에서 `GATEWAY_INTERNAL_NOTIFICATIONS_URL`에 Gateway 내부 알림 주소를 지정하고, Gateway와 같은 `INTERNAL_API_KEY`를 설정합니다. 클라우드 서버는 알림을 저장한 뒤 전송하고, 전송 실패 시 같은 `eventId`로 30초 간격으로 최대 3회 시도합니다. Gateway가 반환한 sent/dry-run/duplicate/no-targets/partial-failure를 저장합니다. Gateway가 브라우저의 알림 목록과 `notification.new` 이벤트를 제공합니다.

## 검증

```powershell
npm ci
npm test
node scripts/verify-frontend-contract.js
```

마지막 검증은 `frontend:setup` 이후 Node 24에서 실행하며, 팀 프론트의 실제 타입 검사 함수로 Device와 여섯 종류 WS 메시지를 확인합니다. 자동 테스트는 HTTP/WS, MQTT 브로커(Aedes), PostgreSQL 엔진(PGlite), 시간 집계·중복 요청·자동화·복구·저장 실패를 포함합니다. 실제 장비·Docker PostgreSQL 연결·인증된 기상청 응답·FCM 전송 및 브라우저 화면 인수시험은 별도입니다.

단일 세대·단일 서버 프로세스 전제입니다. 여러 서버 인스턴스를 동시에 실행하지 마세요. 최근 완료 이력은 종류별 1,000개, idempotency는 24시간(최대 10,000개)을 보관합니다. PostgreSQL 센서 원본의 장기 보존·백업 정책은 운영 환경에서 설정해야 합니다.


