const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const v = require('./validation');

const defaults = { enabled: false, mode: 'APPROVAL', humidityOn: 65, humidityOff: 55, co2Open: 1000, pm25On: 35, rainProbability: 60 };
function initialState() {
  const updatedAt = '1970-01-01T00:00:00.000Z';
  return { devices: [
    { id: 'window-1', type: 'WINDOW', name: '창문', state: 'CLOSED', updatedAt, actions: ['OPEN','CLOSE'], stateSource: 'ASSUMED' },
    { id: 'dehumidifier-1', type: 'DEHUMIDIFIER', name: '제습기', state: 'OFF', updatedAt, actions: ['ON','OFF'], stateSource: 'ASSUMED' },
    { id: 'purifier-1', type: 'AIR_PURIFIER', name: '공기청정기', state: 'OFF', updatedAt, actions: ['ON','OFF'], stateSource: 'ASSUMED' },
    { id: 'door-1', type: 'FRONT_DOOR', name: '현관문', state: 'CLOSED', updatedAt, actions: ['CLOSE'], stateSource: 'ASSUMED', autoCloseAt: null },
  ], confirmedDevices: [], edge: { online: false, offlineMode: false, lastSeenAt: '1970-01-01T00:00:00.000Z' },
    offlineSince: null, pendingRecovery: null, recoveryReported: false, recoveries: [], commands: [], idempotency: {}, decisions: [], notifications: [], settings: { ...defaults }, manualUntil: {}, doorOpenedAt: null, legacy: { seen: [], localActions: [], offlineSince: null } };
}
class RoomService extends EventEmitter {
  constructor(store, config, weather) {
    super(); this.store = store; this.config = config; this.weather = weather;
    this.state = initialState(); this.latest = null; this.tail = Promise.resolve(); this.transport = null; this.lastError = null;
  }
  async init() {
    await this.store.init(); this.state = await this.store.load() || this.state; this.latest = await this.store.latest();
    this.state.confirmedDevices = [];
    this.state.idempotency ||= {}; this.state.legacy ||= { seen: [], localActions: [], offlineSince: null };
    if (!this.config.demo && this.config.mqttProtocol === 'edge-agent') this.device('dehumidifier-1').actions = [];
    if (this.state.edge.online) this.state.offlineSince = this.state.edge.lastSeenAt;
    this.state.edge.online = false;
    for (const c of this.state.commands) if (c.status === 'PENDING') {
      c.status = 'FAILED'; c.reason = '서버 재시작으로 실행 결과를 확인하지 못했습니다. 기기 상태를 확인하세요.';
      const decision = this.state.decisions.find(d => d.commandId === c.id); if (decision) decision.status = 'FAILED';
    }
    await this.store.save(this.state);
  }
  run(fn) {
    const next = this.tail.then(async () => {
      const before = structuredClone(this.state), oldLatest = this.latest;
      this.events = []; this.effects = [];
      try {
        const result = await fn();
        this.trim(); await this.store.save(this.state);
        const events = this.events, effects = this.effects;
        this.lastError = null;
        for (const event of events) this.emit('message', event);
        for (const effect of effects) Promise.resolve().then(effect).catch(() => { this.lastError = '장치 명령 전송 오류'; });
        return result === undefined ? undefined : structuredClone(result);
      } catch (error) { this.state = before; this.latest = oldLatest; throw error; }
    });
    this.tail = next.catch(() => {});
    return next;
  }
  trim() {
    for (const name of ['commands', 'decisions', 'notifications']) {
      const active = name === 'commands' ? ['PENDING'] : name === 'decisions' ? ['PROPOSED','APPROVED'] : [];
      const rows = this.state[name];
      this.state[name] = [...rows.filter(r => active.includes(r.status)), ...rows.filter(r => !active.includes(r.status)).slice(-1000)];
    }
    this.state.recoveries = this.state.recoveries.slice(-1000);
    this.state.legacy.seen = this.state.legacy.seen.slice(-10000);
    this.state.legacy.localActions = this.state.legacy.localActions.slice(-1000);
    for (const [key, value] of Object.entries(this.state.idempotency)) if (value.expiresAt < Date.now()) delete this.state.idempotency[key];
  }
  event(type, payload) { this.events.push(payload === undefined ? { type } : { type, payload: structuredClone(payload) }); }
  device(id) { const d = this.state.devices.find(d => d.id === id); if (!d) throw new v.ApiError(404, '기기를 찾을 수 없습니다.'); return d; }
  notify(message, commandId = null) {
    const n = { id: randomUUID(), message, commandId, createdAt: new Date().toISOString(), read: false, pushStatus: this.config.notificationUrl?'PENDING':'DISABLED', pushAttempts: 0 };
    this.state.notifications.push(n); this.event('notification.created', n);
  }
  touch(offlineMode, now = Date.now(), recovering = true) {
    const wasOnline = this.state.edge.online;
    const oldMode = this.state.edge.offlineMode;
    this.state.edge = { online: true, offlineMode: offlineMode ?? oldMode, lastSeenAt: new Date(now).toISOString() };
    if (!wasOnline || oldMode !== this.state.edge.offlineMode) this.event('edge.status', this.state.edge);
    if (!wasOnline && this.state.offlineSince && recovering) {
      this.state.pendingRecovery = { offlineSince: this.state.offlineSince, recoveredAt: new Date(now).toISOString(), dueAt: now + 2000 };
      this.state.offlineSince = null;
    }
  }
  offline(now = Date.now()) {
    if (!this.state.edge.online) return;
    this.state.edge.online = false; this.state.offlineSince = new Date(now).toISOString();
    this.state.pendingRecovery = null; this.state.recoveryReported = false;
    this.state.confirmedDevices = []; this.event('edge.status', this.state.edge);
  }
  async ingest(kind, payload) {
    return this.run(async () => {
      const now = Date.now();
      if (kind === 'sensors') {
        const r = v.reading.parse(payload);
        if (Date.parse(r.measuredAt) > now + 30000 || Date.parse(r.measuredAt) < now - 8 * 86400000) throw new v.ApiError(400, '센서 측정 시각이 허용 범위를 벗어났습니다.');
        await this.store.insert(r);
        this.touch(undefined, now);
        if (!this.latest || r.measuredAt > this.latest.measuredAt) { this.latest = r; this.event('sensor.update', r); }
      } else if (kind === 'status') {
        const s = v.edgeStatus.parse(payload);
        if (s.online) this.touch(s.offlineMode, now);
        else { this.state.edge.offlineMode = s.offlineMode; this.offline(now); }
      } else if (kind === 'devices') {
        const update = v.deviceUpdate.parse(payload); const d = this.device(update.id);
        if (!v.validState(d, update.state) || Date.parse(update.updatedAt) > now + 30000) throw new v.ApiError(400, '올바르지 않은 기기 상태입니다.');
        this.touch(undefined, now);
        this.applyDevice(d, update.state, update.updatedAt);
      } else if (kind === 'ack') {
        const ack = v.ack.parse(payload); const c = this.state.commands.find(c => c.id === ack.commandId);
        if (!c) throw new v.ApiError(400, '알 수 없는 명령입니다.');
        if (ack.executedAt < c.createdAt || Date.parse(ack.executedAt) > now + 30000) throw new v.ApiError(400, '명령 실행 시각 오류');
        this.touch(undefined, now);
        if (ack.status === 'EXECUTED' && ack.executedAt > c.expiresAt) throw new v.ApiError(400, '만료된 명령의 실행 확인입니다. 별도 기기 상태를 보고하세요.');
        if (c.status === 'PENDING') this.finish(c, ack.status, ack.reason, ack.executedAt);
      } else if (kind === 'recovery') {
        const report = v.recovery.parse(payload);
        if (Date.parse(report.recoveredAt) > now + 30000) throw new v.ApiError(400, '복구 시각 오류');
        for (const a of report.localActions) if (!v.validState(this.device(a.deviceId), a.state)) throw new v.ApiError(400, '복구 기기 상태 오류');
        const key = `${report.offlineSince}/${report.recoveredAt}`;
        this.touch(undefined, now, false);
        if (!this.state.recoveries.includes(key)) {
          this.state.recoveries.push(key);
          if (!this.state.recoveryReported) this.event('edge.recovered', report);
          this.state.recoveryReported = true; this.state.pendingRecovery = null;
          this.notify(`엣지 연결이 복구되었습니다. 로컬 동작 ${report.localActions.length}건`);
          // Replay in execution order so an old action cannot overwrite a newer state.
          for (const a of [...report.localActions].sort((a,b) => a.executedAt.localeCompare(b.executedAt))) this.applyDevice(this.device(a.deviceId), a.state, a.executedAt);
        }
        this.state.offlineSince = null;
      } else throw new v.ApiError(400, '지원하지 않는 메시지입니다.');
      this.evaluate(now);
    });
  }
  applyDevice(d, state, at) {
    // Initial device values are placeholders until the first real report after startup.
    const confirmed = this.state.confirmedDevices.includes(d.id);
    if (at < d.updatedAt) return;
    if (!confirmed) this.state.confirmedDevices.push(d.id);
    const wasOpen = d.state === 'OPEN';
    d.state = state; d.updatedAt = at;
    if (d.type === 'FRONT_DOOR') {
      if (state === 'OPEN' && (!wasOpen || !this.state.doorOpenedAt)) this.state.doorOpenedAt = at;
      if (state === 'CLOSED') this.state.doorOpenedAt = null;
      d.stateSource = 'SENSOR';
      d.autoCloseAt = state === 'OPEN' && this.state.settings.enabled && this.state.settings.mode === 'AUTO' ? new Date(Date.parse(this.state.doorOpenedAt) + 600000).toISOString() : null;
    }
    this.event('device.state', d);
  }
  finish(c, status, reason, at = new Date().toISOString()) {
    c.status = status; c.reason = reason; c.completedAt = at;
    if (status === 'EXECUTED') this.applyDevice(this.device(c.deviceId), v.stateFor(c.action), at);
    const decision = this.state.decisions.find(d => d.commandId === c.id);
    if (decision) decision.status = status;
    this.event('command.ack', { commandId: c.id, deviceId: c.deviceId, status, reason, ...(status === 'EXECUTED' ? { device: this.device(c.deviceId) } : {}) });
    this.notify(`${this.device(c.deviceId).name}: ${status === 'EXECUTED' ? '동작 완료' : '동작 실패'} — ${reason}`, c.id);
  }
  command(id, action, source = 'MANUAL', reason = '사용자 원격 조작', now = Date.now()) {
    const device = this.device(id);
    if (!v.validState(device, v.stateFor(action)) || !device.actions?.includes(action)) throw new v.ApiError(400, '이 기기에 사용할 수 없는 명령입니다.');
    if (!this.state.edge.online || now - Date.parse(this.state.edge.lastSeenAt) >= this.config.edgeTimeoutMs || !this.transport?.ready()) throw new v.ApiError(503, '엣지가 오프라인입니다.');
    if (this.state.edge.offlineMode) throw new v.ApiError(409, '엣지가 자체 제어 중입니다. 클라우드 모드 복귀 후 조작하세요.');
    if (this.state.commands.some(c => c.deviceId === id && c.status === 'PENDING')) throw new v.ApiError(409, '이 기기에 처리 중인 명령이 있습니다.');
    const c = { id: randomUUID(), deviceId: id, action, source, reason, status: 'PENDING', createdAt: new Date(now).toISOString(), expiresAt: new Date(now+this.config.commandTimeoutMs).toISOString() };
    this.state.commands.push(c);
    if (source === 'MANUAL') this.state.manualUntil[id] = now + 10 * 60000;
    this.effects.push(async () => {
      try { await this.transport.send({ commandId: c.id, deviceId: id, action, reason, issuedAt: c.createdAt, expiresAt: c.expiresAt }); }
      catch { await this.run(() => { const current = this.state.commands.find(x => x.id === c.id); if (current?.status === 'PENDING') this.finish(current, 'FAILED', '엣지로 명령을 전송하지 못했습니다.'); }); }
    });
    return { commandId: c.id, status: c.status };
  }
  requestCommand(id, body, key) {
    const { action } = v.z.object({ action: v.action }).strict().parse(body);
    if(!this.config.demo&&!key)throw new v.ApiError(400,'실제 장비 명령에는 Idempotency-Key가 필요합니다.');
    if (key !== undefined) v.z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(k => !['__proto__','constructor','prototype'].includes(k), 'Reserved key').parse(key);
    return this.run(() => {
      const saved = key && Object.hasOwn(this.state.idempotency,key) ? this.state.idempotency[key] : undefined;
      if (saved && saved.expiresAt >= Date.now()) {
        if (saved.deviceId !== id || saved.action !== action) throw new v.ApiError(409, '같은 Idempotency-Key를 다른 명령에 사용할 수 없습니다.');
        return saved.response;
      }
      if (key && Object.keys(this.state.idempotency).length >= 10000) throw new v.ApiError(429, '명령 요청 한도를 초과했습니다.');
      const response = this.command(id, action);
      if (key) this.state.idempotency[key] = { deviceId: id, action, response, expiresAt: Date.now() + 86400000 };
      return response;
    });
  }
  updateSettings(body) { const next = v.settings.parse(body); return this.run(() => {
    this.state.settings = next;
    const d = this.device('door-1'); d.autoCloseAt = d.state === 'OPEN' && this.state.doorOpenedAt && next.enabled && next.mode === 'AUTO' ? new Date(Date.parse(this.state.doorOpenedAt)+600000).toISOString() : null;
    this.event('device.state', d); this.evaluate(); return next;
  }); }
  proposals(now) {
    const s = this.state.settings, r = this.latest, items = [];
    const add = (deviceId, action, factor, value, threshold) => items.push({ deviceId, action, reasons: [{ factor, value, threshold }] });
    if (this.state.doorOpenedAt && now - Date.parse(this.state.doorOpenedAt) >= 10 * 60000) add('door-1', 'CLOSE', '현관문 열림', '10분 이상', '10분');
    const fresh = r && now - Date.parse(r.measuredAt) <= 15000;
    if (fresh) {
    if (r.humidity >= s.humidityOn) add('dehumidifier-1', 'ON', '실내 습도', `${r.humidity}%`, `${s.humidityOn}% 이상`);
    else if (r.humidity <= s.humidityOff) add('dehumidifier-1', 'OFF', '실내 습도', `${r.humidity}%`, `${s.humidityOff}% 이하`);
    if (r.pm25 >= s.pm25On) add('purifier-1', 'ON', '실내 초미세먼지', `${r.pm25}µg/m³`, `${s.pm25On} 이상`);
    else if (r.pm25 <= s.pm25On * 0.6) add('purifier-1', 'OFF', '실내 초미세먼지', `${r.pm25}µg/m³`, `${s.pm25On * 0.6} 이하`);
    }
    const weather = this.weather.current().weather.filter(w => Date.parse(w.time) >= now - 3600000 && Date.parse(w.time) <= now + 2 * 3600000);
    if (weather.some(w => w.precipitationProb >= s.rainProbability)) add('window-1', 'CLOSE', '강수확률', `${Math.max(...weather.map(w => w.precipitationProb))}%`, `${s.rainProbability}% 이상`);
    else if (weather.some(w => Number.isFinite(w.pm25) && w.pm25 >= s.pm25On)) add('window-1', 'CLOSE', '실외 초미세먼지', '높음', `${s.pm25On} 이상`);
    else if (fresh && r.co2 >= s.co2Open && weather.length && weather.every(w => Number.isFinite(w.pm25) && w.pm25 < s.pm25On && w.precipitationProb < s.rainProbability)) add('window-1', 'OPEN', '실내 CO₂', `${r.co2}ppm`, `${s.co2Open}ppm 이상`);
    return items;
  }
  evaluate(now = Date.now()) {
    const s = this.state.settings;
    const available = s.enabled && this.state.edge.online && !this.state.edge.offlineMode && now - Date.parse(this.state.edge.lastSeenAt) < this.config.edgeTimeoutMs;
    const proposals = available ? this.proposals(now).filter(p => this.state.confirmedDevices.includes(p.deviceId) && this.device(p.deviceId).actions.includes(p.action) && this.device(p.deviceId).state !== v.stateFor(p.action) && !(this.state.manualUntil[p.deviceId] > now)) : [];
    for (const d of this.state.decisions) if (d.status === 'PROPOSED' && !proposals.some(p => p.deviceId === d.deviceId && p.action === d.action)) d.status = 'EXPIRED';
    for (const p of proposals) {
      if (this.state.commands.some(c => c.deviceId === p.deviceId && (c.status === 'PENDING' || now - Date.parse(c.createdAt) < 60000))) continue;
      if (this.state.decisions.some(d => d.deviceId === p.deviceId && d.action === p.action && (d.status === 'PROPOSED' || d.status === 'APPROVED' || now - Date.parse(d.createdAt) < 60000))) continue;
      const d = { id: randomUUID(), ...p, status: 'PROPOSED', createdAt: new Date(now).toISOString() };
      this.state.decisions.push(d); this.event('decision.proposed', d);
      if (s.mode === 'AUTO' && this.transport?.ready()) {
        const result = this.command(d.deviceId, d.action, 'AUTO', d.reasons.map(r => `${r.factor} ${r.value}`).join(', '), now);
        d.status = 'APPROVED'; d.commandId = result.commandId;
      }
    }
  }
  decide(id, approve) {
    return this.run(() => {
      const d = this.state.decisions.find(d => d.id === id);
      if (!d) throw new v.ApiError(404, '추천을 찾을 수 없습니다.');
      if (d.status !== 'PROPOSED') throw new v.ApiError(409, '이미 처리되었거나 만료된 추천입니다.');
      if (approve) {
        if (!this.state.settings.enabled || !this.proposals(Date.now()).some(p => p.deviceId === d.deviceId && p.action === d.action) || this.state.manualUntil[d.deviceId] > Date.now() || this.device(d.deviceId).state === v.stateFor(d.action)) throw new v.ApiError(409, '현재 환경에 맞지 않는 추천입니다. 새로 조회하세요.');
        const c = this.command(d.deviceId, d.action, 'APPROVED', d.reasons.map(r => `${r.factor} ${r.value}`).join(', '));
        d.status = 'APPROVED'; d.commandId = c.commandId;
      } else d.status = 'REJECTED';
      return d;
    });
  }
  tick(now = Date.now()) {
    return this.run(() => {
      if (this.state.edge.online && now - Date.parse(this.state.edge.lastSeenAt) >= this.config.edgeTimeoutMs) this.offline(now);
      if (this.state.edge.online && this.state.pendingRecovery && this.state.pendingRecovery.dueAt <= now) {
        const { offlineSince, recoveredAt } = this.state.pendingRecovery;
        this.event('edge.recovered', { offlineSince, recoveredAt, localActions: [] });
        this.state.pendingRecovery = null; this.state.recoveryReported = true;
      }
      for (const c of this.state.commands) if (c.status === 'PENDING' && Date.parse(c.expiresAt) <= now) this.finish(c, 'FAILED', `${this.config.commandTimeoutMs/1000}초 내 실행 확인을 받지 못했습니다. 실제 기기 상태를 확인하세요.`);
      this.evaluate(now);
    });
  }
}
module.exports = { RoomService, initialState, defaults };
