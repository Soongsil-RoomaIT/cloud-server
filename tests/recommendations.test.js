const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { PGlite } = require('@electric-sql/pglite');
const { PostgresStore } = require('../src/store');
const { start } = require('../src/server');

const pending = count => ({ items: [], progress: { count, required: 10 } });
const transport = { start: async () => {}, close: async () => {}, ready: () => true, send: async () => {} };
async function fixture(t, store) {
  const runtime = await start({ port: 0, host: '127.0.0.1', demo: true, databaseUrl: '', apiToken: '', store, transport });
  t.after(() => runtime.close());
  const request = async (path = '', method = 'GET') => {
    const res = await fetch(runtime.url + '/api/recommendations' + path, { method });
    return { status: res.status, data: await res.json() };
  };
  return { ...runtime, request };
}

test('confirmed manual evidence creates one recommendation, serves progress and broadcasts the saved object', async t => {
  const { service, url, request } = await fixture(t);
  assert.deepEqual(await request(), { status: 200, data: pending(0) });
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  t.after(() => socket.terminate());
  const events = [];
  socket.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type === 'recommendation.new') events.push(event.payload);
  });
  await once(socket, 'open');
  const id = 'dehumidifier-1';
  async function manual(humidity, offset, status = 'EXECUTED') {
    await service.ingest('devices', { id, state: 'OFF', updatedAt: new Date().toISOString() });
    await service.ingest('sensors', { humidity, measuredAt: new Date(base + offset).toISOString() });
    const { commandId } = await service.requestCommand(id, { action: 'ON' });
    const ack = { commandId, status, executedAt: new Date().toISOString(), reason: '테스트' };
    await service.ingest('ack', ack);
    await service.ingest('ack', ack);
  }
  const base = Date.now() - 1000;
  await manual(null, 0);
  await manual(82, 1, 'FAILED');
  assert.deepEqual((await request()).data, pending(0));
  for (let i = 0; i < 9; i++) await manual(68 + i, 2 + i);
  assert.deepEqual((await request()).data, pending(9));
  await manual(77, 11);
  const [row] = (await request()).data;
  assert.equal(row.metric, 'humidityHigh');
  assert.equal(row.current, 65);
  assert.equal(row.proposed, 72.5);
  assert.equal(row.evidenceCount, 10);
  assert.equal(row.status, 'PROPOSED');
  assert.equal(row.appliedAt, null);
  assert.deepEqual(events, [row]);
  const path = '/' + row.id;
  const responses = await Promise.all([request(path + '/apply','POST'), request(path + '/apply','POST')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(service.state.settings.humidityOn, 72.5);
  assert.equal((await request()).data[0].status, 'APPLIED');
  const reverted = await request(path + '/revert','POST');
  assert.equal(reverted.data.status, 'REVERTED');
  assert.equal(service.state.settings.humidityOn, 65);
  assert.equal((await request(path + '/revert','POST')).status, 409);
});

test('database recommendation history, rejection, stale settings and atomic rollback', async t => {
  const db = new PGlite();
  const store = new PostgresStore('', {
    query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(results => results[0]),
    end: () => db.close(),
  });
  const { service, request } = await fixture(t, store);
  const row = { id: 'rec-1', metric: 'humidityHigh', status: 'PROPOSED', current: 65, proposed: 70,
    evidenceCount: 14, reason: '습도 중앙값', createdAt: '2026-11-18T03:00:00Z', appliedAt: null };
  await store.save(service.state, { record: row, previous: null });
  const stale = { ...row, id: 'rec-2', current: 61, createdAt: '2026-11-18T04:00:00Z' };
  await store.save(service.state, { record: stale, previous: null });
  assert.deepEqual((await request()).data, [stale, row]);
  assert.equal((await request('/missing/apply', 'POST')).status, 404);
  assert.equal((await request('/rec-2/apply', 'POST')).status, 409);
  assert.equal((await request('/rec-2/reject', 'POST')).data.status, 'REJECTED');
  assert.equal((await request('/rec-2/apply', 'POST')).status, 409);
  await db.exec("ALTER TABLE room_state ADD CONSTRAINT test_limit CHECK ((payload->'settings'->>'humidityOn')::numeric <> 70)");
  assert.equal((await request('/rec-1/apply', 'POST')).status, 500);
  assert.equal(service.state.settings.humidityOn, 65);
  assert.equal((await request()).data[1].status, 'PROPOSED');
  await db.exec('ALTER TABLE room_state DROP CONSTRAINT test_limit');
  const applied = await request('/rec-1/apply', 'POST');
  assert.equal(applied.data.status, 'APPLIED');
  assert.ok(applied.data.appliedAt);
  assert.equal((await store.load()).settings.humidityOn, 70);
  assert.equal((await service.automation()).rules.find(rule => rule.id === 'humidityHigh').threshold, 70);
  await service.updateSettings({ ...service.state.settings, humidityOn: 73 });
  assert.equal((await request('/rec-1/revert', 'POST')).status, 409);
  assert.equal((await store.load()).settings.humidityOn, 73);
});
