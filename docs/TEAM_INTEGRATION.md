# 팀 저장소 비교와 연결 계획

팀 배포 기준은 SAD v1.4와 각 저장소의 main 브랜치입니다. 아래에 이전 연동 검토 이력도 함께 남깁니다.

| 저장소 / 확인 커밋 | 현재 역할과 실제 코드 | Cloud Server 반영 |
|---|---|---|
| [frontend feat/control-page](https://github.com/Soongsil-RoomaIT/frontend/tree/aac78fa5fc21d0428a7603fabb449a0a83233be0) | 모니터링·기기 제어, Idempotency-Key, command.ack.deviceId, actions/stateSource/autoCloseAt | API와 WS 형식 일치, 중복 요청 24시간 차단, 닫기 전용 현관문 |
| [frontend feat/monitoring](https://github.com/Soongsil-RoomaIT/frontend/tree/f5ba1e952f4c252eb8895a2809ad8151550011b6) | 사용자가 처음 지정한 모니터링 계약 | 기존 4개 GET 및 WS 메시지와도 호환 |
| [edge_agent main](https://github.com/Soongsil-RoomaIT/edge_agent/tree/45624f8c7ea3293442269563fb8c37a12b41766f) | Python 센서·SQLite·MQTT·오프라인 제어 | roomcare/room-001 토픽, Unix 초→ISO, 문자열 status, 이벤트 변환 |
| [hardware main](https://github.com/Soongsil-RoomaIT/hardware/tree/f362caf08f95cb43e2600a41c64667f7ae5ea8cf) | 센서·모터·서보 드라이버, 비동기 set 및 fault/position | 수락 이벤트를 완료로 오인하지 않음, 현관문 OPEN 미지원, 미확인 상태 ASSUMED |
| [backend main](https://github.com/Soongsil-RoomaIT/backend/tree/main) | Node.js Gateway, WebSocket 중계, 내부 알림 API, VM Compose | 센서 응답·실시간 이벤트 중계, 내부 알림 요청 |

## 먼저 팀과 맞출 사항

### A 엣지 담당

팀 엣지와 클라우드는 `MQTT_PROTOCOL=roomait-v1`로 연결합니다. 센서·기기·명령의 시각은 UTC ISO 형식이고, `events`의 `occurredAt`은 Unix 초입니다. 엣지의 `EXECUTED` ACK 또는 현관문 닫힘 센서 이벤트로 명령 결과를 확정합니다. [MQTT 메시지 계약](MQTT.md)

### B 하드웨어 담당

프론트는 초기 미확인 상태 `UNKNOWN`을 표시합니다. LED 기기는 `COMMANDED`, MC-38 센서가 달린 현관문은 `SENSOR`를 사용합니다. 서버는 해당 연결에서 상태가 확인된 기기만 자동화 판단에 사용합니다. 현관문 10분 타이머는 엣지가 담당하고, 클라우드는 엣지가 보고한 `autoCloseAt`을 표시합니다. 클라우드는 웹에서 요청한 수동 닫기 명령을 전달할 수 있습니다.

### D 백엔드 담당

[backend main의 Gateway](https://github.com/Soongsil-RoomaIT/backend/blob/main/node-service/src/app.js)는 `/api` 요청을 중계하고, 원격 제어 요청의 `Idempotency-Key`를 유지합니다. SAD v1.4 시연에서는 한 세대의 웹 화면을 로그인 없이 사용합니다.

팀 Compose는 클라우드 서버에 `GATEWAY_INTERNAL_NOTIFICATIONS_URL=http://gateway-service:8080/internal/notifications`를 주입합니다. 클라우드 서버와 Gateway의 `INTERNAL_API_KEY`에는 같은 값을 사용합니다. 클라우드 서버는 `X-Internal-Key` 헤더와 `eventId`, `title`, `body`, `data`를 보냅니다. Gateway는 자신의 `ROOM_USER_ID`로 수신자를 정하고, 24시간 동안 같은 이벤트 ID를 중복 처리하지 않습니다.

기기 동작 결과는 `device.command`, 엣지 복구는 `edge.recovered`, 기준값 추천 적용은 `recommendation.applied`로 전송합니다. Gateway는 알림을 저장하고 `notification.new`를 브라우저에 전달합니다. 클라우드 서버는 최대 3회 전송을 시도하고 Gateway의 결과 상태를 기록합니다.

가스 감지·해제는 `gas.detected`·`gas.cleared` 알림으로 전달합니다. 창문 열림 여부는 엣지 기기 상태 이벤트로 확인합니다.

### E 프론트엔드 담당

모니터링과 기기 제어는 실제 guard 함수로 검증했습니다. 예보·설정·알림 페이지는 팀 브랜치에서 아직 준비 중인 화면이며, 이번 서버의 기능은 `/demo` 또는 API로 확인할 수 있습니다. `EXPIRED`/`FAILED` 추천 상태, 기상청 pm25=null, unknown 초기 상태 표현은 후속 UI에서 반영해야 합니다.

현재 control-page의 lockfile에는 MSW 하위 의존성이 누락되어 npm ci가 실패합니다. 로컬 설치 도구는 npm install로 복구합니다. 확인 당시 기존 프론트 개발 의존성 vite/source-map-js에 npm audit high 2건이 있었으며 이 서버의 의존성 audit는 0건입니다. 이 작업은 프론트 원격 의존성을 수정하지 않았습니다.
