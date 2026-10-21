const {test}=require('node:test');
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
test('notification service account token cache, stable eventId and truthful dry-run result',async()=>{
 const config={notificationUrl:'http://gateway.test/api/notifications/send',notificationTokenUrl:'http://keycloak.test/token',notificationClientId:'room-care-automation',notificationClientSecret:'test-only',notificationUserId:'owner'};
 const s=new RoomService(new MemoryStore(),config,{current:()=>({weather:[]})});await s.init();
 await s.run(()=>{s.notify('첫 번째');s.notify('두 번째');});const calls=[];
 const bridge=new NotificationBridge(s,config,async(url,options)=>{
  calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock-token',expires_in:300}:{status:'dry-run',targetCount:0,successCount:0}};
 });
 await bridge.flush();await bridge.flush();assert.equal(calls.length,3);assert.ok(s.state.notifications.every(n=>n.pushStatus==='DRY-RUN'));
 const sent=JSON.parse(calls[1].options.body);assert.equal(sent.eventId,s.state.notifications[0].id);assert.equal(sent.userId,'owner');assert.equal(calls[1].options.headers.Authorization,'Bearer mock-token');
});
test('notification outages retry with same ID and stop after three attempts',async()=>{
 const config={notificationUrl:'http://gateway.test/send',notificationTokenUrl:'http://keycloak.test/token',notificationClientId:'room-care-automation',notificationClientSecret:'test-only',notificationUserId:'owner'};
 const s=new RoomService(new MemoryStore(),config,{current:()=>({weather:[]})});await s.init();await s.run(()=>s.notify('알림'));
 const bridge=new NotificationBridge(s,config,async()=>{throw Error('offline');});
 for(let i=0;i<3;i++){await bridge.flush();s.state.notifications[0].nextAttemptAt=0;}
 assert.equal(s.state.notifications[0].pushStatus,'FAILED');assert.equal(s.state.notifications[0].pushAttempts,3);
});
