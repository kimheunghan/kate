'use strict';

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

// ---------------------------------------------------------------------
// 비밀번호 해싱 (Node 내장 scrypt - 네이티브 모듈 의존 없음)
// 저장 형식: scrypt$N$r$p$<salt-b64>$<hash-b64>
// ---------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// 세션 (서명된 쿠키 - 별도 세션 스토어 불필요)
// 형식: base64url(payloadJson).base64url(hmacSha256)
// ---------------------------------------------------------------------
function sign(data) {
  return crypto.createHmac('sha256', config.session.secret).update(data).digest('base64url');
}

function createToken(user) {
  const payload = {
    uid: user.id,
    un: user.username,
    role: user.role,
    org: user.org_id,
    exp: Math.floor(Date.now() / 1000) + config.session.ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  res.cookie(config.session.cookieName, createToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.secureCookie,
    maxAge: config.session.ttlSeconds * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.session.cookieName, { path: '/' });
}

// ---------------------------------------------------------------------
// 미들웨어
// ---------------------------------------------------------------------

/** 요청마다 req.user 를 채운다 (없으면 null). */
async function loadUser(req, res, next) {
  req.user = null;
  const payload = readToken(req.cookies?.[config.session.cookieName]);
  if (payload) {
    try {
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.name, u.email, u.phone, u.role, u.org_id, u.is_active,
                u.must_change_pw, u.approval_status, u.can_view_all, o.name AS org_name
           FROM wr.users u
           LEFT JOIN wr.organizations o ON o.id = u.org_id
          WHERE u.id = $1`,
        [payload.uid]
      );
      // 승인이 취소되거나 계정이 정지되면 기존 세션도 즉시 무효화된다
      if (rows[0] && rows[0].is_active && rows[0].approval_status === 'APPROVED') req.user = rows[0];
    } catch (err) {
      console.error('[auth] loadUser 실패:', err.message);
    }
  }
  next();
}

/** 로그인 필수 */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

/** 전체 관리자 필수 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: '총괄관리자 권한이 필요합니다.' });
  next();
}

/**
 * 관리자 화면 접근.
 *   총괄관리자 · 감독관리자 · 중복권한자만 들어온다.
 *   작성자와 기관관리자는 주간보고 화면만 쓴다.
 */
function requireManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const ok = req.user.role === 'ADMIN' || req.user.role === 'SUPERVISOR'
          || req.user.can_view_all === true;
  if (!ok) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  next();
}

/** 사용자·기관을 손대는 자리. 총괄관리자만. */
function requireUserManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: '사용자·기관을 관리할 권한이 없습니다.' });
  }
  next();
}

/**
 * 등록 현황(대상 인원·제출률)을 볼 수 있는가.
 *   조회 전용 권한(감독관리자·중복권한)은 주차별 현황판만 본다.
 */
function requireStatusView(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: '등록 현황을 볼 권한이 없습니다.' });
  }
  next();
}

/**
 * 기관을 가리지 않고 전체를 볼 수 있는가.
 *   총괄관리자 · 감독관리자, 그리고 '전체 조회' 겸직 권한을 받은 사람.
 *   겸직은 권한과 소속이 그대로라 참여 인력 집계에는 한 명으로 남는다.
 */
function seesAllOrgs(user) {
  return user.role === 'ADMIN' || user.role === 'SUPERVISOR' || user.can_view_all === true;
}

/** 기관 관리자는 자기 기관으로만 조회 범위를 제한한다. 전체를 보는 권한은 요청값 그대로. */
function scopeOrg(user, requestedOrgId) {
  if (user.role === 'ORG_ADMIN') return user.org_id || -1;
  return requestedOrgId ? Number(requestedOrgId) : null;
}

// ---------------------------------------------------------------------
// 최초 관리자 계정 부트스트랩
// ---------------------------------------------------------------------
async function ensureAdminAccount() {
  const { rows } = await db.query(`SELECT count(*)::int AS c FROM wr.users WHERE role = 'ADMIN'`);
  if (rows[0].c > 0) return;

  const pw = config.bootstrap.adminPassword;
  if (!pw) {
    console.warn('[auth] 관리자 계정이 없고 ADMIN_PASSWORD 도 비어 있습니다. .env 에 ADMIN_PASSWORD 를 설정 후 재기동하세요.');
    return;
  }
  await db.query(
    `INSERT INTO wr.users (username, password_hash, name, role, must_change_pw)
     VALUES ($1, $2, $3, 'ADMIN', FALSE)
     ON CONFLICT (username) DO NOTHING`,
    [config.bootstrap.adminUsername, hashPassword(pw), config.bootstrap.adminName]
  );
  console.log(`[auth] 초기 관리자 계정 생성: ${config.bootstrap.adminUsername}`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireAuth,
  requireAdmin,
  requireManager,
  requireUserManager,
  requireStatusView,
  seesAllOrgs,
  scopeOrg,
  ensureAdminAccount,
};
