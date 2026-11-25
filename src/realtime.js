const { WebSocketServer, WebSocket } = require('ws');
const {bearer}=require('./auth');
const { isDeepStrictEqual } = require('node:util');

function attachRealtime(server, service, config) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384,
    verifyClient: async ({ origin,req },done) => {
      if(origin&&!config.origins.includes(origin))return done(false,403);
      // Optional upstream JWT authentication via the WebSocket handshake header.
      const token=bearer(req);
      if(!token)return done(true);
      try{req.authenticatedUser=await service.auth.verify(token);done(true);}catch{done(false,401);}
    } });
  wss.on('error', () => { service.lastError = 'WebSocket 서버 오류'; });
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) return socket.close(1013, 'Slow client');
    socket.send(JSON.stringify(message));
  };
  const broadcast = message => { for (const s of wss.clients) if (s.authenticated) send(s, message); };
  wss.on('connection', (socket,req) => {
    socket.authenticated = !service.auth.required || Boolean(req.authenticatedUser);
    let expiryTimer,authenticating=false;
    const expiry=user=>{if(user?.exp)expiryTimer=setTimeout(()=>socket.close(1008,'Token expired'),Math.max(1,Math.min(user.exp*1000-Date.now(),2147483647)));};
    expiry(req.authenticatedUser);
    if (socket.authenticated) send(socket, { type: 'edge.status', payload: service.state.edge });
    const authTimer = socket.authenticated ? null : setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    socket.on('message', async (raw, binary) => {
      if (binary) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (!socket.authenticated) {
        if(authenticating)return;
        if(message.type!=='auth')return socket.close(1008,'Authentication required');
        authenticating=true;
        let user;
        try{user=await service.auth.verify(message.payload?.token);}catch{return socket.close(1008,'Authentication failed');}
        if(socket.readyState!==WebSocket.OPEN)return;
        socket.authenticated = true; clearTimeout(authTimer);expiry(user);
        return send(socket, { type: 'edge.status', payload: service.state.edge });
      }
      if (message.type === 'ping') send(socket, { type: 'heartbeat' });
    });
    socket.on('close', () => {clearTimeout(authTimer);clearTimeout(expiryTimer);});
    socket.on('error', () => {});
  });
  service.on('message', broadcast);
  let lastForecast, pendingForecast;
  async function refreshForecast() {
    const forecast = await service.forecast();
    if (!isDeepStrictEqual(forecast, lastForecast)) {
      if (forecast.metrics.length || lastForecast) broadcast({ type: 'forecast.update', payload: forecast });
      lastForecast = forecast;
    }
  }
  const heartbeat = setInterval(() => {
    broadcast({ type: 'heartbeat' });
    if (pendingForecast || !Array.from(wss.clients).some(socket => socket.authenticated)) return;
    pendingForecast = refreshForecast()
      .catch(() => { service.lastError = '실내 예측 조회 오류'; })
      .finally(() => { pendingForecast = null; });
  }, config.heartbeatMs);
  return { wss, close: async () => {
    clearInterval(heartbeat); service.off('message', broadcast);
    for (const s of wss.clients) s.terminate();
    await new Promise(resolve => wss.close(resolve));
    await pendingForecast;
  } };
}
module.exports = { attachRealtime };
