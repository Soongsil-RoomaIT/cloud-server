const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const mqtt=require('mqtt');
const {MemoryStore}=require('../src/store');
const {RoomService}=require('../src/service');
const {WeatherService}=require('../src/weather');
const {MqttTransport}=require('../src/transports');
const {handleLegacy}=require('../src/edge-agent-adapter');

async function until(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('MQTT wait timed out');await new Promise(r=>setTimeout(r,10));}}
async function room(protocol='edge-agent'){
 const config={demo:false,mqttProtocol:protocol,mqttPrefix:'roomcare/room-001',edgeTimeoutMs:10000,commandTimeoutMs:5000};
 const s=new RoomService(new MemoryStore(),config,new WeatherService(config));await s.init();return{s,config};
}
test('team edge MQTT telemetry/status/events and command format work through a real broker',async t=>{
 const {Aedes}=await import('aedes');const broker=await Aedes.createBroker();const server=net.createServer(broker.handle);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {s,config}=await room();config.mqttUrl=`mqtt://127.0.0.1:${server.address().port}`;
 const cloud=new MqttTransport(s,config);s.transport=cloud;
 const edge=mqtt.connect(config.mqttUrl,{reconnectPeriod:0});
 t.after(async()=>{await edge.endAsync(true);await cloud.close();await s.tail;await new Promise(r=>broker.close(r));await new Promise(r=>server.close(r));});
 await new Promise(resolve=>edge.once('connect',resolve));
 // Retained online from a previous session must not mark a dead edge alive.
 await edge.publishAsync(config.mqttPrefix+'/status','online',{qos:1,retain:true});
 cloud.start();await until(()=>cloud.ready());await new Promise(r=>setTimeout(r,100));assert.equal(s.state.edge.online,false);
 await edge.publishAsync(config.mqttPrefix+'/telemetry',JSON.stringify({measuredAt:Date.now()/1000,temperature:23,humidity:60,co2:900,pm25:15,pm10:25}),{qos:1});
 await until(()=>s.latest);assert.equal(s.latest.co2,900);assert.match(s.latest.measuredAt,/Z$/);assert.equal(s.state.edge.online,true);
 assert.deepEqual(s.device('dehumidifier-1').actions,[]);
 await edge.subscribeAsync(config.mqttPrefix+'/command');let received;
 edge.on('message',(topic,raw)=>{if(topic.endsWith('/command'))received=JSON.parse(raw.toString());});
 const result=await s.requestCommand('window-1',{action:'OPEN'},'mqtt-test-key');await until(()=>received);
 assert.equal(received.actuator,'window');assert.equal(received.on,true);assert.equal(received.commandId,result.commandId);
 await edge.publishAsync(config.mqttPrefix+'/events',JSON.stringify({occurredAt:Date.now()/1000,type:'remote_command',detail:{actuator:'window',on:true}}),{qos:1});
 await until(()=>s.state.commands[0].acceptedAt);assert.equal(s.state.commands[0].status,'PENDING');assert.equal(s.device('window-1').state,'UNKNOWN');
 const occurredAt = Date.now()/1000;
 await edge.publishAsync(config.mqttPrefix+'/events', JSON.stringify({occurredAt, type:'door_opened', detail:{initial:true}}), {qos:1});
 await until(() => s.device('door-1').state === 'OPEN');
 assert.equal(s.device('door-1').stateSource, 'SENSOR');
 assert.equal(s.device('door-1').autoCloseAt, null);
 const deadline = new Date((occurredAt + 600)*1000).toISOString();
 await edge.publishAsync(config.mqttPrefix+'/events', JSON.stringify({
   occurredAt, type:'door_auto_close_scheduled', detail:{autoCloseAt:deadline},
 }), {qos:1});
 await until(() => s.device('door-1').autoCloseAt === deadline);
 await edge.publishAsync(config.mqttPrefix+'/status','offline',{qos:1,retain:true});await until(()=>!s.state.edge.online);
 assert.equal(s.device('door-1').autoCloseAt, null);
});
test('legacy accepts partial readings; backlog events deduplicate without inventing execution',async()=>{
 const {s}=await room();
 await handleLegacy(s,'telemetry',{measuredAt:Date.now()/1000,temperature:23,humidity:60,pm10:null});
 assert.deepEqual(s.latest,{measuredAt:s.latest.measuredAt,temperature:23,humidity:60,co2:null,pm25:null,pm10:null});
 const event={occurredAt:Date.now()/1000,type:'auto_control',detail:{actuator:'window',on:true,reason:'co2'}};
 await handleLegacy(s,'events',event);await handleLegacy(s,'events',event);assert.equal(s.state.notifications.length,1);assert.equal(s.device('window-1').stateSource,'ASSUMED');
});
test('idempotency returns first response after completion, survives reload, conflicts on reuse',async()=>{
 const {s}=await room();s.transport={ready:()=>true,send:async()=>{}};await s.ingest('status',{online:true,offlineMode:false});
 const first=await s.requestCommand('window-1',{action:'OPEN'},'key-1');await s.ingest('ack',{commandId:first.commandId,status:'EXECUTED',reason:'test',executedAt:new Date().toISOString()});
 const copy=new RoomService(s.store,s.config,s.weather);await copy.init();
 assert.deepEqual(await copy.requestCommand('window-1',{action:'OPEN'},'key-1'),first);assert.equal(copy.state.commands.length,1);
 await assert.rejects(copy.requestCommand('window-1',{action:'CLOSE'},'key-1'),{status:409});
  assert.throws(()=>copy.requestCommand('window-1',{action:'CLOSE'},'__proto__'));
});
