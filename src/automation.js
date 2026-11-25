const { ApiError, settings } = require('./validation');

const rules = {
  humidityHigh: { key: 'humidityOn', metric: 'humidity' },
  humidityLow: { key: 'humidityOff', metric: 'humidity' },
  temperatureHigh: { key: 'temperatureHigh', metric: 'temperature' },
  pm25Bad: { key: 'pm25On', metric: 'pm25' },
  pm10Bad: { key: 'pm10Bad', metric: 'pm10' },
  rainProbability: { key: 'rainProbability', metric: 'precipitationProb' },
};
const ruleKeys = Object.fromEntries(Object.entries(rules).map(([id, rule]) => [id, rule.key]));
const ruleIds = Object.fromEntries(Object.entries(ruleKeys).map(([id, key]) => [key, id]));
const metadata = () => ({ fields: {}, rules: {} });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function ruleEnabled(state, id) {
  return state.automationMeta.rules[id]?.enabled ?? true;
}

function automationView(state) {
  return {
    ...state.automationMeta.fields,
    enabled: state.settings.enabled,
    rules: Object.entries(rules).map(([id, rule]) => ({
      metric: rule.metric, ...state.automationMeta.rules[id],
      id, threshold: state.settings[rule.key], enabled: ruleEnabled(state, id),
    })),
  };
}

function automationUpdate(state, body) {
  if (!isObject(body)) throw new ApiError(400, '자동제어 설정은 객체 형식으로 보내 주세요.');
  const { enabled, rules: rows, ...fields } = body;
  const automationMeta = structuredClone(state.automationMeta);
  const next = { ...state.settings };
  if (Object.hasOwn(body, 'enabled')) {
    next.enabled = enabled;
    if (enabled === true) next.mode = 'AUTO';
  }
  const seen = new Set();

  function setThreshold(id, threshold) {
    if (seen.has(id)) throw new ApiError(400, id + ' 규칙이 중복되었습니다.');
    seen.add(id);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      throw new ApiError(400, id + ' 기준값에는 숫자를 입력하세요.');
    }
    next[ruleKeys[id]] = threshold;
  }

  if (Object.hasOwn(body, 'rules')) {
    if (!Array.isArray(rows)) throw new ApiError(400, 'rules는 규칙 목록이어야 합니다.');
    for (const row of rows) {
      if (!isObject(row) || !Object.hasOwn(rules, row.id)) throw new ApiError(400, '지원하는 규칙 ID를 확인하세요.');
      const { id, metric, threshold, enabled: active, ...extra } = row;
      if (Object.hasOwn(row, 'enabled') && typeof active !== 'boolean') {
        throw new ApiError(400, id + ' 규칙의 사용 여부는 true 또는 false여야 합니다.');
      }
      if (Object.hasOwn(row, 'metric') && (typeof metric !== 'string' || !metric.trim())) {
        throw new ApiError(400, id + ' 규칙의 센서 항목을 확인하세요.');
      }
      setThreshold(id, threshold);
      const supplied = { ...extra, ...(metric === undefined ? {} : { metric }), ...(active === undefined ? {} : { enabled: active }) };
      automationMeta.rules[id] = { ...automationMeta.rules[id], ...supplied };
    }
  } else {
    for (const [key, value] of Object.entries(fields)) {
      const id = Object.hasOwn(rules, key) ? key : Object.hasOwn(ruleIds, key) ? ruleIds[key] : null;
      if (id) {
        setThreshold(id, value);
        delete fields[key];
      }
    }
  }
  automationMeta.fields = { ...automationMeta.fields, ...fields };

  const parsed = settings.safeParse(next);
  if (!parsed.success) {
    const key = parsed.error.issues[0].path[0];
    if (key === 'enabled') throw new ApiError(400, '자동제어 사용 여부는 true 또는 false여야 합니다.');
    if (!key) throw new ApiError(400, '습도 하한은 습도 상한보다 낮아야 합니다.');
    throw new ApiError(400, (ruleIds[key] ?? key) + ' 기준값의 허용 범위를 확인하세요.');
  }
  return { settings: parsed.data, automationMeta };
}

module.exports = { ruleKeys, ruleEnabled, metadata, automationView, automationUpdate };
