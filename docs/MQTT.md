# MQTT 연결 계약

## 현재 팀 Edge와 연결

`.env`: `DEMO_MODE=false`, `MQTT_PROTOCOL=edge-agent`, `MQTT_TOPIC_PREFIX=roomcare/room-001`. 실제 브로커와 PostgreSQL 주소도 설정합니다. 디바이스 ID를 바꾸면 prefix를 함께 맞춥니다.

| 토픽 suffix | 방향 | 처리 |
|---|---|---|
| telemetry | Edge→Cloud | Unix 초 measuredAt을 UTC ISO로 변환, 5개 센서 숫자 검증·저장·브로드캐스트 |
| status | Edge→Cloud | 문자열 online/offline, retained online은 생존 증거로 사용하지 않음 |
| events | Edge→Cloud | occurredAt/type/detail, 모드·복구·현관문·제어 수락·오류 처리 |
| command | Cloud→Edge | actuator/on + commandId/expiresAt, QoS0, retain=false |

pm10=null인 과거 데이터는 수치를 조작하지 않고 완전한 측정값에서 제외하며 health.sensorIssue를 통해 안내합니다. 다른 필드가 잘못된 메시지도 거부합니다. 마지막 수신 시간이 10초 경과하면 offline으로 판단합니다. 이 서버의 offline 판정은 라즈베리파이 자체 모드 전환을 보장하지 않습니다.

프론트 기기 ID ↔ 엣지 actuator: window-1 ↔ window, purifier-1 ↔ air_purifier, door-1 ↔ door, dehumidifier-1 ↔ dehumidifier(현재 Edge 미등록). 현관문은 CLOSE만 허용합니다.

`remote_command`는 수락 시각을 기록하며 기기 상태와 명령 성공을 바꾸지 않습니다. `door_closed`의 실제 센서 이벤트는 대응되는 닫기 명령을 완료시킬 수 있습니다. 기존 Edge에는 창문·가전 완료 피드백이 없어 해당 명령은 미확인 타임아웃이 될 수 있습니다. 장비 상태를 확인하기 전 재명령하지 마세요.

## 완료 ACK를 지원하는 확장 계약

`MQTT_PROTOCOL=roomait-v1`로 선택합니다. **현재 팀 Edge가 이 계약을 구현했다고 간주하지 않습니다.** 토픽 prefix는 설정값을 그대로 사용합니다. 모든 메시지는 UTF-8 JSON, UTC ISO timestamp, 숫자 필드는 숫자입니다.

| suffix | 방향 | payload |
|---|---|---|
| sensors | Edge→Cloud | `{measuredAt, temperature, humidity, co2, pm25, pm10}` |
| devices | Edge→Cloud | `{id, state, updatedAt}` |
| status | Edge→Cloud | `{online, offlineMode}` |
| recovery | Edge→Cloud | `{offlineSince, recoveredAt, localActions:[{executedAt,deviceId,state,reason}]}` |
| ack | Edge→Cloud | `{commandId,status:"EXECUTED"\|"FAILED",reason,executedAt}` |
| commands | Cloud→Edge | `{commandId,deviceId,action,reason,issuedAt,expiresAt}` |

확장 명령은 QoS1·retain=false입니다. Edge가 commandId를 영속 중복 차단하고 expiresAt을 검사해야 합니다. 연결 시작 시 상태/기기 스냅샷을 non-retained로 재발행하고 센서 또는 상태 신호를 5초 이내 주기로 보내세요. LWT status는 `{online:false,offlineMode:true}`를 retained로 지정할 수 있습니다. retained 과거 데이터는 실시간 생존으로 처리하지 않습니다.

단절 후에는 recovery를 status보다 먼저 또는 2초 이내 보내세요. 상세 리포트가 없으면 서버가 빈 localActions 복구 이벤트를 한 번 보냅니다. 늦게 온 상세 리포트는 중복 복구 팝업 없이 상태/알림 기록에 반영합니다. localActions는 실제 완료한 동작만 넣습니다.

명령 5초 타임아웃은 기본 설정이며 모터의 완전 도달 시간과 NFR-02의 동작 시작 시간은 별개입니다. 테스트 후 시작/완료 ACK를 분리하고 COMMAND_TIMEOUT_MS와 프론트 대기시간(현재 20초)을 함께 조정해야 합니다.

브로커 운영 구성은 기기별 인증·topic ACL·TLS가 필요합니다. 제공된 compose는 외부 Pi가 직접 접근할 수 없는 localhost 개발용입니다.
