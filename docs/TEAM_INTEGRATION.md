# 팀 저장소 비교와 연결 계획

2026-10-21 공개 저장소 코드를 읽고 비교했습니다. 다른 팀원의 저장소에는 commit/push하지 않습니다.

| 저장소 / 확인 커밋 | 현재 역할과 실제 코드 | Cloud Server 반영 |
|---|---|---|
| [frontend feat/control-page](https://github.com/Soongsil-RoomaIT/frontend/tree/aac78fa5fc21d0428a7603fabb449a0a83233be0) | 모니터링·기기 제어, Idempotency-Key, command.ack.deviceId, actions/stateSource/autoCloseAt | API와 WS 형식 일치, 중복 요청 24시간 차단, 닫기 전용 현관문 |
| [frontend feat/monitoring](https://github.com/Soongsil-RoomaIT/frontend/tree/f5ba1e952f4c252eb8895a2809ad8151550011b6) | 사용자가 처음 지정한 모니터링 계약 | 기존 4개 GET 및 WS 메시지와도 호환 |
| [edge_agent main](https://github.com/Soongsil-RoomaIT/edge_agent/tree/45624f8c7ea3293442269563fb8c37a12b41766f) | Python 센서·SQLite·MQTT·오프라인 제어 | roomcare/room-001 토픽, Unix 초→ISO, 문자열 status, 이벤트 변환 |
| [hardware main](https://github.com/Soongsil-RoomaIT/hardware/tree/f362caf08f95cb43e2600a41c64667f7ae5ea8cf) | 센서·모터·서보 드라이버, 비동기 set 및 fault/position | 수락 이벤트를 완료로 오인하지 않음, 현관문 OPEN 미지원, 미확인 상태 ASSUMED |
| [backend main](https://github.com/Soongsil-RoomaIT/backend/tree/8403084825c9b46b071bf845b2ece61068905615) | Spring Gateway, Keycloak, FCM, Redis, TLS, 관측성 | 포트 8081 사용. 인증·FCM을 중복 구현하지 않고 연결 조건 문서화 |
| [backend minjae](https://github.com/Soongsil-RoomaIT/backend/tree/5ec1f1c78757c7f0b79661d5e50cb2c8a8e77ace) | 최신 Node Gateway, 표준 WS, Keycloak 검증, 서비스계정 알림, Redis 이력 | JWT/공간 권한 검증, WS Authorization 헤더, client credentials 알림 어댑터, /health 제공 |

backend는 main과 minjae의 차이까지 비교했으며 **실제 연결 권장은 minjae**입니다. frontend main은 모니터링 단계이며 제어 기능은 feat/control-page에 있습니다.

## 먼저 팀과 맞출 사항

### A 엣지 담당

현재 `_handle_command()`는 commandId/expiresAt을 처리하지 않습니다. MQTT QoS1 명령 재전송은 중복 구동 위험이 있으므로 기존 프로토콜에서는 서버가 QoS0·retain=false로 한 번만 전송합니다. HTTP 중복 차단은 구현했지만 이것이 엣지의 영속 중복 차단을 대신하지는 않습니다.

1. commandId를 SQLite에 기록해 재시작/재전송 후에도 한 번만 구동합니다. expiresAt이 지난 명령은 실행하지 않습니다.
2. `set()` 호출 성공 이후 `position`, `is_moving`, `fault`를 확인하고 실제 도달했을 때 ACK를 보냅니다. 현재 remote_command는 수락으로만 기록하고, 완료를 확인하지 못하면 서버는 실패/미확인으로 종료합니다.
3. 창문·가전의 실제 상태 스냅샷을 시작·재연결·변경 시 전송합니다. 기존 이벤트에는 창문 위치 정보가 없습니다.
4. hardware에 존재하는 dehumidifier를 Edge의 actuator 등록·명령·자동화 규칙에 추가합니다. 현재 live edge-agent 모드에서는 해당 actions를 []로 보냅니다.
5. 복구 이벤트는 실제 완료한 localActions를 포함해야 합니다. 기존 auto_control 이벤트도 set 수락이라 서버가 완료 이력으로 위조하지 않습니다.
6. 현재 ConnectivityMonitor는 MQTT 브로커 연결만 봅니다. **Cloud Server만 종료되고 브로커는 살아 있는 경우를 감지하지 못합니다.** NFR-03을 충족하려면 클라우드 heartbeat/lease와 엣지 타임아웃 계약이 추가되어야 합니다.

### B 하드웨어 담당

창문 중간/unknown/fault는 CLOSED와 다릅니다. 현재 프론트 상태 enum은 네 값뿐이므로 초기 추정값에는 ASSUMED를 표시하고, 확인된 상태만 자동화 판단에 사용합니다. 실제 위치·fault 확장 모델은 A/E와 함께 정해야 합니다. 보유한 DHT/터치만으로 CO₂/PM 수치를 채우지 않습니다.

현관문 10분 정책은 이 서버에 있으며 AUTO에서만 실행됩니다. 하드웨어의 시험용 DoorAutoCloser와 동시에 활성화하지 말고 하나만 소유해야 합니다. 승인 모드에서는 10분 후 닫기 추천만 생성됩니다.

### D 백엔드 담당 최신 minjae

Node Gateway는 `/api` 전체를 C로 중계하며 자체적으로 `/api/push/token`, GET `/api/notifications`, POST `/api/notifications/send`를 처리합니다. WS 인증 후 C에 Authorization 헤더로 JWT를 전달합니다. 이 서버가 그 헤더와 Keycloak 서명/만료/audience 및 ROOM_ALLOWED_SUBJECTS를 검증하도록 구현했습니다.

현재 Gateway의 REST proxy는 **Idempotency-Key를 전달하지 않습니다**. `node-service/src/app.js`의 headers 생성 뒤에 다음을 추가해야 합니다. 실제 모드의 C는 키가 없는 수동 명령을 400으로 거부하므로, 이 수정 전에는 D 경유 원격 제어가 실패하는 것이 정상입니다. 본 작업에서 D 저장소를 수정·push하지 않았습니다.

```js
if (typeof req.headers['idempotency-key'] === 'string') {
  headers['idempotency-key'] = req.headers['idempotency-key'];
}
```

D 설정은 CLOUD_SERVICE_URL=http://host.docker.internal:8081, CLOUD_HEALTH_PATH=/health입니다. Docker에서 Windows 호스트에 접근할 때는 C의 HOST를 접근 가능한 내부 인터페이스로 지정해야 하며, 운영 시 인증·방화벽으로 제한해야 합니다. 개발용 무인증 연결은 D의 DEV_AUTH_BYPASS와 C의 인증 없는 개발 모드에서만 시험합니다.

C의 JWT 설정 예시(실제 사용자 subject를 지정):

```dotenv
JWT_ISSUER_URI=http://localhost:8180/realms/room-care
JWT_JWK_SET_URI=http://localhost:8180/realms/room-care/protocol/openid-connect/certs
JWT_AUDIENCE=room-care-api
ROOM_ALLOWED_SUBJECTS=실제-Keycloak-subject
```

자동화 알림은 D가 제공하는 room-care-automation / NOTIFICATION_SENDER 서비스계정을 사용합니다. NOTIFICATION_SEND_URL=http://localhost:8080/api/notifications/send, AUTOMATION_TOKEN_URL=http://localhost:8180/realms/room-care/protocol/openid-connect/token, NOTIFICATION_USER_ID=해당 공간 사용자 subject와 AUTOMATION_CLIENT_SECRET을 비공개 .env에 설정합니다. C가 토큰 캐시·만료 전 갱신·최대 3회 시도와 결과 기록을 담당합니다. 기본 설정은 비활성이고 실제 전송은 수행하지 않았습니다.

D의 알림 목록은 id/title/body/data/status이며 C의 직접 조회 목록은 message/read/pushStatus를 포함합니다. D 경유 GET 목록은 D가 소유하므로 C의 읽음 API와 곧바로 같은 저장소를 공유하지 않습니다. 목록·읽음 UI의 최종 계약은 E/D/C가 맞춰야 합니다. D가 dry-run/partial-failure를 반환하면 C도 그 상태를 보존합니다.

### D main 브랜치의 이전 Java 구현 참고

현재 Gateway는 `/api/devices/**`, `/api/sensors/**`, `/api/automation/**`만 Cloud Server로 보냅니다. `/api/edge/**`, `/api/commands/**`, `/api/forecast`, `/api/decisions/**`, `/api/settings/**`, `/ws`는 추가해야 합니다. [gateway-routes.example.yml](gateway-routes.example.yml)은 라우팅 검토용 예시이며 현재 팀 서버에 적용하지 않았습니다.

`/api/notifications/**`는 현재 D 서비스로 전부 라우팅됩니다. C의 GET 목록과 PATCH 읽음 처리는 정확한 경로/메서드로 먼저 분리하고, D의 POST devices/send는 기존 서비스로 보내야 합니다. C의 notification.created 이벤트를 D의 아래 API로 전달할 내부 인증과 대상 userId 계약도 필요합니다.

```json
POST /api/notifications/send
{
  "eventId": "C 알림의 고유 id",
  "userId": "Keycloak 사용자 subject",
  "title": "자취방 원격 케어",
  "body": "장치 동작 결과",
  "data": { "commandId": "명령 id", "type": "device.command" }
}
```

D의 현 구현은 FCM 자격 증명이 없으면 dry-run입니다. 서비스계정 client credentials를 분리할 계획이나 아직 준비되지 않았습니다. Redis 중복 키를 실제 발송 전에 넣으므로 발송 도중 실패 후 재시도 동작도 점검해야 합니다. 서버 웹 알림 성공을 FCM 수신 성공으로 간주하지 않습니다.

Gateway는 현재 모든 요청에 JWT를 요구합니다. 브라우저 WS는 Authorization 헤더를 넣지 못하므로 단순 WS 라우트 추가만으로 연결되지 않습니다. 쿠키/첫 메시지 인증 중 팀 방식을 합의하고, Cloud Server의 테스트용 고정 Bearer 토큰과 Keycloak JWT 검증을 연결해야 합니다. 외부 공개 시 C가 사용자별 JWT를 검증하거나 인증된 내부망 Gateway만 접근하도록 배치해야 하며, 보호 없이 직접 공개하지 않습니다.

### E 프론트엔드 담당

모니터링과 기기 제어는 실제 guard 함수로 검증했습니다. 예보·설정·알림 페이지는 팀 브랜치에서 아직 준비 중인 화면이며, 이번 서버의 기능은 `/demo` 또는 API로 확인할 수 있습니다. `EXPIRED`/`FAILED` 추천 상태, 기상청 pm25=null, unknown 초기 상태 표현은 후속 UI에서 반영해야 합니다.

현재 control-page의 lockfile에는 MSW 하위 의존성이 누락되어 npm ci가 실패합니다. 로컬 설치 도구는 npm install로 복구합니다. 확인 당시 기존 프론트 개발 의존성 vite/source-map-js에 npm audit high 2건이 있었으며 이 서버의 의존성 audit는 0건입니다. 이 작업은 프론트 원격 의존성을 수정하지 않았습니다.
