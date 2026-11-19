const { z } = require('zod');

const timestamp = z.string().datetime({ offset: true }).transform(s => new Date(s).toISOString());
const reading = z.object({
  measuredAt: timestamp, 
  temperature: z.number().min(-80).max(100).nullable().default(null),
  humidity: z.number().min(0).max(100).nullable().default(null), 
  co2: z.number().min(0).max(100000).nullable().default(null),
  pm25: z.number().min(0).max(10000).nullable().default(null), 
  pm10: z.number().min(0).max(10000).nullable().default(null),
}).strict();
const deviceState = z.enum(['OPEN', 'CLOSED', 'ON', 'OFF']);
const action = z.enum(['OPEN', 'CLOSE', 'ON', 'OFF']);
const stateSource = z.enum(['SENSOR', 'COMMANDED', 'ASSUMED']);
const deviceUpdate = z.object({
  id: z.string().max(80), state: deviceState, updatedAt: timestamp,
  stateSource: stateSource.optional(), autoCloseAt: timestamp.nullable().optional(),
}).strict();
const localAction = z.object({ executedAt: timestamp, deviceId: z.string().max(80), state: deviceState, reason: z.string().min(1).max(500) }).strict();
const recovery = z.object({ offlineSince: timestamp, recoveredAt: timestamp, localActions: z.array(localAction).max(1000) }).strict()
  .refine(r => r.offlineSince <= r.recoveredAt && r.localActions.every(a => a.executedAt >= r.offlineSince && a.executedAt <= r.recoveredAt), 'Invalid recovery timeline');
const edgeStatus = z.object({ online: z.boolean(), offlineMode: z.boolean() }).strict();
const ack = z.object({ commandId: z.string().uuid(), status: z.enum(['EXECUTED', 'FAILED']), reason: z.string().max(500), executedAt: timestamp, stateSource: stateSource.optional() }).strict();
const settings = z.object({
  enabled: z.boolean(), mode: z.enum(['AUTO', 'APPROVAL']),
  humidityOn: z.number().min(30).max(95), humidityOff: z.number().min(20).max(90),
  co2Open: z.number().min(400).max(5000), pm25On: z.number().min(1).max(500),
  rainProbability: z.number().min(0).max(100),
  temperatureHigh: z.number().min(15).max(40).optional(),
  pm10Bad: z.number().min(1).max(1000).optional(),
}).strict().refine(s => s.humidityOff < s.humidityOn, 'humidityOff must be below humidityOn');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function stateFor(action) { return action === 'CLOSE' ? 'CLOSED' : action; }
function validState(device, state) {
  return (['WINDOW', 'FRONT_DOOR'].includes(device.type) ? ['OPEN', 'CLOSED'] : ['ON', 'OFF']).includes(state);
}

module.exports = { z, timestamp, reading, action, deviceUpdate, recovery, edgeStatus, ack, settings, ApiError, stateFor, validState };
