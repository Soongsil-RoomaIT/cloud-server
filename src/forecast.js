const fs = require('node:fs/promises');
const path = require('node:path');

const STEP_MS = 10 * 60000;
const HORIZON_MS = 60 * 60000;
const HISTORY_BUCKETS = 12;
const METRICS = ['temperature', 'humidity'];
const MAE_WINDOW_MS = 24 * HORIZON_MS;

function bucketAverages(readings) {
  const buckets = new Map();
  for (const reading of readings) {
    const end = Math.ceil(Date.parse(reading.measuredAt) / STEP_MS) * STEP_MS;
    if (!buckets.has(end)) buckets.set(end, METRICS.map(() => ({ sum: 0, count: 0 })));
    const bucket = buckets.get(end);
    METRICS.forEach((name, index) => {
      if (Number.isFinite(reading[name])) {
        bucket[index].sum += reading[name];
        bucket[index].count++;
      }
    });
  }
  return new Map([...buckets].map(([end, bucket]) => [
    end, bucket.map(value => value.count >= 2 ? value.sum / value.count : null),
  ]));
}

async function settleForecasts(store, end) {
  const latest = await store.latestForecast();
  if (!latest) return;
  // Select by target time. Forecasts that already fell outside the 24 hour
  // evaluation window do not affect the current comparison.
  const due = await store.forecastsBetween(end - MAE_WINDOW_MS - HORIZON_MS, end - HORIZON_MS);
  const pending = due.filter(row => row.metrics.some(metric =>
    METRICS.includes(metric.metric) && !Number.isFinite(metric.actual)));
  const targets = pending.map(row => Date.parse(row.targetAt));
  const actuals = targets.length
    ? bucketAverages(await store.forecastReadings(Math.min(...targets) - STEP_MS, Math.max(...targets)))
    : new Map();

  const updates = new Map();
  const errors = Object.fromEntries(METRICS.map(name => [name, { model: 0, baseline: 0, count: 0 }]));
  for (const row of due) {
    const actual = actuals.get(Date.parse(row.targetAt));
    const metrics = row.metrics.map(metric => {
      const measured = actual?.[METRICS.indexOf(metric.metric)];
      if (!Number.isFinite(metric.actual) && Number.isFinite(measured)) return { ...metric, actual: measured };
      return metric;
    });
    if (metrics.some((metric, index) => metric !== row.metrics[index])) {
      updates.set(row.generatedAt, { generatedAt: row.generatedAt, metrics });
    }
    if (row.modelVersion !== latest.modelVersion) continue;
    for (const metric of metrics) {
      const summary = Object.hasOwn(errors, metric.metric) ? errors[metric.metric] : null;
      if (!summary || ![metric.actual, metric.predicted, metric.baseline].every(Number.isFinite)) continue;
      summary.model += Math.abs(metric.actual - metric.predicted);
      summary.baseline += Math.abs(metric.actual - metric.baseline);
      summary.count++;
    }
  }

  const current = updates.get(latest.generatedAt)?.metrics ?? latest.metrics;
  const metrics = current.map(metric => {
    if (!Object.hasOwn(errors, metric.metric)) return metric;
    const { model, baseline, count } = errors[metric.metric];
    const mae = count ? model / count : null;
    const baselineMae = count ? baseline / count : null;
    if (metric.mae === mae && metric.baselineMae === baselineMae) return metric;
    return { ...metric, mae, baselineMae };
  });
  if (metrics.some((metric, index) => metric !== current[index])) {
    updates.set(latest.generatedAt, { generatedAt: latest.generatedAt, metrics });
  }
  if (updates.size) await store.updateForecastMetrics([...updates.values()]);
}

async function createForecastRunner(modelPath) {
  if (!modelPath) return null;
  const source = await fs.readFile(path.resolve(__dirname, '..', modelPath), 'utf8');
  const model = JSON.parse(source);
  if (model?.schemaVersion !== 1 || typeof model.modelVersion !== 'string' || !model.modelVersion ||
      !METRICS.every(name => {
        const metric = model.metrics?.[name];
        return Number.isFinite(metric?.intercept) &&
          Array.isArray(metric.coefficients) &&
          metric.coefficients.length === HISTORY_BUCKETS * METRICS.length &&
          metric.coefficients.every(Number.isFinite);
      })) {
    throw new Error('FORECAST_MODEL_PATH points to an incompatible forecast model');
  }

  let lastSavedAt;
  return async (store, now = Date.now()) => {
    const end = Math.floor(now / STEP_MS) * STEP_MS;
    if (lastSavedAt !== end) {
      const start = end - HISTORY_BUCKETS * STEP_MS;
      const averages = bucketAverages(await store.forecastReadings(start, end));
      // Match Python's right-closed buckets (t-10 minutes, t], newest first.
      const features = Array.from({ length: HISTORY_BUCKETS }, (_, i) =>
        averages.get(end - i * STEP_MS) ?? [null, null]).flat();
      if (features.every(Number.isFinite)) {
        const metrics = METRICS.map((metric, index) => {
          const { intercept, coefficients } = model.metrics[metric];
          const predicted = coefficients.reduce((sum, weight, i) => sum + weight * features[i], intercept);
          if (!Number.isFinite(predicted)) throw new Error('Non-finite forecast');
          return { metric, predicted, baseline: features[index], actual: null, mae: null, baselineMae: null };
        });
        await store.saveForecast({
          generatedAt: new Date(end).toISOString(), targetAt: new Date(end + HORIZON_MS).toISOString(),
          controlEnabled: false, modelVersion: model.modelVersion, message: null, metrics,
        });
        lastSavedAt = end;
      }
    }
    await settleForecasts(store, end);
  };
}

module.exports = { createForecastRunner };
