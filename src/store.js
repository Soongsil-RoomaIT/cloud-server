const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

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
  constructor() { this.readings = new Map(); this.state = null; }
  async init() {}
  async save(state) { this.state = structuredClone(state); }
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
  async load() { return (await this.pool.query("SELECT payload FROM room_state WHERE id='room-1'")).rows[0]?.payload || null; }
  async save(state) {
    await this.pool.query("INSERT INTO room_state(id,payload) VALUES('room-1',$1::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()", [JSON.stringify(state)]);
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
