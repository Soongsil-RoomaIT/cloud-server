const http = require('node:http');
const { config: readConfig } = require('./config');
const { MemoryStore, PostgresStore } = require('./store');
const { WeatherService } = require('./weather');
const { RoomService } = require('./service');
const { DemoTransport, MqttTransport } = require('./transports');
const { createApp } = require('./app');
const { attachRealtime } = require('./realtime');
const {createAuthenticator}=require('./auth');
const {NotificationBridge}=require('./notification-bridge');

async function start(overrides = {}) {
  const config = { ...readConfig(), ...overrides };
  const store = overrides.store || (config.databaseUrl ? new PostgresStore(config.databaseUrl) : new MemoryStore());
  const weather = new WeatherService(config);
  const service = new RoomService(store, config, weather);
  service.auth=overrides.auth || await createAuthenticator(config);
  await service.init(); await weather.refresh();
  const app = createApp(service, config), server = http.createServer(app);
  const realtime = attachRealtime(server, service, config);
  const transport = overrides.transport || (config.demo ? new DemoTransport(service) : new MqttTransport(service, config));
  service.transport = transport;
  const notifications=new NotificationBridge(service,config);
  let tick, weatherTimer, notificationTimer;
  const close = async () => {
    clearInterval(tick); clearInterval(weatherTimer); clearInterval(notificationTimer);
    await transport.close(); await realtime.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    while(notifications.running)await new Promise(r=>setTimeout(r,25));
    await service.tail; await store.close();
  };
  try {
    await transport.start();
    let ticking = false, refreshing = false;
    tick = setInterval(async () => { if (ticking) return; ticking = true; try { await service.tick(); } catch { service.lastError = '상태 저장 또는 자동화 처리 오류'; } finally { ticking = false; } }, 500);
    weatherTimer = setInterval(async () => { if (refreshing) return; refreshing = true; try { await weather.refresh(); } finally { refreshing = false; } }, 10 * 60000);
    if(config.notificationUrl && !config.demo)notificationTimer=setInterval(()=>notifications.flush().catch(()=>{service.lastError='알림 결과 저장 실패';}),1000);
    await new Promise((resolve,reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    return { app, server, service, config, close, url: `http://${config.host}:${server.address().port}` };
  } catch (error) { await close(); throw error; }
}
if (require.main === module) {
  start().then(runtime => {
    console.log(`CloudAIoT ${runtime.config.demo ? 'DEMO (가상 장비)' : 'LIVE'}: ${runtime.url}`);
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; await runtime.close(); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  }).catch(error => { console.error(`서버를 시작하지 못했습니다: ${error.code || error.message}`); process.exitCode = 1; });
}
module.exports = { start };
