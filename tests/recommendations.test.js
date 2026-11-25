const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { PostgresStore } = require('../src/store');
const { start } = require('../src/server');

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

test('manual commands do not create environmental recommendations', async t => {
  const { service, request } = await fixture(t);
  assert.deepEqual(await request(), { status: 200, data: [] });
  for (let i = 0; i < 10; i++) {
    await service.ingest('devices', { id: 'dehumidifier-1', state: 'OFF', updatedAt: new Date().toISOString() });
    await service.ingest('sensors', { humidity: 75, measuredAt: new Date().toISOString() });
    const { commandId } = await service.requestCommand('dehumidifier-1', { action: 'ON' });
    await service.ingest('ack', { commandId, status: 'EXECUTED', executedAt: new Date().toISOString(), reason: 'test' });
  }
  assert.deepEqual((await request()).data, []);
});

test('database recommendation history, rejection, stale settings and atomic rollback', async t => {
  const db = new PGlite();
  const store = new PostgresStore('', {
    query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(results => results[0]),
    end: () => db.close(),
  });
  const { service, request } = await fixture(t, store);
  await service.updateSettings({ ...service.state.settings, humidityOn: 65 });
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
  assert.deepEqual(service.state.notifications.at(-1).data, {
    type: 'recommendation.applied', recommendationId: row.id, metric: 'humidityHigh', previous: '65', threshold: '70',
  });
  assert.equal((await service.automation()).rules.find(rule => rule.id === 'humidityHigh').threshold, 70);
  await service.updateSettings({ ...service.state.settings, humidityOn: 73 });
  assert.equal((await request('/rec-1/revert', 'POST')).status, 409);
  assert.equal((await store.load()).settings.humidityOn, 73);
});
