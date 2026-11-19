const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {MemoryStore,PostgresStore}=require('../src/store');
const { RoomService, initialState } = require('../src/service');

test('PostgreSQL schema, upsert, chronological latest, bucket averaging and state reload',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const pool={query:async(sql,params)=>sql.includes('CREATE TABLE')?(await db.exec(sql),{rows:[]}):db.query(sql,params),end:async()=>{}};
  await db.exec('CREATE TABLE sensor_readings (measured_at timestamptz PRIMARY KEY, temperature double precision NOT NULL, humidity double precision NOT NULL, co2 double precision NOT NULL, pm25 double precision NOT NULL, pm10 double precision NOT NULL)');
  const store=new PostgresStore('',pool);await store.init();await store.init();
  const now=Date.now(), base=Math.floor(now/60000)*60000-60000;
  const a={measuredAt:new Date(base+1000).toISOString(),temperature:22,humidity:50,co2:800,pm25:10,pm10:20};
  const b={...a,measuredAt:new Date(base+2000).toISOString(),co2:1000};
  assert.equal(await store.insert(b),true);assert.equal(await store.insert(a),true);assert.equal(await store.insert(a),false);
  assert.equal((await store.latest()).co2,1000);
  const h=await store.history('1h',now);assert.equal(h.points.length,1);assert.equal(h.points[0].co2,900);assert.equal(h.points[0].measuredAt,new Date(base).toISOString());
  const partial = {...a, measuredAt:new Date(base+3000).toISOString(),temperature:null,humidity:0,co2:null,pm25:null,pm10:null};
  const memory = new MemoryStore();
  await memory.insert(a); await memory.insert(b);
  for (const backend of [store, memory]) {
    await backend.insert(partial);
    assert.deepEqual(await backend.latest(),partial);
    const next = {...partial, measuredAt:new Date(base+60000).toISOString()};
    await backend.insert(next);
    const history = await backend.history('1h',now);
    assert.equal(history.points[0].co2,900);
    assert.equal(history.points[0].humidity,100/3);
    assert.deepEqual(history.points[1],next);
  }
  await store.save({settings:{enabled:true},commands:[{id:'test',status:'PENDING'}]});
  const restored=new PostgresStore('',pool);assert.equal((await restored.load()).settings.enabled,true);
  await restored.save({settings:{enabled:false}});assert.equal((await store.load()).settings.enabled,false);

  // A pre-automation room_state still carries the user's thresholds on startup.
  const legacy = initialState();
  legacy.settings.humidityOn = 73;
  delete legacy.automationMeta;
  delete legacy.settings.pm10Bad;
  await db.query("DELETE FROM automation");
  await db.query("UPDATE room_state SET payload=$1::jsonb WHERE id='room-1'", [JSON.stringify(legacy)]);
  const weather = { current: () => ({ weather: [] }) };
  const service = new RoomService(store, { demo: true }, weather);
  await service.init();
  assert.equal((await service.automation()).rules.find(rule => rule.id === 'humidityHigh').threshold, 73);
  await service.updateAutomation({ rules: [{ id: 'pm10Bad', threshold: 81, enabled: true, label: '외기 PM10' }] });
  const persisted = (await db.query("SELECT settings,metadata FROM automation WHERE id='room-1'")).rows[0];
  assert.equal(persisted.settings.pm10Bad, 81);
  assert.equal(persisted.metadata.rules.pm10Bad.enabled, true);
  const restarted = new RoomService(restored, { demo: true }, weather);
  await restarted.init();
  assert.deepEqual(await restarted.automation(), await service.automation());
});
