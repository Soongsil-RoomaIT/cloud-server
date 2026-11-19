const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const { ApiError } = require('./validation');
const conflict = () => new ApiError(409, '이미 변경된 추천입니다. 목록을 다시 조회하세요.');

const ranges = { '1h': [3600, 60], '24h': [86400, 300], '7d': [604800, 3600] };
const metrics = ['temperature', 'humidity', 'co2', 'pm25', 'pm10'];
function windowFor(range, now) {
  const [seconds, bucket] = ranges[range];
  // Include the current partial bucket; always return at most 60/288/168 points.
  const end = (Math.floor(now / (bucket * 1000)) + 1) * bucket * 1000;
  return { start: end - seconds * 1000, end: now, bucket };
}
function averageMetric(rows, key) {
  let sum = 0, count = 0;
  for (const row of rows) {
    if (row[key] == null) continue;
    sum += row[key];
    count++;
  }
  return count ? sum / count : null;
}
class MemoryStore {
  constructor() { this.readings = new Map(); this.recommendations = new Map(); this.state = null; }
  async init() {}
  async latestForecast() { return null; } // The demo has no indoor prediction model.
  async listRecommendations() {
    return structuredClone([...this.recommendations.values()]).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async save(state, change) {
    const saved = structuredClone(state);
    if (change) {
      const { record, previous } = change;
      if ((this.recommendations.get(record.id)?.status ?? null) !== (previous?.status ?? null)) throw conflict();
      this.recommendations.set(record.id, structuredClone(record));
    }
    this.state = saved;
  }
  async load() { return structuredClone(this.state); }
  async insert(reading) {
    if (this.readings.has(reading.measuredAt)) return false;
    this.readings.set(reading.measuredAt, structuredClone(reading));
    const cutoff = Date.now() - 8 * 86400000;
    // Map insertion order cannot be used: recovery packets can arrive late.
    for (const [key] of this.readings) if (Date.parse(key) < cutoff) this.readings.delete(key);
    return true;
  }
  async latest() { return [...this.readings.values()].sort((a,b) => b.measuredAt.localeCompare(a.measuredAt))[0] || null; }
  async history(range, now = Date.now()) {
    const { start, end, bucket } = windowFor(range, now);
    const groups = new Map();
    for (const reading of this.readings.values()) {
      const time = Date.parse(reading.measuredAt);
      if (time < start || time > end) continue;
      const key = Math.floor(time / (bucket * 1000)) * bucket * 1000;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(reading);
    }
    return { range, bucketSeconds: bucket, points: [...groups].sort((a,b) => a[0]-b[0]).map(([time, rows]) => ({
      measuredAt: new Date(time).toISOString(),
      ...Object.fromEntries(metrics.map(key => [key, averageMetric(rows, key)])),
    })) };
  }
  async close() {}
}
class PostgresStore {
  constructor(url, pool) { this.pool = pool || new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 5 }); }
  async init() { await this.pool.query(await fs.readFile(path.join(__dirname, '../database/schema.sql'), 'utf8')); }
  async latestForecast() {
    const { rows } = await this.pool.query(
      'SELECT generated_at, model_version, control_enabled, metrics FROM prediction ORDER BY generated_at DESC LIMIT 1'
    );
    if (!rows.length) return null;
    const row = rows[0];
    const generated = new Date(row.generated_at);
    return {
      generatedAt: generated.toISOString(), targetAt: new Date(generated.getTime() + 3600000).toISOString(),
      controlEnabled: row.control_enabled, modelVersion: row.model_version, message: null, metrics: row.metrics,
    };
  }
  async load() {
    const { rows } = await this.pool.query(
      "SELECT room_state.payload, automation.settings, automation.metadata FROM room_state LEFT JOIN automation USING (id) WHERE room_state.id='room-1'"
    );
    const row = rows[0];
    if (!row) return null;
    if (!row.settings) return row.payload;
    return { ...row.payload, settings: row.settings, automationMeta: row.metadata };
  }
  async listRecommendations() {
    const { rows } = await this.pool.query("SELECT payload FROM recommendation ORDER BY (payload->>'createdAt')::timestamptz DESC, id DESC");
    return rows.map(row => row.payload);
  }
  async save(state, change) {
    const upsert = 'ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()';
    const params = [JSON.stringify(state)];
    let recommendationWrite = '';
    let stateSource = "VALUES ('room-1',$1::jsonb)";
    if (change) {
      const { record, previous } = change;
      params.push(record.id, JSON.stringify(record));
      let write = 'INSERT INTO recommendation(id,payload) VALUES ($2,$3::jsonb) ON CONFLICT DO NOTHING';
      if (previous) {
        params.push(JSON.stringify(previous));
        write = 'UPDATE recommendation SET payload=$3::jsonb WHERE id=$2 AND payload=$4::jsonb';
      }
      recommendationWrite = 'changed AS (' + write + ' RETURNING id),';
      stateSource = "SELECT 'room-1',$1::jsonb FROM changed";
    }
    // Commit rule edits, room state and recommendation status together.
    const { rows } = await this.pool.query(`WITH ${recommendationWrite}
      saved AS (
        INSERT INTO room_state(id,payload) ${stateSource} ${upsert} RETURNING id,payload
      ), automation_saved AS (
        INSERT INTO automation(id,settings,metadata)
          SELECT id, payload->'settings', COALESCE(payload->'automationMeta', '{}')
          FROM saved WHERE payload ? 'settings'
        ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings, metadata=EXCLUDED.metadata
          WHERE (automation.settings, automation.metadata) IS DISTINCT FROM (EXCLUDED.settings, EXCLUDED.metadata)
      )
      SELECT id FROM saved`, params);
    if (!rows.length) throw conflict();
  }
  async insert(r) {
    const result = await this.pool.query('INSERT INTO sensor_readings VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING measured_at', [r.measuredAt, ...metrics.map(k => r[k])]);
    return result.rows.length > 0;
  }
  row(r) { return { measuredAt: new Date(r.measured_at).toISOString(), ...Object.fromEntries(metrics.map(k => [k, r[k] == null ? null : Number(r[k])])) }; }
  async latest() { const r = (await this.pool.query('SELECT * FROM sensor_readings ORDER BY measured_at DESC LIMIT 1')).rows[0]; return r ? this.row(r) : null; }
  async history(range, now = Date.now()) {
    const { start, end, bucket } = windowFor(range, now);
    const { rows } = await this.pool.query(`SELECT to_timestamp(floor(extract(epoch from measured_at)/$1)*$1) AS measured_at,
      ${metrics.map(k => `avg(${k}) AS ${k}`).join(', ')} FROM sensor_readings
      WHERE measured_at >= $2 AND measured_at <= $3 GROUP BY 1 ORDER BY 1`, [bucket, new Date(start).toISOString(), new Date(end).toISOString()]);
    return { range, bucketSeconds: bucket, points: rows.map(r => this.row(r)) };
  }
  async close() { await this.pool.end(); }
}
module.exports = { MemoryStore, PostgresStore, ranges };
