const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const {start}=require('../src/server');
async function fixture(t,extra={}) {
  const runtime=await start({port:0,host:'127.0.0.1',demo:true,databaseUrl:'',apiToken:'',...extra});
  t.after(()=>runtime.close());return runtime;
}
function messages(socket) {
  const list=[];socket.on('message',raw=>list.push(JSON.parse(raw.toString())));return list;
}
async function waitFor(predicate,timeout=2000) {
  const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Condition timeout');await new Promise(r=>setTimeout(r,10));}
}
test('HTTP contract, CORS, invalid range and asynchronous device control',async t=>{
  const r=await fixture(t);const get=path=>fetch(r.url+path);
  assert.equal((await(await get('/health')).json()).mode,'demo');
  const latest=await(await get('/api/sensors/latest')).json();assert.equal(typeof latest.co2,'number');assert.match(latest.measuredAt,/Z$/);
  assert.equal((await(await get('/api/devices')).json()).length,4);
  for(const [range,bucket,max] of [['1h',60,60],['24h',300,288],['7d',3600,168]]){
    const h=await(await get('/api/sensors/history?range='+range)).json();assert.equal(h.bucketSeconds,bucket);assert.ok(h.points.length<=max);
  }
  assert.equal((await get('/api/sensors/history?range=__proto__')).status,400);
  assert.equal((await get('/api/sensors/history?range=invalid')).status,400);
  const cors=await fetch(r.url+'/api/devices',{headers:{Origin:'http://localhost:5173'}});assert.equal(cors.headers.get('access-control-allow-origin'),'http://localhost:5173');
  const preflight=await fetch(r.url+'/api/devices/window-1/commands',{method:'OPTIONS',headers:{Origin:'http://localhost:5173','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,idempotency-key,authorization'}});
  assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/idempotency-key/i);
  assert.equal((await fetch(r.url+'/api/devices',{headers:{Origin:'https://evil.example'}})).status,403);
  const post=await fetch(r.url+'/api/devices/window-1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'OPEN'})});
  assert.equal(post.status,202);const c=await post.json();assert.equal(c.status,'PENDING');
  await waitFor(()=>r.service.device('window-1').state==='OPEN');
  assert.equal((await(await get('/api/commands/'+c.commandId)).json()).status,'EXECUTED');
  assert.equal((await get('/api/not-real')).status,404);
});
test('standard WS initial status, periodic heartbeat, JSON ping and sensor broadcast',async t=>{
  const r=await fixture(t,{heartbeatMs:100});const s=new WebSocket(r.url.replace('http:','ws:')+'/ws');t.after(()=>s.terminate());const list=messages(s);
  await waitFor(()=>list.length);assert.equal(list[0].type,'edge.status');assert.equal(list[0].payload.online,true);
  await waitFor(()=>list.some(m=>m.type==='heartbeat'));list.length=0;s.send(JSON.stringify({type:'ping'}));
  await waitFor(()=>list.some(m=>m.type==='heartbeat'));s.send('null');s.send('{bad json');
  await r.service.ingest('sensors',{measuredAt:new Date(Date.now()+1).toISOString(),temperature:25,humidity:60,co2:999,pm25:20,pm10:30});
  await waitFor(()=>list.some(m=>m.type==='sensor.update'&&m.payload.co2===999));
});
test('heartbeat continues through edge outage and reconnect reports recovery',async t=>{
  const r=await fixture(t,{heartbeatMs:100});const s=new WebSocket(r.url.replace('http:','ws:')+'/ws');t.after(()=>s.terminate());const list=messages(s);await waitFor(()=>list.length);
  await r.service.ingest('status',{online:false,offlineMode:true});await waitFor(()=>list.some(m=>m.type==='edge.status'&&!m.payload.online));
  await waitFor(()=>list.some(m=>m.type==='heartbeat'));await r.service.ingest('status',{online:true,offlineMode:false});await r.service.tick(Date.now()+2100);
  await waitFor(()=>list.some(m=>m.type==='edge.recovered'));
});
test('REST token and WebSocket first-message authentication',async t=>{
  const r=await fixture(t,{apiToken:'test-token',heartbeatMs:50});
  assert.equal((await fetch(r.url+'/api/devices')).status,401);
  assert.equal((await fetch(r.url+'/api/devices',{headers:{Authorization:'Bearer test-token'}})).status,200);
  const s=new WebSocket(r.url.replace('http:','ws:')+'/ws');t.after(()=>s.terminate());const list=messages(s);
  await new Promise(resolve=>s.once('open',resolve));await new Promise(resolve=>setTimeout(resolve,80));assert.equal(list.length,0);
  s.send(JSON.stringify({type:'auth',payload:{token:'test-token'}}));await waitFor(()=>list.length);assert.equal(list[0].type,'edge.status');
});
test('fresh live-like server reports no readings and no online edge rather than fake values',async t=>{
  const r=await fixture(t,{transport:{start:async()=>{},close:async()=>{},ready:()=>false}});
  assert.equal((await fetch(r.url+'/api/sensors/latest')).status,503);
  assert.equal((await(await fetch(r.url+'/api/edge/status')).json()).online,false);
  assert.deepEqual((await(await fetch(r.url+'/api/sensors/history?range=1h')).json()).points,[]);
});
