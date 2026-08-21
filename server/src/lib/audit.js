'use strict';

const db = require('./db');
const config = require('./config');

/** 프록시를 거쳐도 실제 접속 주소가 나오게 한다 */
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || null;
}

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
    const ip = clientIp(req);

    const uid = req.user?.id ?? actorId ?? null;
    const uname = req.user?.username ?? actorName ?? null;

    // 이름도 함께 남긴다. 계정이 지워져도 누구였는지 알 수 있다.
    let display = req.user?.name ?? null;
    if (!display && (uid || uname)) {
      const { rows } = await db.query(
        `SELECT name FROM wr.users WHERE ($1::int IS NOT NULL AND id = $1)
                                     OR ($1::int IS NULL AND lower(username) = lower($2))
          LIMIT 1`,
        [uid, uname]
      );
      display = rows[0]?.name ?? null;
    }

    await db.query(
      `INSERT INTO wr.audit_logs (user_id, username, user_name, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uid, uname, display, action, targetType, targetId, detail, ip]
    );
  } catch (err) {
    console.error('[audit] 기록 실패:', err.message);
  }
}

/**
 * 보관 기간이 지난 활동 로그를 지운다.
 * @returns {Promise<number>} 지운 건수
 */
async function purgeOld() {
  const days = config.auditRetentionDays;
  if (!days || days <= 0) return 0;
  try {
    const { rowCount } = await db.query(
      `DELETE FROM wr.audit_logs WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    if (rowCount) console.log(`[audit] ${days}일이 지난 기록 ${rowCount}건 삭제`);
    return rowCount;
  } catch (err) {
    console.error('[audit] 오래된 기록 정리 실패:', err.message);
    return 0;
  }
}

/** 기동할 때 한 번, 그 뒤로는 하루에 한 번 정리한다 */
function startPurgeSchedule() {
  const days = config.auditRetentionDays;
  if (!days || days <= 0) {
    console.log('[audit] 활동 로그를 지우지 않습니다 (보관 기간 설정 없음)');
    return;
  }
  console.log(`[audit] 활동 로그 보관 기간: ${days}일`);
  purgeOld();
  const timer = setInterval(purgeOld, 24 * 60 * 60 * 1000);
  timer.unref();                       // 이 타이머 때문에 종료가 늦어지지 않게
}

module.exports = { log, purgeOld, startPurgeSchedule, clientIp };
