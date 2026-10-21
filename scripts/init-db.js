const { config } = require('../src/config');
const { PostgresStore } = require('../src/store');
(async () => {
  const c = config();
  if (!c.databaseUrl) throw new Error('DATABASE_URL을 설정하세요.');
  const store = new PostgresStore(c.databaseUrl);
  try { await store.init(); console.log('데이터베이스 스키마 준비 완료'); } finally { await store.close(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
