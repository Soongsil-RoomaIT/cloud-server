const HOUR = 3600000;
function kstParts(time) {
  const value = new Date(time + 9 * HOUR).toISOString();
  return { date: value.slice(0,10).replaceAll('-', ''), hour: value.slice(11,13) };
}
function forecastBase(now) {
  // Village forecast releases at 02/05/08/11/14/17/20/23 KST. Allow 15 min publication delay.
  const available = now - 15 * 60000;
  for (let i = 0; i < 25; i++) {
    const p = kstParts(available - i * HOUR);
    if ([2,5,8,11,14,17,20,23].includes(Number(p.hour))) return { date: p.date, time: p.hour + '00' };
  }
}
class WeatherService {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.data = { source: 'unavailable', updatedAt: null, weather: [], observations: [], message: '기상청 API 키를 설정하면 예보를 조회합니다.' }; }
  current() {
    if (this.data.updatedAt && Date.now() - Date.parse(this.data.updatedAt) > 30 * 60000) return { ...this.data, stale: true, weather: [] };
    return { ...this.data, stale: false };
  }
  async request(endpoint, base) {
    const url = new URL(`https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/${endpoint}`);
    url.search = new URLSearchParams({ serviceKey: this.config.kmaKey, pageNo: '1', numOfRows: '1000', dataType: 'JSON', base_date: base.date, base_time: base.time, nx: this.config.kmaNx, ny: this.config.kmaNy });
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('기상청 HTTP 요청 실패');
    const json = await response.json();
    if (json.response?.header?.resultCode !== '00') throw new Error('기상청 응답 오류 또는 자료 준비 중');
    const items = json.response.body?.items?.item;
    if (!Array.isArray(items)) throw new Error('기상청 데이터 형식 오류');
    return items;
  }
  async refresh(now = Date.now()) {
    if (this.config.demo) {
      this.data = { source: 'demo', updatedAt: new Date(now).toISOString(), observations: [-2,-1].map(n => ({ time: new Date(now+n*HOUR).toISOString(), temp: 21, humidity: 55, precipitation: 0 })),
        weather: [0,1,2].map(n => ({ time: new Date(now+n*HOUR).toISOString(), temp: 22+n, humidity: 55, precipitationProb: 20, pm25: 14 })) };
      return;
    }
    if (!this.config.kmaKey) return;
    try {
      const items = await this.request('getVilageFcst', forecastBase(now));
      const groups = new Map();
      for (const item of items) {
        const time = new Date(`${item.fcstDate.slice(0,4)}-${item.fcstDate.slice(4,6)}-${item.fcstDate.slice(6,8)}T${item.fcstTime.slice(0,2)}:${item.fcstTime.slice(2,4)}:00+09:00`).toISOString();
        if (Date.parse(time) < now - HOUR || Date.parse(time) > now + 2 * HOUR) continue;
        const row = groups.get(time) || { time, pm25: null };
        const field = { TMP: 'temp', REH: 'humidity', POP: 'precipitationProb' }[item.category];
        if (field && item.fcstValue !== '' && Number.isFinite(Number(item.fcstValue))) row[field] = Number(item.fcstValue);
        groups.set(time, row);
      }
      const weather = [...groups.values()].filter(r => ['temp','humidity','precipitationProb'].every(k => Number.isFinite(r[k]))).sort((a,b) => a.time.localeCompare(b.time));
      if (!weather.length) throw new Error('기상청 예보가 비어 있습니다');
      const observations = [];
      // Fetch observations for the preceding two hours; unavailable observations are explicit.
      for (const n of [2,1]) {
        const p = kstParts(now - n * HOUR);
        try {
          const rows = await this.request('getUltraSrtNcst', { date: p.date, time: p.hour + '00' });
          const values = Object.fromEntries(rows.map(r => [r.category, Number(r.obsrValue)]));
          if (Number.isFinite(values.T1H) && Number.isFinite(values.REH)) observations.push({ time: new Date(`${p.date.slice(0,4)}-${p.date.slice(4,6)}-${p.date.slice(6,8)}T${p.hour}:00:00+09:00`).toISOString(), temp: values.T1H, humidity: values.REH, precipitation: Number.isFinite(values.RN1) ? values.RN1 : null });
        } catch { /* Forecast remains usable if an observation is missing. */ }
      }
      this.data = { source: 'kma', updatedAt: new Date(now).toISOString(), weather, observations, message: '기상청은 미세먼지 예보를 제공하지 않아 pm25는 null입니다. 실외 미세먼지가 확인되기 전 자동 환기는 보류합니다.' };
    } catch {
      this.data = { ...this.data, message: '기상청 조회에 실패했습니다. 마지막 수신 시각과 stale을 확인하세요.' };
    }
  }
}
module.exports = { WeatherService, forecastBase };
