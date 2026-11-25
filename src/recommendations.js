const { ApiError, settings } = require('./validation');
const { ruleKeys } = require('./automation');

function listRecommendations(service) {
  return service.tail.then(() => service.store.listRecommendations());
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

module.exports = { listRecommendations, actOnRecommendation };
