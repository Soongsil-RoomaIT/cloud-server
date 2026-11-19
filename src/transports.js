const mqtt = require('mqtt');
const { handleLegacy, commandForEdge, doorScheduleType } = require('./edge-agent-adapter');

class DemoTransport {
  constructor(service) { this.service = service; this.connected = false; this.paused = false; this.timers = new Set(); }
  ready() { return this.connected && !this.paused; }
  async start() {
    this.connected = true;
    await this.service.ingest('status', { online: true, offlineMode: false });
    for (const device of this.service.state.devices) {
      const state = ['WINDOW', 'FRONT_DOOR'].includes(device.type) ? 'CLOSED' : 'OFF';
      const stateSource = device.type === 'FRONT_DOOR' ? 'SENSOR' : 'COMMANDED';
      await this.service.ingest('devices', { id: device.id, state, stateSource, updatedAt: new Date().toISOString() });
    }
    if (!this.service.config.databaseUrl && !(await this.service.store.latest())) {
      const now = Date.now();
      for (let i = 359; i >= 1; i--) {
        await this.service.store.insert({ measuredAt: new Date(now-i*60000).toISOString(), temperature: 23+Math.sin(i/20), humidity: 58+Math.sin(i/15)*5, co2: 850+Math.sin(i/12)*100, pm25: 18+Math.sin(i/8)*3, pm10: 30+Math.sin(i/8)*5 });
      }
    }
    await this.sample();
    this.interval = setInterval(() => this.sample().catch(() => { this.service.lastError = '데모 센서 수신 실패'; }), 5000);
  }
  async sample() {
    if (!this.ready()) return;
    const n = Date.now() / 30000;
    await this.service.ingest('sensors', { measuredAt: new Date().toISOString(), temperature: +(23+Math.sin(n)).toFixed(1), humidity: +(58+Math.sin(n/2)*5).toFixed(1), co2: Math.round(850+Math.sin(n)*100), pm25: Math.round(18+Math.sin(n)*3), pm10: Math.round(30+Math.sin(n)*5) });
  }
  async send(c) {
    if (!this.ready()) throw new Error('Demo edge offline');
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.ready() || Date.now() > Date.parse(c.expiresAt)) return;
      this.service.ingest('ack', { commandId: c.commandId, status: 'EXECUTED', reason: '가상 장비 실행 완료', executedAt: new Date().toISOString() }).catch(() => { this.service.lastError = '데모 실행 확인 실패'; });
    }, 150);
    this.timers.add(timer);
  }
  async close() { this.connected = false; clearInterval(this.interval); for (const timer of this.timers) clearTimeout(timer); }
}
class MqttTransport {
  constructor(service, config) { this.service = service; this.config = config; this.client = null; this.subscribed = false; this.rejectedMessages = 0; }
  ready() { return Boolean(this.client?.connected && this.subscribed); }
  start() {
    const c = this.config;
    this.client = mqtt.connect(c.mqttUrl, { username: c.mqttUsername || undefined, password: c.mqttPassword || undefined,
      clientId: `roomait-cloud-${process.pid}`, reconnectPeriod: 2000, connectTimeout: 5000, clean: true, queueQoSZero: false });
    this.client.on('connect', () => {
      const suffixes=c.mqttProtocol==='edge-agent'?['telemetry','events','status']:['sensors','devices','status','ack','recovery','events'];
      this.client.subscribe(suffixes.map(s => `${c.mqttPrefix}/${s}`), { qos: 1 }, (error, granted) => {
        this.subscribed = !error && granted?.every(g => g.qos !== 128);
        if (!this.subscribed) this.service.lastError = 'MQTT 구독 실패';
      });
    });
    this.client.on('message', (topic, raw, packet) => {
      if (raw.length > 128 * 1024) { this.rejectedMessages++; return; }
      const kind = topic.slice(c.mqttPrefix.length+1);
      let payload;
      try { payload = c.mqttProtocol==='edge-agent'&&kind==='status'?raw.toString():JSON.parse(raw.toString()); } catch { this.rejectedMessages++; return; }
      if(c.mqttProtocol==='edge-agent') {
        handleLegacy(this.service,kind,payload,packet).catch(()=>{this.rejectedMessages++;});return;
      }
      if (kind === 'events') {
        if (payload?.type === doorScheduleType) {
          handleLegacy(this.service, kind, payload, packet).catch(() => { this.rejectedMessages++; });
        }
        return;
      }
      if (packet.retain && !(kind === 'status' && payload?.online === false)) return;
      this.service.ingest(kind, payload).catch(() => { this.rejectedMessages++; });
    });
    const lost = () => { this.subscribed = false; this.service.run(() => this.service.offline()).catch(() => { this.service.lastError = '연결 단절 상태 저장 실패'; }); };
    this.client.on('offline', lost); this.client.on('close', lost);
    this.client.on('error', () => { this.service.lastError = 'MQTT 연결 오류'; });
  }
  async send(command) {
    if (!this.ready()) throw new Error('MQTT offline');
    const legacy=this.config.mqttProtocol==='edge-agent';
    // Existing edge has no persistent deduplication: QoS 0 avoids MQTT's at-least-once replay.
    // There is no automatic retry; the cloud reports a timeout if delivery is lost.
    await new Promise((resolve, reject) => this.client.publish(`${this.config.mqttPrefix}/${legacy?'command':'commands'}`, JSON.stringify(legacy?commandForEdge(command):command), { qos: legacy?0:1, retain: false }, error => error ? reject(error) : resolve()));
  }
  async close() { if (this.client) await this.client.endAsync(true); }
}
module.exports = { DemoTransport, MqttTransport };
