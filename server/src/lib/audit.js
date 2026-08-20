'use strict';

const db = require('./db');

/** 감사 로그 기록. 실패해도 본 요청은 막지 않는다. */
/**
 * @param {object} opts
 *   actorId / actorName : 로그인 전 동작(로그인 실패·비밀번호 재설정 등)에서
 *     req.user 가 없을 때 '누가' 를 직접 넘긴다. 안 넘기면 로그인한 사람으로 남는다.
 */
async function log(req, action, {
  targetType = null, targetId = null, detail = null, actorId, actorName,
} = {}) {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    await db.query(
      `INSERT INTO wr.audit_logs (user_id, username, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user?.id ?? actorId ?? null, req.user?.username ?? actorName ?? null,
       action, targetType, targetId, detail, ip]
    );
  } catch (err) {
    console.error('[audit] 기록 실패:', err.message);
  }
}

module.exports = { log };
