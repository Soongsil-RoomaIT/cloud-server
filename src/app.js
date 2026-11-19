const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const {bearer}=require('./auth');
const { ZodError } = require('zod');
const { listRecommendations, actOnRecommendation } = require('./recommendations');
const { ranges } = require('./store');
const { ApiError } = require('./validation');

function createApp(service, config) {
  const app = express(); app.disable('x-powered-by');
  app.use(cors({ origin(origin, done) { done(null, !origin || config.origins.includes(origin)); }, credentials: true }));
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api') || req.path === '/health') res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && !config.origins.includes(req.headers.origin)) return res.status(403).json({ message: '허용되지 않은 Origin입니다.' });
    next();
  });
  app.get('/health', (req,res) => res.json({ status: service.lastError || service.state.sensorIssue ? 'degraded' : 'ok', mode: config.demo ? 'demo' : 'live', storage: config.databaseUrl ? 'postgresql' : 'memory', edgeOnline: service.state.edge.online, transportReady: service.transport?.ready() || false, devicesConfirmed: service.state.confirmedDevices, issue: service.lastError || service.state.sensorIssue || null }));
  app.use('/api', async (req,res,next) => {try{req.user=await service.auth.verify(bearer(req));next();}catch(error){next(error);}});
  app.get('/api/sensors/latest', (req,res) => {
    if (!service.latest) return res.status(503).json({ message: '아직 센서 측정값을 수신하지 않았습니다.' });
    res.json(service.latest);
  });
  app.get('/api/sensors/history', async (req,res) => {
    const range = req.query.range ?? '24h';
    if (typeof range !== 'string' || !Object.hasOwn(ranges, range)) throw new ApiError(400, 'range는 1h, 24h, 7d 중 하나여야 합니다.');
    res.json(await service.store.history(range));
  });
  app.get('/api/devices', (req,res) => res.json(service.state.devices));
  app.get('/api/edge/status', (req,res) => res.json(service.state.edge));
  app.post('/api/devices/:id/commands', async (req,res) => res.status(202).json(await service.requestCommand(req.params.id, req.body, req.headers['idempotency-key'])));
  app.get('/api/commands', (req,res) => res.json([...service.state.commands].reverse()));
  app.get('/api/commands/:id', (req,res) => {
    const c = service.state.commands.find(c => c.id === req.params.id);
    if (!c) throw new ApiError(404, '명령을 찾을 수 없습니다.'); res.json(c);
  });
  app.get('/api/outdoor', (req,res) => res.json(service.weather.outdoor()));
  app.get('/api/forecast', async (req,res) => res.json(await service.forecast()));
  app.get('/api/recommendations', async (req,res) => res.json(await listRecommendations(service)));
  for (const action of ['apply', 'reject', 'revert']) {
    app.post('/api/recommendations/:id/' + action, async (req,res) =>
      res.json(await actOnRecommendation(service, req.params.id, action)));
  }
  app.post('/api/decisions/:id/approve', async (req,res) => res.status(202).json(await service.decide(req.params.id, true)));
  app.post('/api/decisions/:id/reject', async (req,res) => res.json(await service.decide(req.params.id, false)));
  app.get('/api/automation', async (req,res) => res.json(await service.automation()));
  app.put('/api/automation', async (req,res) => res.json(await service.updateAutomation(req.body)));
  app.get('/api/settings/automation', (req,res) => res.json(service.legacySettings()));
  app.put('/api/settings/automation', async (req,res) => res.json(await service.updateSettings(req.body)));
  app.get('/api/notifications', (req,res) => res.json([...service.state.notifications].reverse()));
  app.patch('/api/notifications/:id/read', async (req,res) => res.json(await service.run(() => {
    const n = service.state.notifications.find(n => n.id === req.params.id);
    if (!n) throw new ApiError(404, '알림을 찾을 수 없습니다.'); n.read = true; return n;
  })));
  if (config.demo) {
    app.get('/api/demo/decisions', (req,res) => res.json([...service.state.decisions].reverse()));
    app.post('/api/demo/:kind', async (req,res) => {
      if (!['sensors','devices','status','recovery'].includes(req.params.kind)) throw new ApiError(404, '지원하지 않는 데모 입력입니다.');
      await service.ingest(req.params.kind, req.body);
      if (req.params.kind === 'status') service.transport.paused = !req.body.online;
      res.status(204).end();
    });
    app.get('/demo', (req,res) => res.sendFile(path.join(__dirname, '../public/demo.html')));
  }
  app.use('/api', (req,res) => res.status(404).json({ message: 'API를 찾을 수 없습니다.' }));
  const frontend = path.join(__dirname, '../.local/frontend/dist');
  if (fs.existsSync(path.join(frontend, 'index.html'))) {
    app.use(express.static(frontend));
    app.get('/{*splat}', (req,res) => res.sendFile(path.join(frontend, 'index.html')));
  } else app.get('/', (req,res) => res.json({ success: true, message: 'CloudAIoT 서버 연결 성공', demo: '/demo', health: '/health', frontendSetup: 'npm run frontend:setup' }));
  app.use((err,req,res,next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ZodError) return res.status(400).json({ message: '입력값을 확인하세요.', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    const status = err.status || 500;
    if (status >= 500 && !(err instanceof ApiError)) service.lastError = '서버 처리 오류';
    res.status(status).json({ message: status >= 500 && !(err instanceof ApiError) ? '서버 처리 중 오류가 발생했습니다.' : err.message });
  });
  return app;
}
module.exports = { createApp };
