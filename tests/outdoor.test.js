const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WeatherService } = require('../src/weather');
const { start } = require('../src/server');
const now = Date.parse('2026-11-18T14:35:00+09:00');
const hour = 3600000;
const iso = t => new Date(t).toISOString();
function response(items) {
  return {ok:true, json:async()=>({response:{header:{resultCode:'00'},body:{items:{item:items}}}})};
}

function airResponse(items) {
  return {ok:true, json:async()=>({response:{header:{resultCode:'00'},body:{items}}})};
}

test('outdoor HTTP demo has five hourly slots, aligned to hour starts', async t => {
  const runtime = await start({demo:true,host:'127.0.0.1',port:0,databaseUrl:'',apiToken:''});
  t.after(()=>runtime.close());
  const res = await fetch(runtime.url+'/api/outdoor');
  assert.equal(res.status,200);
  const data = await res.json();
  assert.equal(data.source,'demo');
  assert.equal(data.hourly.length,5);
  assert.ok(data.hourly.every(row=>Date.parse(row.time)%hour===0));
  assert.equal(data.pm10,28);
});

test('live report combines independent sources, preserves zeros and never forecasts PM', async () => {
  let failAir=false;
  const w = new WeatherService({kmaKey:'k',airKey:'a',airStation:'동작구'}, async url => {
    if (url.pathname.includes('ArpltnInfor')) {
      assert.equal(url.searchParams.get('stationName'),'동작구');
      if (failAir) throw Error();
      return airResponse([{dataTime:'2026-11-18 14:00',pm25Value:'0',pm10Value:'24'},
        {dataTime:'2026-11-18 13:00',pm25Value:'-',pm10Value:'11',pm10Flag:'점검및교정'}]);
    }
    if (url.pathname.endsWith('getUltraSrtNcst')) return response([{category:'T1H',obsrValue:'12'},{category:'REH',obsrValue:'50'}]);
    return response(['1400','1500','1600'].flatMap(fcstTime=>['TMP','REH','POP'].map((category,i)=>({
      category,fcstTime,fcstDate:'20261118',fcstValue:['18','60','0'][i]}))));
  });
  await w.refresh(now);
  const d=w.outdoor(now);
  assert.deepEqual([d.source,d.temp,d.humidity,d.precipitationProb,d.pm25,d.pm10],['kma+airkorea',18,60,0,0,24]);
  assert.equal(d.publishedAt,'2026-11-18T05:00:00.000Z');
  assert.equal(d.fetchedAt,iso(now));
  assert.equal(d.stale,false);
  assert.equal(d.message,null);
  assert.deepEqual(d.hourly.map(r=>r.pm25),[null,null,0,null,null]);
  assert.equal(d.hourly[1].pm10,null);
  failAir=true;
  await w.refresh(now+60000);
  assert.equal(w.outdoor(now+60000).pm10,24);
  assert.match(w.outdoor(now+60000).message,/에어코리아/);
  assert.equal(w.outdoor(now+3*hour+1).stale,true);
});

test('missing providers return explicit nulls; air data also works during KMA outage',async()=>{
  const w=new WeatherService({},()=>{throw Error()});
  await w.refresh(now);
  const d=w.outdoor(now);
  assert.deepEqual([d.temp,d.humidity,d.precipitationProb,d.pm25,d.pm10,d.fetchedAt,d.publishedAt],Array(7).fill(null));
  assert.equal(d.stale,true);
  assert.deepEqual(d.hourly,[]);
  const airOnly=new WeatherService({kmaKey:'k',airKey:'a',airStation:'동작구'},async url=>{
    if (!url.pathname.includes('ArpltnInfor')) throw Error();
    return airResponse([{dataTime:'2026-11-18 10:00',pm10Value:'0',pm25Value:'-'}]);
  });
  await airOnly.refresh(now);
  const air=airOnly.outdoor(now);
  assert.equal(air.source,'airkorea');
  assert.equal(air.pm10,0);
  assert.equal(air.pm25,null);
  assert.equal(air.stale,true);
  assert.equal(air.temp,null);
  assert.match(air.message,/기상청/);
});
