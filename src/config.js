const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

function config(env = process.env) {
  const integer = (key, fallback, min = 1) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min) throw new Error(`Invalid ${key}`);
    return value;
  };
  const result = {
    host: env.HOST || '127.0.0.1', port: integer('PORT', 8081, 0),
    demo: (env.DEMO_MODE ?? 'true') === 'true',
    databaseUrl: env.DATABASE_URL || '',
    origins: (env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8081,http://127.0.0.1:8081').split(',').map(s => s.trim()),
    apiToken: env.API_BEARER_TOKEN || '',
    jwtIssuer: env.JWT_ISSUER_URI || '', jwtJwks: env.JWT_JWK_SET_URI || '', jwtAudience: env.JWT_AUDIENCE || 'room-care-api',
    allowedSubjects: (env.ROOM_ALLOWED_SUBJECTS || '').split(',').map(s=>s.trim()).filter(Boolean),
    notificationUrl: env.NOTIFICATION_SEND_URL || '', notificationUserId: env.NOTIFICATION_USER_ID || '',
    notificationTokenUrl: env.AUTOMATION_TOKEN_URL || '', notificationClientId: env.AUTOMATION_CLIENT_ID || 'room-care-automation', notificationClientSecret: env.AUTOMATION_CLIENT_SECRET || '',
    mqttUrl: env.MQTT_URL || '', mqttUsername: env.MQTT_USERNAME || '', mqttPassword: env.MQTT_PASSWORD || '',
    mqttPrefix: env.MQTT_TOPIC_PREFIX || 'roomcare/room-001', mqttProtocol: env.MQTT_PROTOCOL || 'edge-agent',
    heartbeatMs: 15000, edgeTimeoutMs: integer('EDGE_TIMEOUT_MS', 10000),
    commandTimeoutMs: integer('COMMAND_TIMEOUT_MS', 5000),
    airKey: env.AIRKOREA_SERVICE_KEY || '', airStation: env.AIRKOREA_STATION_NAME || '',
    kmaKey: env.KMA_SERVICE_KEY || '', kmaNx: env.KMA_NX || '60', kmaNy: env.KMA_NY || '127',
  };
  if (!['edge-agent', 'roomait-v1'].includes(result.mqttProtocol)) throw new Error('Invalid MQTT_PROTOCOL');
  if (result.demo && result.databaseUrl) throw new Error('Demo uses isolated memory storage. Clear DATABASE_URL or set DEMO_MODE=false.');
  if (!result.demo && (!result.databaseUrl || !result.mqttUrl)) {
    throw new Error('DEMO_MODE=false requires DATABASE_URL and MQTT_URL');
  }
  if(result.jwtIssuer&&(!result.jwtJwks||!result.allowedSubjects.length))throw new Error('JWT mode requires JWT_JWK_SET_URI and ROOM_ALLOWED_SUBJECTS');
  if(result.notificationUrl&&(!result.notificationUserId||!result.notificationTokenUrl||!result.notificationClientSecret||result.demo))throw new Error('Notification bridge requires live mode, target user and service-account configuration');
  if(result.notificationUrl&&result.jwtIssuer&&!result.allowedSubjects.includes(result.notificationUserId))throw new Error('Notification recipient must be a member of this room');
  if (env.NODE_ENV === 'production' && (!result.jwtIssuer || result.demo)) {
    throw new Error('Production requires JWT authentication and DEMO_MODE=false');
  }
  return result;
}
module.exports = { config };
