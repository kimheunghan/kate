'use strict';

const { Pool, types } = require('pg');
const config = require('./config');

// DATE(oid 1082) 를 JS Date 로 변환하지 않고 'YYYY-MM-DD' 문자열 그대로 반환한다.
// 변환할 경우 서버 타임존이 적용되어 start_date 가 하루 밀려 보이는 문제가 생긴다.
types.setTypeParser(1082, (val) => val);
// NUMERIC(oid 1700) 은 정밀도 유지를 위해 문자열로 오므로, 이 앱에서는 숫자로 쓴다.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // 모든 커넥션이 wr 스키마를 기본으로 보도록
  options: `-c search_path=${config.db.schema},public`,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

/** 트랜잭션 헬퍼. fn(client) 이 throw 하면 자동 롤백. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** DB가 뜰 때까지 대기 (컨테이너 기동 순서 대응) */
async function waitForReady(retries = 30, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[db] 연결 성공');
      return;
    } catch (err) {
      console.log(`[db] 연결 대기 중 (${i}/${retries}): ${err.message}`);
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, query, tx, waitForReady };
