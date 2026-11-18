const HOUR = 3600000;
const hour = ms => Math.floor(ms / HOUR) * HOUR;
const iso = ms => new Date(ms).toISOString();
const empty = () => ({ temp:null, humidity:null, precipitationProb:null, pm25:null, pm10:null });

function particulate(value, flag) {
  if (flag || value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

class AirQuality {
  constructor(config, fetcher) {
    this.config = config;
    this.fetcher = fetcher;
    this.rows = [];
    this.fetchedAt = null;
    this.message = null;
  }
  async refresh(now) {
    if (this.config.demo) return;
    if (!this.config.airKey || !this.config.airStation) {
      this.message = '에어코리아 API 키와 측정소명을 설정하면 미세먼지를 조회합니다.';
      return;
    }
    try {
      const url = new URL('https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty');
      url.search = new URLSearchParams({ serviceKey:this.config.airKey, stationName:this.config.airStation,
        returnType:'json', dataTerm:'DAILY', ver:'1.3', numOfRows:'24', pageNo:'1' });
      const res = await this.fetcher(url, { signal:AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error();
      const {response} = await res.json();
      if (response?.header?.resultCode !== '00') throw new Error();
      const rows = [];
      for (const item of response.body.items) {
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(item.dataTime)) continue;
        const ms = Date.parse(item.dataTime.replace(' ','T') + ':00+09:00');
        if (!Number.isFinite(ms) || ms > now) continue;
        rows.push({ ms, pm25:particulate(item.pm25Value,item.pm25Flag), pm10:particulate(item.pm10Value,item.pm10Flag) });
      }
      if (!rows.length) throw new Error();
      this.rows = rows.sort((a,b) => a.ms-b.ms);
      this.fetchedAt = now;
      const latest = this.rows.at(-1);
      this.message = latest.pm25 == null || latest.pm10 == null ? '측정소의 일부 미세먼지 값이 없습니다.' : null;
    } catch {
      this.message = '에어코리아 조회에 실패했습니다.';
    }
  }
}

function outdoorReport(data, publishedAt, air, now = Date.now()) {
  const demo = data.source === 'demo';
  const weatherFetch = Date.parse(data.updatedAt);
  const latestAir = air.rows.at(-1);
  const fetched = [weatherFetch, air.fetchedAt].filter(Number.isFinite);
  const currentHour = hour(now);
  const slots = new Map();
  function slot(ms) {
    const key = hour(ms);
    if (!slots.has(key)) slots.set(key, { time:iso(key), ...empty() });
    return slots.get(key);
  }
  for (const row of data.weather) {
    const dest = slot(Date.parse(row.time));
    Object.assign(dest, {temp:row.temp, humidity:row.humidity, precipitationProb:row.precipitationProb});
    if (demo) Object.assign(dest, {pm25:row.pm25, pm10:28});
  }
  for (const row of data.observations) {
    Object.assign(slot(Date.parse(row.time)), {temp:row.temp, humidity:row.humidity});
  }
  for (const row of air.rows) Object.assign(slot(row.ms), {pm25:row.pm25, pm10:row.pm10});
  const current = {...empty()};
  // Prefer this hour, then the last available past weather for a cached card.
  const weatherRow = [...slots.entries()].filter(([ms,r]) => ms <= currentHour && r.temp != null)
    .sort(([a],[b]) => b-a)[0]?.[1];
  if (weatherRow) Object.assign(current, {temp:weatherRow.temp, humidity:weatherRow.humidity});
  current.precipitationProb = slots.get(currentHour)?.precipitationProb ?? null;
  if (demo && weatherRow) Object.assign(current, {pm25:weatherRow.pm25, pm10:weatherRow.pm10});
  if (latestAir) Object.assign(current, {pm25:latestAir.pm25, pm10:latestAir.pm10});
  const hourly = [...slots].filter(([ms]) => Math.abs(ms-currentHour) <= 2*HOUR)
    .sort(([a],[b]) => a-b).map(([,row]) => row);
  const source = [data.updatedAt && data.source, latestAir && 'airkorea'].filter(Boolean).join('+') || 'unavailable';
  const stale = !fetched.length || fetched.some(ms => now-ms > 3*HOUR) || Boolean(latestAir && now-latestAir.ms > 3*HOUR);
  const message = [data.message, air.message].filter(Boolean).join(' ') || null;
  return { source, publishedAt:publishedAt || (latestAir ? iso(latestAir.ms) : null),
    fetchedAt:fetched.length ? iso(Math.max(...fetched)) : null, stale, message, ...current, hourly };
}

module.exports = { AirQuality, outdoorReport };
