'use strict';

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const config = require('../lib/config');
const mailer = require('../lib/mailer');
const crypto = require('crypto');

const router = express.Router();

// 단순 브루트포스 방어: username 당 실패 카운트 (프로세스 메모리)
const failures = new Map();
const MAX_FAIL = 10;
const LOCK_MS = 5 * 60 * 1000;

function checkLock(username) {
  const f = failures.get(username);
  if (!f) return null;
  if (Date.now() - f.at > LOCK_MS) { failures.delete(username); return null; }
  return f.count >= MAX_FAIL ? Math.ceil((LOCK_MS - (Date.now() - f.at)) / 1000) : null;
}

function noteFailure(username) {
  const f = failures.get(username);
  if (!f || Date.now() - f.at > LOCK_MS) failures.set(username, { count: 1, at: Date.now() });
  else { f.count++; f.at = Date.now(); }
}

// ---------------------------------------------------------------------
// 비로그인 공개 엔드포인트(가입/아이디찾기/비번찾기)용 IP 기준 속도 제한
// ---------------------------------------------------------------------
const ipHits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    const key = `${req.path}|${ip}`;
    const now = Date.now();
    const h = ipHits.get(key);
    if (!h || now - h.at > windowMs) {
      ipHits.set(key, { count: 1, at: now });
    } else if (++h.count > max) {
      return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }
    // 메모리 누수 방지: 가끔 오래된 항목 정리
    if (ipHits.size > 5000) {
      for (const [k, v] of ipHits) if (now - v.at > windowMs) ipHits.delete(k);
    }
    next();
  };
}

/** 눈으로 읽고 옮겨 적기 쉬운 임시 비밀번호 (혼동되는 O/0, l/1, I 제외) */
function makeTempPassword(len = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(len);
  return Array.from(buf, (b) => chars[b % chars.length]).join('');
}

/** 아이디 일부를 가린다: bimatrix01 → bi******01 */
/** 아이디 가운데 두 글자만 가린다. (예: hung6789 → hu**6789) */
function maskUsername(u) {
  if (u.length <= 2) return u[0] + '*';
  if (u.length <= 4) return u[0] + '**' + u.slice(3);
  // 가운데 자리에서 두 글자를 가린다
  const at = Math.max(1, Math.round((u.length - 2) / 2));
  return u.slice(0, at) + '**' + u.slice(at + 2);
}

// ---------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------
router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    }

    const lockedFor = checkLock(username);
    if (lockedFor) {
      return res.status(429).json({ error: `로그인 시도가 많습니다. ${lockedFor}초 후 다시 시도하세요.` });
    }

    const { rows } = await db.query(
      `SELECT u.*, o.name AS org_name
         FROM wr.users u
         LEFT JOIN wr.organizations o ON o.id = u.org_id
        WHERE lower(u.username) = lower($1)`,
      [username]
    );
    const user = rows[0];

    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      noteFailure(username);
      await audit.log(req, 'LOGIN_FAIL', { detail: username, actorName: username });
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    // 비밀번호는 맞지만 아직 쓸 수 없는 계정 — 사유를 정확히 알려준다
    if (user.approval_status === 'PENDING') {
      return res.status(403).json({ error: '가입 승인 대기 중입니다. 관리자 승인 후 이용할 수 있습니다.' });
    }
    if (user.approval_status === 'REJECTED') {
      return res.status(403).json({ error: '가입이 반려된 계정입니다. 관리자에게 문의하세요.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: '정지된 계정입니다. 관리자에게 문의하세요.' });
    }

    failures.delete(username);
    auth.setSessionCookie(res, user);
    await db.query(`UPDATE wr.users SET last_login_at = now() WHERE id = $1`, [user.id]);

    req.user = user;
    await audit.log(req, 'LOGIN', { targetType: 'user', targetId: user.id });

    res.json({
      user: {
        id: user.id, username: user.username, name: user.name, role: user.role,
        org_id: user.org_id, org_name: user.org_name, must_change_pw: user.must_change_pw,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------
router.post('/logout', async (req, res) => {
  if (req.user) await audit.log(req, 'LOGOUT', { targetType: 'user', targetId: req.user.id });
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------
// POST /api/auth/password  (본인 비밀번호 변경)
// ---------------------------------------------------------------------
router.post('/password', auth.requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body?.current_password || '');
    const next_ = String(req.body?.new_password || '');

    if (next_.length < 8) {
      return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다.' });
    }

    const { rows } = await db.query(`SELECT password_hash FROM wr.users WHERE id = $1`, [req.user.id]);
    if (!rows[0] || !auth.verifyPassword(current, rows[0].password_hash)) {
      return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
    }

    await db.query(
      `UPDATE wr.users SET password_hash = $1, must_change_pw = FALSE WHERE id = $2`,
      [auth.hashPassword(next_), req.user.id]
    );
    await audit.log(req, 'PASSWORD_CHANGE', { targetType: 'user', targetId: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/auth/move-preview?to_org_id=N
//   소속을 옮길 때 함께 이동할 수 있는 "내가 작성한 보고서" 수를 미리 알려준다.
//   같은 주차에 대상 기관 보고서가 이미 있으면 옮길 수 없으므로 따로 센다.
// ---------------------------------------------------------------------
router.get('/move-preview', auth.requireAuth, async (req, res, next) => {
  try {
    const toOrg = Number(req.query.to_org_id);
    if (!toOrg || !req.user.org_id || toOrg === Number(req.user.org_id)) {
      return res.json({ total: 0, movable: 0, conflicts: [] });
    }

    const { rows } = await db.query(
      `SELECT r.id, w.label,
              EXISTS (SELECT 1 FROM wr.reports r2
                       WHERE r2.org_id = $1 AND r2.week_id = r.week_id) AS conflict
         FROM wr.reports r
         JOIN wr.report_weeks w ON w.id = r.week_id
        WHERE r.author_id = $2 AND r.org_id = $3
        ORDER BY w.start_date DESC`,
      [toOrg, req.user.id, req.user.org_id]
    );

    res.json({
      total: rows.length,
      movable: rows.filter((r) => !r.conflict).length,
      conflicts: rows.filter((r) => r.conflict).map((r) => r.label),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// PUT /api/auth/profile  — 내 정보 수정 (이름·이메일·연락처·소속)
//   아이디와 권한(role)은 여기서 바꿀 수 없다.
// ---------------------------------------------------------------------
router.put('/profile', auth.requireAuth, async (req, res, next) => {
  try {
    const name  = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const orgId = req.body?.org_id ? Number(req.body.org_id) : null;

    if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
    if (name.length > 50) return res.status(400).json({ error: '이름이 너무 깁니다.' });
    // 이메일은 선택 입력. 적었다면 형태만 확인한다.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '올바른 이메일을 입력하세요.' });
    }
    if (phone && phone.length > 30) return res.status(400).json({ error: '연락처가 너무 깁니다.' });

    // 일반 사용자는 소속이 반드시 있어야 하고, 사용 중인 기관만 선택할 수 있다
    if (req.user.role !== 'ADMIN' && !orgId) {
      return res.status(400).json({ error: '소속 기관을 선택하세요.' });
    }
    if (orgId) {
      const { rows: org } = await db.query(
        `SELECT id FROM wr.organizations WHERE id = $1 AND is_active = TRUE`, [orgId]
      );
      if (!org[0]) return res.status(400).json({ error: '선택할 수 없는 기관입니다.' });
    }

    const before = req.user;
    const changedOrgNow = Number(before.org_id) !== Number(orgId);
    const moveReports = changedOrgNow && req.body?.move_reports === true && before.org_id;
    let moved = 0, skipped = 0;

    const { rows } = await db.tx(async (client) => {
      if (moveReports) {
        // 같은 주차에 대상 기관 보고서가 이미 있으면 UNIQUE 제약에 걸리므로 제외한다
        const r = await client.query(
          `UPDATE wr.reports SET org_id = $1
            WHERE author_id = $2 AND org_id = $3
              AND NOT EXISTS (
                    SELECT 1 FROM wr.reports r2
                     WHERE r2.org_id = $1 AND r2.week_id = wr.reports.week_id)
            RETURNING id`,
          [orgId, req.user.id, before.org_id]
        );
        moved = r.rowCount;
        const left = await client.query(
          `SELECT count(*)::int AS c FROM wr.reports WHERE author_id = $1 AND org_id = $2`,
          [req.user.id, before.org_id]
        );
        skipped = left.rows[0].c;
      }
      return client.query(
        `UPDATE wr.users SET name = $1, email = $2, phone = $3, org_id = $4
          WHERE id = $5
          RETURNING id, username, name, email, phone, role, org_id`,
        [name, email, phone || null, orgId, req.user.id]
      );
    });

    const { rows: full } = await db.query(
      `SELECT u.id, u.username, u.name, u.email, u.phone, u.role, u.org_id,
              u.must_change_pw, o.name AS org_name
         FROM wr.users u LEFT JOIN wr.organizations o ON o.id = u.org_id
        WHERE u.id = $1`,
      [req.user.id]
    );

    await audit.log(req, 'PROFILE_UPDATE', {
      targetType: 'user', targetId: req.user.id,
      detail: changedOrgNow
        ? `소속 변경: ${before.org_name || '없음'} → ${full[0].org_name || '없음'}`
          + (moveReports ? ` / 보고서 ${moved}건 이동${skipped ? `, ${skipped}건 잔류` : ''}` : '')
        : name,
    });

    res.json({ user: full[0], moved, skipped });
  } catch (err) { next(err); }
});

// =====================================================================
//  공개 엔드포인트 (로그인 전)
// =====================================================================

// ---------------------------------------------------------------------
// GET /api/auth/capabilities — 화면이 현재 서버 설정에 맞는 안내를 하도록
// ---------------------------------------------------------------------
router.get('/capabilities', (req, res) => {
  res.json({
    mail_enabled: mailer.isEnabled(),
    signup_auto_approve: config.signup.autoApprove,
    reset_token_minutes: config.smtp.resetTokenMinutes,
    reset_mode: mailer.isEnabled() ? 'EMAIL' : config.reset.fallback.toUpperCase(),
  });
});

// ---------------------------------------------------------------------
// GET /api/auth/signup-orgs  — 가입 화면의 기관 선택 목록
//   (기관명 외 정보는 노출하지 않는다)
// ---------------------------------------------------------------------
router.get('/signup-orgs', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name FROM wr.organizations WHERE is_active = TRUE ORDER BY sort_order, name`
    );
    res.json({ orgs: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/auth/signup  — 가입 신청 (관리자 승인 후 사용 가능)
// ---------------------------------------------------------------------
router.post('/signup', rateLimit(5, 10 * 60 * 1000), async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const name     = String(req.body?.name || '').trim();
    const email    = String(req.body?.email || '').trim();
    const phone    = String(req.body?.phone || '').trim();
    // 담당 역할 (총괄책임자 / 실무책임자 / 참여연구원)
    const DUTIES = ['LEAD', 'MANAGER', 'RESEARCHER'];
    const duty = DUTIES.includes(req.body?.duty) ? req.body.duty : null;
    const orgId    = Number(req.body?.org_id) || null;

    if (!/^[A-Za-z0-9._-]{4,50}$/.test(username)) {
      return res.status(400).json({ error: '아이디는 영문/숫자/._- 조합 4~50자여야 합니다.' });
    }
    if (password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
    if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
    // 이메일은 선택 입력. 적었다면 형태만 확인한다.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '올바른 이메일을 입력하세요.' });
    }
    if (!orgId) return res.status(400).json({ error: '기관을 선택하세요.' });
    if (!duty)  return res.status(400).json({ error: '담당 역할을 선택하세요.' });

    // 허용 도메인이 지정되어 있으면 해당 메일 주소만 가입할 수 있다
    const domains = config.signup.allowedEmailDomains;
    if (email && domains.length) {
      const d = email.split('@')[1].toLowerCase();
      if (!domains.includes(d)) {
        return res.status(400).json({
          error: `가입 가능한 이메일 도메인이 아닙니다. (${domains.map((x) => '@' + x).join(', ')})`,
        });
      }
    }

    const { rows: org } = await db.query(
      `SELECT id FROM wr.organizations WHERE id = $1 AND is_active = TRUE`, [orgId]
    );
    if (!org[0]) return res.status(400).json({ error: '선택할 수 없는 기관입니다.' });

    // 가입은 항상 USER 권한으로만 생성된다 (role 은 요청값을 신뢰하지 않음)
    const auto = config.signup.autoApprove;
    const { rows } = await db.query(
      `INSERT INTO wr.users
         (username, password_hash, name, email, phone, org_id, role, approval_status, duty, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'USER', $7::varchar, $8,
               CASE WHEN $7::varchar = 'APPROVED' THEN now() ELSE NULL END)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username`,
      [username, auth.hashPassword(password), name, email, phone || null, orgId,
       auto ? 'APPROVED' : 'PENDING', duty]
    );
    if (!rows[0]) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

    await audit.log(req, 'SIGNUP', {
      targetType: 'user', targetId: rows[0].id,
      actorId: rows[0].id, actorName: username,
      detail: `${username} (${auto ? '자동승인' : '승인대기'})`,
    });
    res.status(201).json({
      ok: true,
      auto_approved: auto,
      message: auto
        ? '가입이 완료되었습니다. 바로 로그인하실 수 있습니다.'
        : '가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.',
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/auth/find-id  — 이름 + 소속 기관으로 아이디 찾기 (일부 마스킹)
// ---------------------------------------------------------------------
router.post('/find-id', rateLimit(10, 10 * 60 * 1000), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const orgId = Number(req.body?.org_id) || null;
    if (!name || !orgId) return res.status(400).json({ error: '이름과 소속을 모두 선택하세요.' });

    // 같은 기관에 동명이인이 있으면 이름 뒤에 -A, -B 를 붙여 등록한다.
    // '홍길동' 으로 찾아도 '홍길동-A' 가 나오도록 함께 뒤진다.
    const base = name.replace(/[.^$*+?()[\]{}|\\-]/g, '\\$&');
    const { rows } = await db.query(
      `SELECT username, name, created_at, approval_status
         FROM wr.users
        WHERE (name = $1 OR name ~ ('^' || $3 || '-[A-Z]$')) AND org_id = $2
        ORDER BY name, id`,
      [name, orgId, base]
    );
    // 아이디 찾기는 로그인하지 않은 사람이 하는 동작이라
    // 누가 했는지 남기지 않는다. 화면에는 (비로그인) 으로 나온다.
    await audit.log(req, 'FIND_ID', {
      detail: `${name} / 기관 ${orgId} → ${rows.length}건`,
    });

    if (!rows.length) {
      return res.status(404).json({ error: '일치하는 가입 정보가 없습니다. 관리자에게 문의하세요.' });
    }
    res.json({
      accounts: rows.map((r) => ({
        name: r.name,
        username: maskUsername(r.username),
        created_at: r.created_at,
        pending: r.approval_status === 'PENDING',
      })),
      // 동명이인이 있으면 화면에서 이름을 함께 보여준다
      duplicated: rows.length > 1,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/auth/reset-request  — 비밀번호 재설정 요청
//   SMTP 설정됨  → 재설정 링크를 메일로 발송 (관리자 개입 불필요)
//   SMTP 미설정  → 요청만 접수하고 관리자가 임시 비밀번호 발급
// ---------------------------------------------------------------------
router.post('/reset-request', rateLimit(5, 10 * 60 * 1000), async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!username || !name) {
      return res.status(400).json({ error: '아이디와 이름을 모두 입력하세요.' });
    }

    // 아이디 + 이름으로 본인을 확인한다 (이메일은 받지 않는다)
    const { rows } = await db.query(
      `SELECT id, username, name, email FROM wr.users
        WHERE lower(username) = lower($1) AND name = $2`,
      [username, name]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: '일치하는 가입 정보가 없습니다. 관리자에게 문의하세요.' });
    }
    const user = rows[0];
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;

    // ---- 메일 발송 방식 ----
    if (mailer.isEnabled()) {
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const minutes = config.smtp.resetTokenMinutes;

      // 이전에 발급한 링크는 무효화한다
      await db.query(
        `UPDATE wr.password_reset_requests
            SET status = 'REJECTED', handled_at = now()
          WHERE user_id = $1 AND status = 'PENDING'`,
        [user.id]
      );
      const { rows: created } = await db.query(
        `INSERT INTO wr.password_reset_requests
           (user_id, requested_ip, token_hash, expires_at, delivery)
         VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, 'EMAIL')
         RETURNING id`,
        [user.id, ip, tokenHash, String(minutes)]
      );

      const base = config.baseUrl || `${req.protocol}://${req.get('host')}`;
      const link = `${base}/reset?token=${token}`;

      try {
        await mailer.sendPasswordReset({
          to: user.email, name: user.name, username: user.username, link, expireMinutes: minutes,
        });
      } catch (err) {
        console.error('[auth] 재설정 메일 발송 실패:', err.message);
        // 발송에 실패했으면 링크를 남겨두지 않고 관리자 처리로 돌린다
        await db.query(
          `UPDATE wr.password_reset_requests
              SET token_hash = NULL, expires_at = NULL, delivery = 'ADMIN' WHERE id = $1`,
          [created[0].id]
        );
        await audit.log(req, 'RESET_MAIL_FAIL', { targetType: 'user', targetId: user.id, detail: err.message,
          actorId: user.id, actorName: user.username });
        return res.json({
          ok: true, delivery: 'ADMIN',
          message: '메일 발송에 실패하여 요청이 접수되었습니다.\n관리자가 확인 후 연락드립니다.',
        });
      }

      await audit.log(req, 'RESET_MAIL_SENT', { targetType: 'user', targetId: user.id, detail: username,
        actorId: user.id, actorName: user.username });
      // 메일 주소는 일부만 노출
      const masked = user.email.replace(/^(.{1,2})[^@]*(@.*)$/, (m, a, b) => `${a}****${b}`);
      return res.json({
        ok: true, delivery: 'EMAIL',
        message: `${masked} 로 비밀번호 재설정 링크를 보냈습니다.\n메일함을 확인해 주세요. (${minutes}분 이내 유효)`,
      });
    }

    // ---- SMTP 미설정: 임시 비밀번호를 화면에 알려주는 방식 (기본) ----
    if (config.reset.fallback === 'direct') {
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const tempPassword = makeTempPassword();
      const minutes = config.reset.directMinutes;

      await db.tx(async (client) => {
        // 이전 요청 무효화
        await client.query(
          `UPDATE wr.password_reset_requests
              SET status = 'REJECTED', handled_at = now()
            WHERE user_id = $1 AND status = 'PENDING'`,
          [user.id]
        );
        // 임시 비밀번호를 실제 계정에 적용 (다음 로그인 시 변경 안내)
        await client.query(
          `UPDATE wr.users SET password_hash = $1, must_change_pw = FALSE WHERE id = $2`,
          [auth.hashPassword(tempPassword), user.id]
        );
        await client.query(
          `INSERT INTO wr.password_reset_requests
             (user_id, requested_ip, token_hash, expires_at, delivery)
           VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, 'DIRECT')`,
          [user.id, ip, tokenHash, String(minutes)]
        );
      });

      await audit.log(req, 'RESET_DIRECT', { targetType: 'user', targetId: user.id, detail: username,
        actorId: user.id, actorName: user.username });
      return res.json({
        ok: true, delivery: 'DIRECT',
        temp_password: tempPassword,
        username: user.username,
        expire_minutes: minutes,
        reset_url: `/reset?token=${token}`,
        message: '본인 확인이 완료되었습니다.',
      });
    }

    // ---- 관리자 처리 방식 (RESET_FALLBACK=admin) ----
    const { rows: dup } = await db.query(
      `SELECT id FROM wr.password_reset_requests WHERE user_id = $1 AND status = 'PENDING'`, [user.id]
    );
    if (!dup[0]) {
      await db.query(
        `INSERT INTO wr.password_reset_requests (user_id, requested_ip, delivery) VALUES ($1, $2, 'ADMIN')`,
        [user.id, ip]
      );
    }
    await audit.log(req, 'RESET_REQUEST', { targetType: 'user', targetId: user.id, detail: username,
      actorId: user.id, actorName: user.username });
    res.json({
      ok: true, delivery: 'ADMIN',
      message: '비밀번호 재설정 요청이 접수되었습니다.\n관리자가 확인 후 임시 비밀번호를 알려드립니다.',
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 재설정 토큰 조회 (유효한 PENDING 요청 1건)
// ---------------------------------------------------------------------
async function findByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(
    `SELECT r.id, r.user_id, r.delivery, u.username, u.name, u.password_hash
       FROM wr.password_reset_requests r
       JOIN wr.users u ON u.id = r.user_id
      WHERE r.token_hash = $1
        AND r.status = 'PENDING'
        AND r.used_at IS NULL
        AND r.expires_at > now()`,
    [hash]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// POST /api/auth/reset-verify  — 링크 유효성 확인 (화면 진입 시)
// ---------------------------------------------------------------------
router.post('/reset-verify', rateLimit(20, 10 * 60 * 1000), async (req, res, next) => {
  try {
    const row = await findByToken(String(req.body?.token || ''));
    if (!row) {
      return res.status(400).json({ error: '링크가 만료되었거나 이미 사용되었습니다. 비밀번호 찾기를 다시 진행하세요.' });
    }
    res.json({
      ok: true, username: row.username, name: row.name,
      // DIRECT 방식은 화면에 알려준 임시 비밀번호를 한 번 더 확인받는다
      require_temp_password: row.delivery === 'DIRECT',
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/auth/reset-complete  — 새 비밀번호 설정
// ---------------------------------------------------------------------
router.post('/reset-complete', rateLimit(10, 10 * 60 * 1000), async (req, res, next) => {
  try {
    const token = String(req.body?.token || '');
    const password = String(req.body?.new_password || '');
    if (password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });

    const row = await findByToken(token);
    if (!row) {
      return res.status(400).json({ error: '링크가 만료되었거나 이미 사용되었습니다. 비밀번호 찾기를 다시 진행하세요.' });
    }

    // DIRECT 방식이면 화면에 안내한 임시 비밀번호가 맞는지 확인
    if (row.delivery === 'DIRECT') {
      const temp = String(req.body?.temp_password || '');
      if (!temp) return res.status(400).json({ error: '임시 비밀번호를 입력하세요.' });
      if (!auth.verifyPassword(temp, row.password_hash)) {
        return res.status(400).json({ error: '임시 비밀번호가 올바르지 않습니다.' });
      }
      if (temp === password) {
        return res.status(400).json({ error: '임시 비밀번호와 다른 비밀번호를 사용하세요.' });
      }
    }

    await db.tx(async (client) => {
      await client.query(
        `UPDATE wr.users SET password_hash = $1, must_change_pw = FALSE WHERE id = $2`,
        [auth.hashPassword(password), row.user_id]
      );
      await client.query(
        `UPDATE wr.password_reset_requests
            SET status = 'DONE', used_at = now(), handled_at = now(), token_hash = NULL
          WHERE id = $1`,
        [row.id]
      );
    });

    await audit.log(req, 'RESET_COMPLETE', { targetType: 'user', targetId: row.user_id, detail: row.username,
      actorId: row.user_id, actorName: row.username });
    res.json({ ok: true, username: row.username, message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인하세요.' });
  } catch (err) { next(err); }
});

module.exports = router;
