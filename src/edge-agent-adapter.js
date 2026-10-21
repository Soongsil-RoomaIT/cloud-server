const { createHash } = require('node:crypto');
const v = require('./validation');
const ids = { window: 'window-1', air_purifier: 'purifier-1', door: 'door-1', dehumidifier: 'dehumidifier-1' };
const names = Object.fromEntries(Object.entries(ids).map(([a,id])=>[id,a]));
function unix(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value * 1000 > Date.now()+30000) throw new v.ApiError(400,'잘못된 Unix 시각입니다.');
  return new Date(value * 1000).toISOString();
}
function commandForEdge(command) {
  if (!names[command.deviceId]) throw new Error('Unsupported actuator');
  // New fields are ignored by today's edge. It must implement expiration and
  // persistent commandId deduplication before real unattended control is enabled.
  return { actuator: names[command.deviceId], on: ['OPEN','ON'].includes(command.action), commandId: command.commandId, expiresAt: command.expiresAt };
}
function handleLegacy(service, kind, payload, packet = {}) {
  return service.run(async () => {
    const now=Date.now(), state=service.state;
    if (kind==='status') {
      if (!['online','offline'].includes(payload)) throw new v.ApiError(400,'잘못된 엣지 상태');
      if (payload==='offline') service.offline(now);
      else if (!packet.retain) service.touch(false,now);
      return;
    }
    if (packet.retain) return;
    if (kind==='telemetry') {
      const measuredAt=unix(payload?.measuredAt);
      if (Date.parse(measuredAt)<now-8*86400000) return;
      // The frontend requires all five numbers. Missing PM10 is never invented.
      if (payload.pm10 == null) { service.touch(undefined,now); state.sensorIssue='엣지에서 PM10을 보내지 않아 완전한 센서 측정값을 기다리고 있습니다.'; return; }
      const r=v.reading.parse({...payload,measuredAt});
      await service.store.insert(r); service.touch(undefined,now); state.sensorIssue=null;
      if (!service.latest || measuredAt>service.latest.measuredAt) { service.latest=r;service.event('sensor.update',r); }
      service.evaluate(now);return;
    }
    if (kind!=='events') throw new v.ApiError(400,'알 수 없는 엣지 토픽');
    const event=v.z.object({occurredAt:v.z.number(),type:v.z.string().min(1).max(80),detail:v.z.record(v.z.string(),v.z.unknown())}).strict().parse(payload);
    const at=unix(event.occurredAt), detail=event.detail;
    const key=createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (state.legacy.seen.includes(key)) return;
    state.legacy.seen.push(key);
    const fresh=now-Date.parse(at)<15000;
    if (fresh) service.touch(undefined,now);
    if (event.type==='mode_changed') {
      if (!['online','offline'].includes(detail.mode)) throw new v.ApiError(400,'잘못된 엣지 모드');
      if (detail.mode==='offline') state.legacy.offlineSince=at;
      if (fresh) { state.edge.offlineMode=detail.mode==='offline';service.event('edge.status',state.edge); }
    } else if (event.type==='reconnected') {
      const duration=detail.offline_seconds;
      if (duration != null && (typeof duration!=='number'||!Number.isFinite(duration)||duration<0)) throw new v.ApiError(400,'잘못된 복구 시간');
      const offlineSince=state.legacy.offlineSince || (typeof duration==='number'?new Date(Date.parse(at)-duration*1000).toISOString():null);
      if (offlineSince && offlineSince<=at) {
        if (!state.recoveryReported) service.event('edge.recovered',{offlineSince,recoveredAt:at,localActions:[]});
        state.recoveryReported=true;state.pendingRecovery=null;state.offlineSince=null;
        service.notify('엣지 연결 복구: 기존 엣지 이벤트에는 실제 완료 확인이 없어 로컬 실행 완료 내역은 비워 두었습니다.');
      }
      state.legacy.offlineSince=null;
    } else if (['door_opened','door_closed'].includes(event.type)) {
      const target=event.type==='door_opened'?'OPEN':'CLOSED';service.applyDevice(service.device('door-1'),target,at);
      const c=state.commands.find(c=>c.deviceId==='door-1'&&c.status==='PENDING'&&c.action==='CLOSE'&&at>=c.createdAt&&at<=c.expiresAt);
      if(target==='CLOSED'&&c)service.finish(c,'EXECUTED','현관문 센서에서 닫힘 확인',at);
    } else if (['remote_command','auto_control','actuator_error'].includes(event.type)) {
      const id=ids[detail.actuator];
      if(!id||typeof detail.on!=='boolean')throw new v.ApiError(400,'잘못된 액추에이터 이벤트');
      const action=['window','door'].includes(detail.actuator)?(detail.on?'OPEN':'CLOSE'):(detail.on?'ON':'OFF');
      const c=state.commands.find(c=>c.deviceId===id&&c.action===action&&c.status==='PENDING'&&at>=c.createdAt&&at<=c.expiresAt);
      if(event.type==='actuator_error'&&c)service.finish(c,'FAILED','엣지가 액추에이터 오류를 보고했습니다.',at);
      else if(event.type==='remote_command'&&c){c.acceptedAt=at;c.reason='엣지가 명령을 수락했습니다. 실제 완료 확인 대기 중입니다.';}
      else if(event.type==='auto_control')service.notify(`${service.device(id).name}: 엣지 로컬 제어 요청 접수 (실제 완료 미확인)`);
    } else if(event.type==='sensor_error')state.sensorIssue='엣지가 센서 오류를 보고했습니다.';
    else if(event.type==='sensor_recovered')state.sensorIssue=null;
    service.evaluate(now);
  });
}
module.exports={handleLegacy,commandForEdge};
