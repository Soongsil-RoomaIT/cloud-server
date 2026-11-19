const {test}=require('node:test');
const { once } = require('node:events');
const express = require('express');
const { config: readConfig } = require('../src/config');
const assert=require('node:assert/strict');
const {createAuthenticator}=require('../src/auth');
const {NotificationBridge}=require('../src/notification-bridge');
const {RoomService}=require('../src/service');
const {MemoryStore}=require('../src/store');
const {start}=require('../src/server');
const {WebSocket}=require('ws');

test('Keycloak-compatible JWT verifies RS256/issuer/audience/expiry and room ownership',async()=>{
 const {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT}=await import('jose');
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test';
 const config={jwtIssuer:'http://keycloak.test/realms/room-care',jwtAudience:'room-care-api',allowedSubjects:['room-owner']};
 const auth=await createAuthenticator(config,createLocalJWKSet({keys:[jwk]}));
 const token=async(sub,aud='room-care-api',expiry='5m')=>new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(config.jwtIssuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
 assert.equal((await auth.verify(await token('room-owner'))).sub,'room-owner');
 await assert.rejects(auth.verify(await token('other-user')),{status:403});
 await assert.rejects(auth.verify(await token('room-owner','wrong')),{status:401});
 await assert.rejects(auth.verify(await token('room-owner','room-care-api','-1s')),{status:401});
 await assert.rejects(auth.verify('invalid'),{status:401});
});
test('gateway upstream WS Authorization header authenticates without a second auth frame',async t=>{
 const runtime=await start({port:0,demo:true,apiToken:'gateway-test-token',databaseUrl:''});t.after(()=>runtime.close());
 const socket=new WebSocket(runtime.url.replace('http:','ws:')+'/ws',{headers:{Authorization:'Bearer gateway-test-token'}});t.after(()=>socket.terminate());
 const message=await new Promise((resolve,reject)=>{socket.once('message',raw=>resolve(JSON.parse(raw)));socket.once('error',reject);});
 assert.equal(message.type,'edge.status');assert.equal(message.payload.online,true);
});
test('Gateway internal API receives the shared key and stable event ID, and returns its delivery status', async t => {
  const key = 'test-only';
  const app = express();
  app.use(express.json());
  const received = [];
  app.post('/internal/notifications', (req, res) => {
    if (req.get('x-internal-key') !== key) return res.sendStatus(401);
    received.push({ body: req.body, authorization: req.get('authorization') });
    res.json({ status: 'dry-run', targetCount: 0, successCount: 0 });
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/internal/notifications`;
  const env = { DEMO_MODE: 'false', DATABASE_URL: 'db', MQTT_URL: 'mqtt://test', GATEWAY_INTERNAL_NOTIFICATIONS_URL: url };
  assert.throws(() => readConfig(env), /INTERNAL_API_KEY/);
  assert.throws(() => readConfig({ ...env, INTERNAL_API_KEY: key, GATEWAY_INTERNAL_NOTIFICATIONS_URL: 'file:///invalid' }), /GATEWAY_INTERNAL_NOTIFICATIONS_URL/);
  const config = readConfig({ ...env, INTERNAL_API_KEY: key });
  const s = new RoomService(new MemoryStore(), config, { current: () => ({ weather: [] }) });
  await s.init();
  await s.run(() => {
    s.notify('창문이 닫혔습니다.', { title: '창문 닫기', type: 'device.command', commandId: 'cmd-1', data: { source: 'AUTO' } });
  });
  const bridge = new NotificationBridge(s, config);
  await bridge.flush();
  await bridge.flush();
  const entry = s.state.notifications[0];
  assert.deepEqual(received, [{
    body: {
      eventId: entry.id, title: '창문 닫기', body: '창문이 닫혔습니다.',
      data: { type: 'device.command', commandId: 'cmd-1', source: 'AUTO' },
    },
    authorization: undefined,
  }]);
  assert.equal(entry.pushStatus, 'DRY-RUN');
  assert.deepEqual(entry.pushResult, { status: 'dry-run', targetCount: 0, successCount: 0 });
});
test('notification outages retry with same ID and stop after three attempts',async()=>{
 const config = { notificationUrl: 'http://gateway.test/internal/notifications', notificationKey: 'test-only' };
 const s = new RoomService(new MemoryStore(), config, { current: () => ({ weather: [] }) });
 await s.init();
 await s.run(() => s.notify('알림'));
 const eventIds = [];
 const bridge = new NotificationBridge(s, config, async (_url, request) => {
   eventIds.push(JSON.parse(request.body).eventId);
   throw new Error('offline');
 });
 for (let i = 0; i < 3; i++) {
   await bridge.flush();
   await s.run(() => { s.state.notifications[0].nextAttemptAt = 0; });
 }
 await bridge.flush();
 const notification = s.state.notifications[0];
 assert.deepEqual(eventIds, Array(3).fill(notification.id));
 assert.equal(notification.pushStatus, 'FAILED');
 assert.equal(notification.pushAttempts, 3);
});

test('notification bridge skips uncommitted rows and sends nothing after rollback', async () => {
  const config = { notificationUrl: 'http://gateway.test/internal/notifications', notificationKey: 'test-only' };
  const store = new MemoryStore();
  const s = new RoomService(store, config, { current: () => ({ weather: [] }) });
  await s.init();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  store.save = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('storage failure');
  };
  let calls = 0;
  const bridge = new NotificationBridge(s, config, async () => { calls++; });
  const transaction = assert.rejects(s.run(() => s.notify('롤백 대상')), /storage failure/);
  await entered.promise;
  try {
    await bridge.flush();
  } finally {
    release.resolve();
  }
  await transaction;
  assert.equal(calls, 0);
  assert.deepEqual(s.state.notifications, []);
});
