// Run after frontend:setup. Validate against the team's actual TypeScript guards.
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const assert=require('node:assert/strict');
const {start}=require('../src/server');
const {WebSocket}=require('ws');
(async()=>{
 const protocol=await import(pathToFileURL(path.join(__dirname,'../.local/frontend/src/realtime/protocol.ts')).href);
 const runtime=await start({port:0,demo:true,databaseUrl:'',apiToken:''});
 const socket=new WebSocket(runtime.url.replace('http:','ws:')+'/ws');
 const observed=new Set();let failure;
 socket.on('message',raw=>{
   const message=JSON.parse(raw.toString());
   if(['edge.status','sensor.update','device.state','command.ack','edge.recovered','heartbeat'].includes(message.type)){
     try{assert.ok(protocol.parseServerMessage(raw.toString()),`Frontend rejected ${message.type}`);observed.add(message.type);}catch(e){failure=e;}
   }
 });
 try{
  await new Promise(resolve=>socket.once('open',resolve));
  socket.send(JSON.stringify({type:'ping'}));
  const devices=await(await fetch(runtime.url+'/api/devices')).json();assert.ok(devices.every(protocol.isDevice));
  const res=await fetch(runtime.url+'/api/devices/window-1/commands',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'actual-frontend-contract'},body:JSON.stringify({action:'OPEN'})});assert.equal(res.status,202);
  await runtime.service.ingest('sensors',{measuredAt:new Date(Date.now()+1).toISOString(),temperature:24,humidity:60,co2:900,pm25:20,pm10:30});
  await new Promise(resolve=>setTimeout(resolve,250));
  await runtime.service.ingest('status',{online:false,offlineMode:true});await runtime.service.ingest('status',{online:true,offlineMode:false});await runtime.service.tick(Date.now()+2100);
  await new Promise(resolve=>setTimeout(resolve,100));
  if(failure)throw failure;
  for(const type of ['edge.status','sensor.update','device.state','command.ack','edge.recovered','heartbeat'])assert.ok(observed.has(type),`Missing ${type}`);
  console.log('PASS: six WebSocket message types and Device[] accepted by the actual frontend branch.');
 }finally{socket.terminate();await runtime.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
