const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WeatherService,forecastBase}=require('../src/weather');
test('KMA base time uses KST and publication delay across midnight',()=>{
  assert.deepEqual(forecastBase(Date.parse('2026-10-21T00:05:00+09:00')),{date:'20261020',time:'2300'});
  assert.deepEqual(forecastBase(Date.parse('2026-10-21T02:10:00+09:00')),{date:'20261020',time:'2300'});
  assert.deepEqual(forecastBase(Date.parse('2026-10-21T02:20:00+09:00')),{date:'20261021',time:'0200'});
});
test('KMA maps typed weather, missing air quality stays null, outage becomes stale',async()=>{
  const now=Date.parse('2026-10-21T11:30:00+09:00');const urls=[];
  const w=new WeatherService({demo:false,kmaKey:'decoded+/=',kmaNx:'60',kmaNy:'127'},async url=>{
    urls.push(url);const items=url.pathname.endsWith('getVilageFcst')?['TMP','REH','POP'].map((category,i)=>({category,fcstDate:'20261021',fcstTime:'1200',fcstValue:['20','55','80'][i]})):[{category:'T1H',obsrValue:'19'},{category:'REH',obsrValue:'60'},{category:'RN1',obsrValue:'0'}];
    return {ok:true,json:async()=>({response:{header:{resultCode:'00'},body:{items:{item:items}}}})};
  });
  await w.refresh(now);assert.equal(w.data.source,'kma');assert.equal(w.data.weather[0].precipitationProb,80);assert.equal(w.data.weather[0].pm25,null);assert.equal(w.data.observations.length,2);
  assert.equal(urls[0].searchParams.get('serviceKey'),'decoded+/=');
  w.data.updatedAt=new Date(Date.now()-31*60000).toISOString();assert.equal(w.current().stale,true);assert.equal(w.current().weather.length,0);
});
