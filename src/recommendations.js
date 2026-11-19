const { randomUUID } = require('node:crypto');
const { ApiError, settings } = require('./validation');

const required = 10;
const { ruleKeys } = require('./automation');
const observations = {
  'dehumidifier-1': {
    ON: ['humidityHigh', 'humidity', '수동으로 제습기를 켠 시점의 습도 중앙값'],
    OFF: ['humidityLow', 'humidity', '수동으로 제습기를 끈 시점의 습도 중앙값'],
  },
  'purifier-1': { ON: ['pm25Bad', 'pm25', '수동으로 공기청정기를 켠 시점의 초미세먼지 중앙값'] },
};

function manualObservation(device, action, reading, now) {
  const rule = observations[device.id]?.[action];
  if (!rule || !reading || device.state === action) return null;
  const [metric, sensor, reason] = rule;
  const age = now - Date.parse(reading.measuredAt);
  if (age < 0 || age > 15000 || !Number.isFinite(reading[sensor])) return null;
  return { metric, value: reading[sensor], reason };
}

async function collectRecommendation(service, observation) {
  const { metric, value, reason } = observation;
  const samples = service.state.thresholdSamples[metric] ??= [];
  samples.push(value);
  if (samples.length < required) return;
  const sorted = samples.splice(0).sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const proposed = (sorted[middle - 1] + sorted[middle]) / 2;
  const key = ruleKeys[metric];
  const current = service.state.settings[key];
  if (proposed === current || !settings.safeParse({ ...service.state.settings, [key]: proposed }).success) return;
  const history = await service.store.listRecommendations();
  if (history.some(item => item.metric === metric && item.status === 'PROPOSED')) return;
  const record = { id: randomUUID(), metric, current, proposed, status: 'PROPOSED', evidenceCount: sorted.length,
    reason, createdAt: new Date().toISOString(), appliedAt: null };
  service.recommendationChange = { record, previous: null };
  service.event('recommendation.new', record);
}

function listRecommendations(service) {
  return service.tail.then(async () => {
    const count = Math.max(0, ...Object.values(service.state.thresholdSamples).map(samples => samples.length));
    const items = await service.store.listRecommendations();
    return items.length ? items : { items, progress: { count, required } };
  });
}

function actOnRecommendation(service, id, action) {
  return service.run(async () => {
    const previous = (await service.store.listRecommendations()).find(row => row.id === id);
    if (!previous) throw new ApiError(404, '기준값 추천을 찾을 수 없습니다.');
    const reverting = action === 'revert';
    if (previous.status !== (reverting ? 'APPLIED' : 'PROPOSED')) {
      throw new ApiError(409, '이미 처리되었거나 현재 상태에서 수행할 수 없는 요청입니다.');
    }
    const record = { ...previous };
    if (action === 'reject') {
      record.status = 'REJECTED';
    } else {
      const key = ruleKeys[record.metric];
      const state = service.state;
      const owners = state.appliedThresholds[record.metric];
      const expected = reverting ? record.proposed : record.current;
      if (!Object.hasOwn(ruleKeys, record.metric) || state.settings[key] !== expected ||
          (reverting && owners && owners.at(-1) !== id)) {
        throw new ApiError(409, '기준값이 변경되었습니다. 최신 설정을 확인하세요.');
      }
      const next = { ...state.settings, [key]: reverting ? record.current : record.proposed };
      if (!settings.safeParse(next).success) throw new ApiError(409, '현재 다른 기준값과 함께 적용할 수 없습니다.');
      state.settings = next;
      if (reverting) {
        state.appliedThresholds[record.metric] = owners?.slice(0, -1) ?? [];
        record.status = 'REVERTED';
      } else {
        state.appliedThresholds[record.metric] = [...(owners ?? []), id];
        record.status = 'APPLIED';
        record.appliedAt = new Date().toISOString();
        service.notify(`${record.metric} 기준값을 ${record.current}에서 ${record.proposed}(으)로 변경했습니다.`, {
          title: '기준값 추천 적용', type: 'recommendation.applied',
          data: { recommendationId: record.id, metric: record.metric, previous: String(record.current), threshold: String(record.proposed) },
        });
      }
      service.evaluate();
    }
    service.recommendationChange = { record, previous };
    return record;
  });
}

module.exports = { manualObservation, collectRecommendation, listRecommendations, actOnRecommendation };
