'use strict';

const db = require('./db');

/** 감사 로그 기록. 실패해도 본 요청은 막지 않는다. */
async function log(req, action, { targetType = null, targetId = null, detail = null } = {}) {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    await db.query(
      `INSERT INTO wr.audit_logs (user_id, username, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user?.id || null, req.user?.username || null, action, targetType, targetId, detail, ip]
    );
  } catch (err) {
    console.error('[audit] 기록 실패:', err.message);
  }
}

module.exports = { log };
