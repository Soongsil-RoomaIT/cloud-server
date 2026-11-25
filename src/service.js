const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const v = require('./validation');
const { ruleKeys, ruleEnabled, metadata, automationView, automationUpdate } = require('./automation');

const defaults = { enabled: false, mode: 'APPROVAL', humidityOn: 70, humidityOff: 60, co2Open: 1000, pm25On: 35, rainProbability: 60 };
const additionalThresholds = { temperatureHigh: 30, pm10Bad: 80 };
function initialState() {
  const updatedAt = new Date().toISOString();
  return { devices: [
    { id: 'window-1', type: 'WINDOW', name: '창문', state: 'UNKNOWN', updatedAt, actions: ['OPEN','CLOSE'], stateSource: 'ASSUMED' },
    { id: 'dehumidifier-1', type: 'DEHUMIDIFIER', name: '제습기', state: 'UNKNOWN', updatedAt, actions: ['ON','OFF'], stateSource: 'ASSUMED' },
    { id: 'purifier-1', type: 'AIR_PURIFIER', name: '공기청정기', state: 'UNKNOWN', updatedAt, actions: ['ON','OFF'], stateSource: 'ASSUMED' },
    { id: 'door-1', type: 'FRONT_DOOR', name: '현관문', state: 'UNKNOWN', updatedAt, actions: ['CLOSE'], stateSource: 'ASSUMED', autoCloseAt: null },
  ], confirmedDevices: [], edge: { online: false, offlineMode: false, lastSeenAt: '1970-01-01T00:00:00.000Z' },
    offlineSince: null, pendingRecovery: null, recoveryReported: false, recoveries: [], commands: [], idempotency: {}, decisions: [], notifications: [], settings: { ...defaults, ...additionalThresholds }, automationMeta: metadata(), manualUntil: {}, doorOpenedAt: null, legacy: { seen: [], localActions: [], offlineSince: null } };
}
class RoomService extends EventEmitter {
  constructor(store, config, weather) {
    super(); this.store = store; this.config = config; this.weather = weather;
    this.state = initialState(); this.latest = null; this.tail = Promise.resolve(); this.transport = null; this.lastError = null;
  }
  async init() {
    await this.store.init(); this.state = await this.store.load() || this.state; this.latest = await this.store.latest();
    this.state.settings = { ...defaults, ...additionalThresholds, ...this.state.settings };
    const storedMeta = this.state.automationMeta ?? {};
    this.state.automationMeta = { ...metadata(), ...storedMeta };
    if (this.latest) this.updateGasState(this.latest.gasDetected, this.latest.measuredAt);
    this.state.appliedThresholds ??= {};
    this.state.confirmedDevices = [];
    const startedAt = new Date().toISOString();
    for (const device of this.state.devices) {
      if (device.state === 'UNKNOWN' || !Number.isFinite(Date.parse(device.updatedAt)) || Date.parse(device.updatedAt) <= 0) {
        device.state = 'UNKNOWN';
        device.stateSource = 'ASSUMED';
        device.updatedAt = startedAt;
      }
    }
    this.state.doorSchedule = null;
    this.device('door-1').autoCloseAt = null;
    this.state.idempotency ||= {}; this.state.legacy ||= { seen: [], localActions: [], offlineSince: null };
    if (!this.config.demo && this.config.mqttProtocol === 'edge-agent') this.device('dehumidifier-1').actions = [];
    if (this.state.edge.online) {
      this.state.offlineSince = this.state.edge.lastSeenAt;
      this.state.recoveryReported = false;
    }
    this.state.edge.online = false;
    for (const c of this.state.commands) if (c.status === 'PENDING') {
      c.status = 'FAILED'; c.reason = '서버 재시작으로 실행 결과를 확인하지 못했습니다. 기기 상태를 확인하세요.';
      const decision = this.state.decisions.find(d => d.commandId === c.id); if (decision) decision.status = 'FAILED';
    }
    await this.store.save(this.state);
  }
  async forecast() {
    return (await this.store.latestForecast()) ?? {
      metrics: [], message: '1시간 뒤 실내 습도와 온도를 예측하는 모델을 준비하고 있습니다.',
    };
  }
  run(fn) {
    const next = this.tail.then(async () => {
      const before = structuredClone(this.state), oldLatest = this.latest;
      this.events = []; this.effects = []; this.recommendationChange = null;
      try {
        const result = await fn();
        this.trim(); await this.store.save(this.state, this.recommendationChange);
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
    for (const name of ['commands', 'decisions']) {
      const active = name === 'commands' ? ['PENDING'] : ['PROPOSED','APPROVED'];
      const rows = this.state[name];
      this.state[name] = [...rows.filter(r => active.includes(r.status)), ...rows.filter(r => !active.includes(r.status)).slice(-1000)];
    }
    const notifications = this.state.notifications;
    const recent = new Set(notifications.filter(row => row.pushStatus !== 'PENDING').slice(-1000));
    this.state.notifications = notifications.filter(row => row.pushStatus === 'PENDING' || recent.has(row));
    this.state.recoveries = this.state.recoveries.slice(-1000);
    this.state.legacy.seen = this.state.legacy.seen.slice(-10000);
    this.state.legacy.localActions = this.state.legacy.localActions.slice(-1000);
    for (const [key, value] of Object.entries(this.state.idempotency)) if (value.expiresAt < Date.now()) delete this.state.idempotency[key];
  }
  event(type, payload) { this.events.push(payload === undefined ? { type } : { type, payload: structuredClone(payload) }); }
  device(id) { const d = this.state.devices.find(d => d.id === id); if (!d) throw new v.ApiError(404, '기기를 찾을 수 없습니다.'); return d; }
  notify(message, { title = '자취방 원격 케어', type = 'room.notification', commandId = null, data = {} } = {}) {
    const notification = {
      id: randomUUID(), title, message, commandId, createdAt: new Date().toISOString(), read: false,
      data: { ...data, type, ...(commandId ? { commandId } : {}) },
      pushStatus: this.config.notificationUrl && !this.config.demo ? 'PENDING' : 'DISABLED',
      pushAttempts: 0,
    };
    this.state.notifications.push(notification);
    this.event('notification.created', notification);
  }
  reportRecovery(report, message = null) {
    if (!this.state.recoveryReported) {
      this.event('edge.recovered', report);
      this.notify(message ?? `엣지 연결이 복구되었습니다. 로컬 동작 ${report.localActions.length}건`, {
        title: '엣지 연결 복구', type: 'edge.recovered',
        data: { offlineSince: report.offlineSince, recoveredAt: report.recoveredAt, localActionCount: String(report.localActions.length) },
      });
    }
    this.state.recoveryReported = true;
    this.state.pendingRecovery = null;
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
    this.state.confirmedDevices = [];
    this.state.doorSchedule = null;
    const door = this.device('door-1');
    if (door.autoCloseAt !== null) {
      door.autoCloseAt = null;
      this.event('device.state', door);
    }
    this.event('edge.status', this.state.edge);
  }
  async ingest(kind, payload) {
    return this.run(async () => {
      const now = Date.now();
      if (kind === 'sensors') {
        const r = v.reading.parse(payload);
        if (Date.parse(r.measuredAt) > now + 30000 || Date.parse(r.measuredAt) < now - 8 * 86400000) throw new v.ApiError(400, '센서 측정 시각이 허용 범위를 벗어났습니다.');
        await this.store.insert(r);
        this.touch(undefined, now);
        this.updateLatest(r);
      } else if (kind === 'status') {
        const s = v.edgeStatus.parse(payload);
        if (s.online) this.touch(s.offlineMode, now);
        else { this.state.edge.offlineMode = s.offlineMode; this.offline(now); }
      } else if (kind === 'devices') {
        const update = v.deviceUpdate.parse(payload); const d = this.device(update.id);
        if (!v.validState(d, update.state) || Date.parse(update.updatedAt) > now + 30000 ||
            (update.autoCloseAt !== undefined && d.type !== 'FRONT_DOOR')) {
          throw new v.ApiError(400, '올바르지 않은 기기 상태입니다.');
        }
        this.touch(undefined, now);
        this.applyDevice(d, update.state, update.updatedAt, update);
      } else if (kind === 'ack') {
        const ack = v.ack.parse(payload); const c = this.state.commands.find(c => c.id === ack.commandId);
        if (!c) throw new v.ApiError(400, '알 수 없는 명령입니다.');
        if (ack.executedAt < c.createdAt || Date.parse(ack.executedAt) > now + 30000) throw new v.ApiError(400, '명령 실행 시각 오류');
        this.touch(undefined, now);
        if (ack.status === 'EXECUTED' && ack.executedAt > c.expiresAt) throw new v.ApiError(400, '만료된 명령의 실행 확인입니다. 별도 기기 상태를 보고하세요.');
        if (c.status === 'PENDING') this.finish(c, ack.status, ack.reason, ack.executedAt, ack.stateSource);
      } else if (kind === 'recovery') {
        const report = v.recovery.parse(payload);
        if (Date.parse(report.recoveredAt) > now + 30000) throw new v.ApiError(400, '복구 시각 오류');
        for (const a of report.localActions) if (!v.validState(this.device(a.deviceId), a.state)) throw new v.ApiError(400, '복구 기기 상태 오류');
        const key = `${report.offlineSince}/${report.recoveredAt}`;
        this.touch(undefined, now, false);
        if (!this.state.recoveries.includes(key)) {
          this.state.recoveries.push(key);
          this.reportRecovery(report);
          // Replay in execution order so an old action cannot overwrite a newer state.
          for (const a of [...report.localActions].sort((a,b) => a.executedAt.localeCompare(b.executedAt))) this.applyDevice(this.device(a.deviceId), a.state, a.executedAt);
        }
        this.state.offlineSince = null;
      } else throw new v.ApiError(400, '지원하지 않는 메시지입니다.');
      this.evaluate(now);
    });
  }
  updateLatest(reading) {
    if (this.latest && reading.measuredAt <= this.latest.measuredAt) return;
    this.latest = reading;
    this.updateGasState(reading.gasDetected, reading.measuredAt);
    this.event('sensor.update', reading);
  }
  updateGasState(detected, at) {
    // Warm-up or a broken sensor cannot clear a confirmed detection.
    if (typeof detected !== 'boolean') return;
    const previous = this.state.gasState;
    if (!previous || at > previous.at || (at === previous.at && detected)) this.state.gasState = { detected, at };
  }
  reportGasEvent(detected, at) {
    this.updateGasState(detected, at);
    const title = detected ? '유해가스 감지' : '유해가스 감지 해제';
    this.notify(detected ? '엣지가 유해가스 감지를 보고했습니다.' : '엣지가 유해가스 감지 해제를 보고했습니다.', {
      title, type: detected ? 'gas.detected' : 'gas.cleared', data: { deviceId: 'window-1' },
    });
  }
  gasBlocksClose(id, action) {
    return id === 'window-1' && action === 'CLOSE' && this.state.gasState?.detected === true;
  }
  applyDevice(device, state, at, { stateSource, autoCloseAt } = {}) {
    if (device.state !== 'UNKNOWN' && at < device.updatedAt) return;
    if (!this.state.confirmedDevices.includes(device.id)) this.state.confirmedDevices.push(device.id);
    const wasOpen = device.state === 'OPEN';
    device.state = state;
    device.updatedAt = at;
    if (device.type === 'WINDOW' && state === 'CLOSED') this.state.ventilationOpenedAt = null;
    const defaultSource = { FRONT_DOOR: 'SENSOR', WINDOW: 'COMMANDED' }[device.type] ??
      (this.config.mqttProtocol === 'roomait-v1' ? 'COMMANDED' : 'ASSUMED');
    device.stateSource = stateSource ?? defaultSource;
    if (device.type === 'FRONT_DOOR') {
      const schedule = this.state.doorSchedule;
      if (state === 'OPEN') {
        if (!wasOpen || !this.state.doorOpenedAt) this.state.doorOpenedAt = at;
        // A delayed OPEN snapshot can precede a schedule report already received.
        if (autoCloseAt !== undefined && (!schedule || at >= schedule.reportedAt)) {
          this.state.doorSchedule = { reportedAt: at, autoCloseAt };
        }
      } else {
        this.state.doorOpenedAt = null;
        if (schedule && at >= schedule.reportedAt) this.state.doorSchedule = null;
      }
      device.autoCloseAt = state === 'OPEN' ? this.state.doorSchedule?.autoCloseAt ?? null : null;
    }
    this.event('device.state', device);
  }
  reportDoorSchedule(reportedAt, autoCloseAt) {
    const door = this.device('door-1');
    const previous = this.state.doorSchedule;
    if ((previous && reportedAt < previous.reportedAt) ||
        (door.state === 'CLOSED' && reportedAt <= door.updatedAt) ||
        (door.state === 'OPEN' && reportedAt < this.state.doorOpenedAt)) return;
    this.state.doorSchedule = { reportedAt, autoCloseAt };
    if (door.state === 'OPEN' && door.autoCloseAt !== autoCloseAt) {
      door.autoCloseAt = autoCloseAt;
      this.event('device.state', door);
    }
  }
  finish(c, status, reason, at = new Date().toISOString(), stateSource) {
    c.status = status; c.reason = reason; c.completedAt = at;
    const device = this.device(c.deviceId);
    if (status === 'EXECUTED') {
      const source = stateSource ?? (device.state !== 'UNKNOWN' ? device.stateSource : undefined);
      this.applyDevice(device, v.stateFor(c.action), at, { stateSource: source });
      if (device.id === 'window-1' && c.action === 'OPEN' && ['AUTO', 'APPROVED'].includes(c.source) &&
          device.state === 'OPEN' && device.updatedAt === at) {
        this.state.ventilationOpenedAt = at;
      }
    }
    const decision = this.state.decisions.find(d => d.commandId === c.id);
    if (decision) decision.status = status;
    this.event('command.ack', { commandId: c.id, deviceId: c.deviceId, status, reason, ...(status === 'EXECUTED' ? { device: this.device(c.deviceId) } : {}) });
    const title = `${device.name} ${status === 'EXECUTED' ? '동작 완료' : '동작 실패'}`;
    this.notify(`${device.name}: ${status === 'EXECUTED' ? '동작 완료' : '동작 실패'} — ${reason}`, {
      title, type: c.source === 'PREDICTION' ? 'prediction.command' : 'device.command', commandId: c.id,
      data: { deviceId: c.deviceId, action: c.action, source: c.source, status },
    });
  }
  command(id, action, source = 'MANUAL', reason = '사용자 원격 조작', now = Date.now()) {
    const device = this.device(id);
    if (!v.validState(device, v.stateFor(action)) || !device.actions?.includes(action)) throw new v.ApiError(400, '이 기기에 사용할 수 없는 명령입니다.');
    if (this.gasBlocksClose(id, action)) throw new v.ApiError(409, '유해가스 감지 중에는 창문을 닫을 수 없습니다.');
    if (!this.state.edge.online || now - Date.parse(this.state.edge.lastSeenAt) >= this.config.edgeTimeoutMs || !this.transport?.ready()) throw new v.ApiError(503, '엣지가 오프라인입니다.');
    if (this.state.edge.offlineMode) throw new v.ApiError(409, '엣지가 자체 제어 중입니다. 클라우드 모드 복귀 후 조작하세요.');
    if (this.state.commands.some(c => c.deviceId === id && c.status === 'PENDING')) throw new v.ApiError(409, '이 기기에 처리 중인 명령이 있습니다.');
    const c = { id: randomUUID(), deviceId: id, action, source, reason, status: 'PENDING', createdAt: new Date(now).toISOString(), expiresAt: new Date(now+this.config.commandTimeoutMs).toISOString() };
    this.state.commands.push(c);
    if (source === 'MANUAL') this.state.manualUntil[id] = now + 10 * 60000;
    this.effects.push(async () => {
      if (this.gasBlocksClose(id, action)) {
        await this.run(() => {
          const current = this.state.commands.find(x => x.id === c.id);
          if (current?.status === 'PENDING') this.finish(current, 'FAILED', '유해가스 감지 중 창문 닫기 취소');
        });
        return;
      }
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
  async automation() {
    await this.tail;
    return automationView(this.state);
  }
  updateAutomation(body) {
    return this.run(() => {
      const update = automationUpdate(this.state, body);
      this.state.automationMeta = update.automationMeta;
      this.applySettings(update.settings);
      return body;
    });
  }
  legacySettings() {
    const { temperatureHigh, pm10Bad, ...settings } = this.state.settings;
    return settings;
  }
  updateSettings(body) {
    const update = v.settings.parse(body);
    return this.run(() => {
      this.applySettings({ ...this.state.settings, ...update });
      return this.legacySettings();
    });
  }
  applySettings(next) {
    for (const [metric, key] of Object.entries(ruleKeys)) {
      if (this.state.settings[key] !== next[key]) this.state.appliedThresholds[metric] = [];
    }
    this.state.settings = next;
    this.evaluate();
  }
  proposals(now) {
    const s = this.state.settings;
    const age = this.latest ? now - Date.parse(this.latest.measuredAt) : Infinity;
    const indoor = age >= -30000 && age <= 15000 ? this.latest : {};
    const items = [];
    const add = (deviceId, action, factor, value, threshold) => items.push({ deviceId, action, reasons: [{ factor, value, threshold }] });
    const active = id => ruleEnabled(this.state, id);
    const highHumidity = active('humidityHigh') && Number.isFinite(indoor.humidity) && indoor.humidity > s.humidityOn;
    const highTemperature = active('temperatureHigh') && Number.isFinite(indoor.temperature) && indoor.temperature > s.temperatureHigh;
    const cloudControlsWindow = this.state.gasState?.detected !== true;

    if (active('humidityLow') && Number.isFinite(indoor.humidity) && indoor.humidity < s.humidityOff) {
      add('dehumidifier-1', 'OFF', '실내 습도', `${indoor.humidity}%`, `${s.humidityOff}% 미만`);
    }

    const air = this.weather.airQuality?.(now);
    const dust = [
      { id: 'pm25Bad', value: air?.pm25, limit: s.pm25On, name: '외기 PM2.5' },
      { id: 'pm10Bad', value: air?.pm10, limit: s.pm10Bad, name: '외기 PM10' },
    ].filter(rule => active(rule.id));
    const badAir = dust.find(rule => Number.isFinite(rule.value) && rule.value > rule.limit);
    if (badAir) {
      const value = `${badAir.value}µg/m³`, limit = `${badAir.limit}µg/m³ 초과`;
      if (cloudControlsWindow) add('window-1', 'CLOSE', badAir.name, value, limit);
      add('purifier-1', 'ON', badAir.name, value, limit);
    }

    const hour = 60 * 60000;
    const currentHour = Math.floor(now / hour) * hour;
    const forecast = this.weather.current().weather.filter(row =>
      Date.parse(row.time) >= currentHour && Date.parse(row.time) <= now + 2 * hour);
    const outsideHumidity = forecast.find(row => Date.parse(row.time) <= now)?.humidity;
    const humidityKnown = Number.isFinite(outsideHumidity) && Number.isFinite(indoor.humidity);
    const wetterOutside = humidityKnown && outsideHumidity >= indoor.humidity;
    const rain = forecast.filter(row => Number.isFinite(row.precipitationProb));
    const rainy = active('rainProbability') && rain.some(row => row.precipitationProb >= s.rainProbability);
    const rainHours = new Set(rain.map(row => Math.floor(Date.parse(row.time) / hour) * hour));
    const clearRain = !active('rainProbability') ||
      (!rainy && [currentHour, currentHour + hour, currentHour + 2 * hour].every(at => rainHours.has(at)));
    const clearAir = dust.length > 0 && dust.every(rule => Number.isFinite(rule.value) && rule.value <= rule.limit);

    if ((highHumidity || highTemperature) && clearAir && clearRain && humidityKnown && !wetterOutside) {
      const factor = highHumidity ? '실내 습도' : '실내 온도';
      const value = highHumidity ? `${indoor.humidity}%` : `${indoor.temperature}°C`;
      const limit = highHumidity ? `${s.humidityOn}% 초과` : `${s.temperatureHigh}°C 초과`;
      if (cloudControlsWindow) add('window-1', 'OPEN', factor, value, limit);
    } else if (highHumidity && (badAir || rainy || wetterOutside)) {
      const factor = '환기 제한: ' + (badAir ? badAir.name : rainy ? '비 예보' : '높은 외기 습도');
      const value = `실내 습도 ${indoor.humidity}%`, limit = `${s.humidityOn}% 초과`;
      const openedAt = Date.parse(this.state.ventilationOpenedAt);
      if (cloudControlsWindow && !badAir && !(now - openedAt < 30 * 60000)) {
        add('window-1', 'CLOSE', factor, value, limit);
      }
      add('dehumidifier-1', 'ON', factor, value, limit);
    }
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
        this.reportRecovery({ offlineSince, recoveredAt, localActions: [] });
      }
      for (const c of this.state.commands) if (c.status === 'PENDING' && Date.parse(c.expiresAt) <= now) this.finish(c, 'FAILED', `${this.config.commandTimeoutMs/1000}초 내 실행 확인을 받지 못했습니다. 실제 기기 상태를 확인하세요.`);
      this.evaluate(now);
    });
  }
}
module.exports = { RoomService, initialState, defaults };
