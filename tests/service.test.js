const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../src/store');
const { RoomService, defaults } = require('../src/service');
const { WeatherService } = require('../src/weather');

const config = { demo: true, edgeTimeoutMs: 10000, commandTimeoutMs: 5000 };
const reading = (extras={}) => ({ measuredAt: new Date().toISOString(), temperature: 24, humidity: 55, co2: 800, pm25: 18, pm10: 30, ...extras });
async function fixture() {
  const store = new MemoryStore(), weather = new WeatherService(config); await weather.refresh();
  const s = new RoomService(store, config, weather); await s.init();
  const sent = []; s.transport = { ready: () => true, send: async c => sent.push(c) };
  await s.ingest('status', { online: true, offlineMode: false });
  for (const d of s.state.devices) await s.ingest('devices', { id: d.id, state: d.state, updatedAt: new Date().toISOString() });
  return { s, store, sent };
}
test('readings validate numbers, timezone and physical ranges, reject future timestamps', async () => {
  const {s} = await fixture();
  for (const bad of [{ co2:'900' },{ humidity:101 },{ measuredAt:'2026-10-01T10:00:00' },{ measuredAt:new Date(Date.now()+60000).toISOString() }]) await assert.rejects(s.ingest('sensors', reading(bad)));
  assert.equal(s.latest, null);
});
test('missing humidity and PM2.5 do not trigger low-value appliance rules', async () => {
  const {s} = await fixture();
  await s.ingest('sensors', {measuredAt:new Date().toISOString(), humidity:null});
  assert.equal(s.latest.temperature,null);
  assert.equal(s.proposals(Date.now()).some(p=>['dehumidifier-1','purifier-1'].includes(p.deviceId)),false);
});
test('duplicate and old readings do not regress realtime latest; history is bucket average', async () => {
  const {s,store} = await fixture(); const now=Date.now(), base=Math.floor(now/60000)*60000-60000;
  const events=[];s.on('message',m=>events.push(m));
  const a=reading({measuredAt:new Date(base+1000).toISOString(),co2:800});
  const b=reading({measuredAt:new Date(base+2000).toISOString(),co2:1000});
  await s.ingest('sensors',b);await s.ingest('sensors',a);await s.ingest('sensors',b);
  assert.equal(s.latest.co2,1000);assert.equal(events.filter(m=>m.type==='sensor.update').length,1);
  const h=await store.history('1h',now);assert.equal(h.bucketSeconds,60);assert.equal(h.points.length,1);assert.equal(h.points[0].co2,900);assert.equal(h.points[0].measuredAt,new Date(base).toISOString());
});
test('command stays pending until ACK, concurrent command conflicts, duplicate ACK is harmless', async () => {
  const {s,sent}=await fixture(); const c=await s.requestCommand('window-1',{action:'OPEN'});
  await Promise.resolve();assert.equal(sent.length,1);assert.equal(s.device('window-1').state,'CLOSED');
  await assert.rejects(s.requestCommand('window-1',{action:'CLOSE'}),{status:409});
  const ack={commandId:c.commandId,status:'EXECUTED',reason:'완료',executedAt:new Date().toISOString()};
  await s.ingest('ack',ack);await s.ingest('ack',ack);
  assert.equal(s.device('window-1').state,'OPEN');assert.equal(s.state.notifications.length,1);
});
test('invalid actions, offline and local control do not publish commands', async () => {
  const {s,sent}=await fixture();
  await assert.rejects(s.requestCommand('window-1',{action:'ON'}),{status:400});
  await assert.rejects(s.requestCommand('unknown',{action:'OPEN'}),{status:404});
  await s.ingest('status',{online:true,offlineMode:true});
  await assert.rejects(s.requestCommand('window-1',{action:'OPEN'}),{status:409});
  await s.ingest('status',{online:false,offlineMode:true});
  await assert.rejects(s.requestCommand('window-1',{action:'OPEN'}),{status:503});assert.equal(sent.length,0);
});
test('missing ACK times out without inventing a device state', async () => {
  const {s}=await fixture();const c=await s.requestCommand('window-1',{action:'OPEN'});
  await s.tick(Date.now()+5100);assert.equal(s.state.commands.find(x=>x.id===c.commandId).status,'FAILED');assert.equal(s.device('window-1').state,'CLOSED');
});
test('recovery emitted once, local actions deduplicated and older state cannot overwrite newer', async () => {
  const {s}=await fixture();const events=[];s.on('message',m=>events.push(m));const now=Date.now();
  await s.ingest('status',{online:false,offlineMode:true});await s.ingest('status',{online:true,offlineMode:false});
  const report={offlineSince:new Date(now-10000).toISOString(),recoveredAt:new Date(now).toISOString(),localActions:[{executedAt:new Date(now-5000).toISOString(),deviceId:'window-1',state:'OPEN',reason:'환기'}]};
  await s.ingest('recovery',report);await s.ingest('recovery',report);await s.tick(now+2500);
  assert.equal(events.filter(m=>m.type==='edge.recovered').length,1);assert.equal(s.state.notifications.length,1);
  await s.ingest('devices',{id:'window-1',state:'CLOSED',updatedAt:new Date(now).toISOString()});
  await s.ingest('devices',{id:'window-1',state:'OPEN',updatedAt:new Date(now-5000).toISOString()});assert.equal(s.device('window-1').state,'CLOSED');
});
test('recovery fallback is sent even if edge does not provide local action report', async () => {
  const {s}=await fixture();const messages=[];s.on('message',m=>messages.push(m));
  await s.ingest('status',{online:false,offlineMode:false});await s.ingest('status',{online:true,offlineMode:false});await s.tick(Date.now()+2100);await s.tick(Date.now()+2200);
  assert.equal(messages.filter(m=>m.type==='edge.recovered').length,1);
  assert.equal(s.state.notifications.filter(n => n.data.type === 'edge.recovered').length, 1);
});
test('approval mode proposes once, stale recommendation cannot be approved', async () => {
  const {s,sent}=await fixture();await s.updateSettings({...defaults,enabled:true});
  await s.ingest('sensors',reading({humidity:75}));await s.tick();
  assert.equal(s.state.decisions.length,1);assert.equal(sent.length,0);
  const d=s.state.decisions[0];await s.ingest('sensors',reading({measuredAt:new Date(Date.now()+1).toISOString(),humidity:50}));
  assert.equal(s.state.decisions[0].status,'EXPIRED');await assert.rejects(s.decide(d.id,true),{status:409});
});
test('approved recommendation is executed through the same ACK path', async () => {
  const {s}=await fixture();await s.updateSettings({...defaults,enabled:true});await s.ingest('sensors',reading({humidity:75}));
  const d=await s.decide(s.state.decisions[0].id,true);assert.equal(d.status,'APPROVED');
  await s.ingest('ack',{commandId:d.commandId,status:'EXECUTED',reason:'습도 제어',executedAt:new Date().toISOString()});
  assert.equal(s.state.decisions[0].status,'EXECUTED');assert.equal(s.device('dehumidifier-1').state,'ON');
  assert.deepEqual(s.state.notifications.at(-1).data, {
    type: 'device.command', commandId: d.commandId, deviceId: 'dehumidifier-1',
    action: 'ON', source: 'APPROVED', status: 'EXECUTED',
  });
});
test('auto mode respects manual hold and suppresses duplicate commands', async () => {
  const {s,sent}=await fixture();await s.updateSettings({...defaults,enabled:true,mode:'AUTO'});
  await s.ingest('sensors',reading({humidity:75}));await s.tick();await Promise.resolve();assert.equal(sent.length,1);
  const c=s.state.commands[0];await s.ingest('ack',{commandId:c.id,status:'EXECUTED',reason:'완료',executedAt:new Date().toISOString()});
  const manual=await s.requestCommand('dehumidifier-1',{action:'OFF'});await s.ingest('ack',{commandId:manual.commandId,status:'EXECUTED',reason:'수동',executedAt:new Date().toISOString()});
  await s.ingest('sensors',reading({measuredAt:new Date(Date.now()+1).toISOString(),humidity:80}));assert.equal(s.state.commands.length,2);
});
test('door closes only after ten continuous minutes, even when sensor data is stale', async () => {
  const {s}=await fixture();await s.updateSettings({...defaults,enabled:true});
  const now=Date.now();await s.ingest('devices',{id:'door-1',state:'OPEN',updatedAt:new Date(now).toISOString()});
  assert.equal(s.proposals(now+599999).some(p=>p.deviceId==='door-1'),false);
  assert.equal(s.proposals(now+600000).some(p=>p.deviceId==='door-1'&&p.action==='CLOSE'),true);
  await s.ingest('devices',{id:'door-1',state:'CLOSED',updatedAt:new Date(now+1).toISOString()});assert.equal(s.state.doorOpenedAt,null);
});
test('unknown outdoor PM blocks automatic opening, forecast rain proposes closure', async () => {
  const {s}=await fixture();await s.updateSettings({...defaults,enabled:true});
  s.weather.data.weather.forEach(w=>{w.pm25=null;});await s.ingest('sensors',reading({co2:1500}));assert.equal(s.state.decisions.length,0);
  await s.ingest('devices',{id:'window-1',state:'OPEN',updatedAt:new Date().toISOString()});
  s.weather.data.weather.forEach(w=>{w.precipitationProb=80;});await s.tick();assert.equal(s.state.decisions.at(-1).action,'CLOSE');
});
test('automatic control uses saved rule switches and blocks ventilation without outdoor readings', async () => {
  const {s} = await fixture();
  await s.ingest('sensors', reading({ temperature: 31, humidity: 75, co2: null }));
  const rules = [
    { id: 'humidityHigh', threshold: 65, enabled: false },
    { id: 'temperatureHigh', threshold: 30, enabled: true },
    { id: 'pm10Bad', threshold: 80, enabled: true },
  ];
  await s.updateAutomation({ rules });
  s.weather.airQuality = () => ({ pm25: 10, pm10: 40 });
  const proposals = () => s.proposals(Date.now());
  assert.equal(proposals().some(p => p.deviceId === 'dehumidifier-1'), false);
  assert.equal(proposals().some(p => p.deviceId === 'window-1' && p.action === 'OPEN'), true);
  s.weather.airQuality = () => ({ pm25: 10, pm10: null });
  assert.equal(proposals().some(p => p.deviceId === 'window-1'), false);
  s.weather.airQuality = () => ({ pm25: 10, pm10: 90 });
  assert.equal(proposals().some(p => p.deviceId === 'window-1' && p.action === 'CLOSE'), true);
  assert.equal(proposals().some(p => p.deviceId === 'purifier-1' && p.action === 'ON'), true);
  s.weather.data.weather.forEach(row => { row.precipitationProb = 90; });
  s.weather.airQuality = () => ({ pm25: 10, pm10: 40 });
  assert.equal(proposals().some(p => p.deviceId === 'window-1' && p.action === 'CLOSE'), true);
});

test('storage failure rolls back state and never publishes a command', async () => {
  const {s,store,sent}=await fixture();store.save=async()=>{throw new Error('DB unavailable');};
  await assert.rejects(s.requestCommand('window-1',{action:'OPEN'}));assert.equal(s.state.commands.length,0);assert.equal(sent.length,0);
});
module.exports={fixture,reading};
test('fresh rain forecast can close a window even when indoor readings are missing', async()=>{
  const {s}=await fixture();await s.updateSettings({...defaults,enabled:true});
  await s.ingest('devices',{id:'window-1',state:'OPEN',updatedAt:new Date().toISOString()});
  s.weather.data.weather.forEach(w=>{w.precipitationProb=90;});await s.tick();
  assert.equal(s.state.decisions.at(-1).action,'CLOSE');assert.equal(s.latest,null);
});
test('sensor retry recovers latest after insert succeeded but state save failed',async()=>{
  const {s,store}=await fixture();const save=store.save.bind(store);store.save=async()=>{throw Error('temporary DB error');};
  const r=reading();await assert.rejects(s.ingest('sensors',r));assert.equal(s.latest,null);
  store.save=save;await s.ingest('sensors',r);assert.equal(s.latest.co2,r.co2);
});
