const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresStore}=require('../src/store');

test('PostgreSQL schema, upsert, chronological latest, bucket averaging and state reload',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const pool={query:async(sql,params)=>sql.includes('CREATE TABLE')?(await db.exec(sql),{rows:[]}):db.query(sql,params),end:async()=>{}};
  const store=new PostgresStore('',pool);await store.init();await store.init();
  const now=Date.now(), base=Math.floor(now/60000)*60000-60000;
  const a={measuredAt:new Date(base+1000).toISOString(),temperature:22,humidity:50,co2:800,pm25:10,pm10:20};
  const b={...a,measuredAt:new Date(base+2000).toISOString(),co2:1000};
  assert.equal(await store.insert(b),true);assert.equal(await store.insert(a),true);assert.equal(await store.insert(a),false);
  assert.equal((await store.latest()).co2,1000);
  const h=await store.history('1h',now);assert.equal(h.points.length,1);assert.equal(h.points[0].co2,900);assert.equal(h.points[0].measuredAt,new Date(base).toISOString());
  await store.save({settings:{enabled:true},commands:[{id:'test',status:'PENDING'}]});
  const restored=new PostgresStore('',pool);assert.equal((await restored.load()).settings.enabled,true);
  await restored.save({settings:{enabled:false}});assert.equal((await store.load()).settings.enabled,false);
});
