'use strict';

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

const router = express.Router();
// 관리자 화면은 전체 관리자 + 기관 관리자가 접근한다.
// 기관 관리자는 auth.scopeOrg() 로 자기 기관 범위로만 조회된다.
router.use(auth.requireManager);

/** 전체 관리자만 허용 (기관/주차/사용자 삭제 등 전역 설정) */
const adminOnly = auth.requireAdmin;
// 사용자·기관을 손대는 자리. 감독관리자는 조회만 하므로 여기서 막힌다.
const userManager = auth.requireUserManager;

const ROLES = ['ADMIN', 'SUPERVISOR', 'ORG_ADMIN', 'USER'];

/** 감독 기관(회원가입에 안 나오는 기관)인가. 이 기관 소속은 감독관리자로 둔다. */
async function isSupervisorOrg(orgId) {
  if (!orgId) return false;
  const { rows } = await db.query(
    `SELECT is_signup_visible FROM wr.organizations WHERE id = $1`, [Number(orgId)]
  );
  return rows[0] ? rows[0].is_signup_visible === false : false;
}

// =====================================================================
//  현황
// =====================================================================

// ---------------------------------------------------------------------
// GET /api/admin/status?week_id=&org_id=&status=&q=
//   선택 주차의 "사람별" 제출 현황. 미제출자까지 모두 나온다.
// ---------------------------------------------------------------------
router.get('/status', auth.requireStatusView, async (req, res, next) => {
  try {
    let weekId = Number(req.query.week_id);
    if (!weekId) {
      const { rows } = await db.query(
        `SELECT id FROM wr.report_weeks WHERE start_date <= CURRENT_DATE ORDER BY start_date DESC LIMIT 1`
      );
      weekId = rows[0]?.id;
    }
    if (!weekId) {
      return res.json({ week: null, rows: [], summary: { total: 0, submitted: 0, draft: 0, none: 0, rate: 0 }, byOrg: [] });
    }

    const { rows: wrows } = await db.query(
      `SELECT id, label, start_date, end_date FROM wr.report_weeks WHERE id = $1`, [weekId]
    );

    const orgId = auth.scopeOrg(req.user, req.query.org_id);
    const where = ['week_id = $1'];
    const params = [weekId];
    if (orgId) { params.push(orgId); where.push(`org_id = $${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`status = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      where.push(`(user_name ILIKE $${params.length} OR username ILIKE $${params.length})`);
    }

    const { rows } = await db.query(
      `SELECT s.*,
              -- 마지막 접속 IP. 사용자 정보에 남긴 값을 먼저 쓰고,
              -- 아직 없으면 활동 기록에서 찾는다.
              COALESCE(
                (SELECT u2.last_login_ip FROM wr.users u2 WHERE u2.id = s.user_id),
                (SELECT a.ip FROM wr.audit_logs a
                  WHERE a.user_id = s.user_id AND a.ip IS NOT NULL
                  ORDER BY a.created_at DESC LIMIT 1)
              ) AS last_ip
         FROM wr.v_submission_status s
        WHERE ${where.join(' AND ')}
        -- 기관 → 담당 역할(총괄책임자→실무책임자→참여연구원) → 이름(가나다)
        ORDER BY sort_order NULLS LAST, org_name, wr.duty_order(duty), user_name`,
      params
    );

    // 개인별 현황 뷰의 컬럼명(user_name)을 화면과 다른 보고서 API에서
    // 공통으로 사용하는 author_name으로 맞춘다.
    for (const row of rows) {
      row.author_name = row.user_name || row.author_name || null;
    }

    // 요약은 필터(상태·검색)와 무관하게 해당 주차 전체 기준으로 낸다
    const sumParams = [weekId];
    let sumWhere = 'week_id = $1';
    if (orgId) { sumParams.push(orgId); sumWhere += ` AND org_id = $${sumParams.length}`; }

    const { rows: sum } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'SUBMITTED')::int AS submitted,
              count(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
              count(*) FILTER (WHERE status = 'NONE')::int      AS none
         FROM wr.v_submission_status WHERE ${sumWhere}`,
      sumParams
    );
    const summary = sum[0];
    summary.rate = summary.total ? Math.round((summary.submitted / summary.total) * 100) : 0;

    // 기관별 소계
    const { rows: byOrg } = await db.query(
      `SELECT org_id, org_name, total_users, submitted, draft, none_cnt
         FROM wr.v_org_week_summary
        WHERE ${sumWhere}
        ORDER BY sort_order NULLS LAST, org_name`,
      sumParams
    );

    res.json({ week: wrows[0] || null, rows, summary, byOrg, scopedOrgId: orgId });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/admin/overview?weeks=8  — 최근 N주 × 기관별 제출 인원
// ---------------------------------------------------------------------
router.get('/overview', auth.requireMatrixView, async (req, res, next) => {
  try {
    const n = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 26);
    const { rows: weeks } = await db.query(
      `SELECT id, label, start_date
         FROM wr.report_weeks
        WHERE start_date <= CURRENT_DATE
        ORDER BY start_date DESC
        LIMIT $1`,
      [n]
    );
    if (!weeks.length) return res.json({ weeks: [], orgs: [], cells: {}, totals: {} });

    const weekIds = weeks.map((w) => w.id);
    const orgId = auth.scopeOrg(req.user, req.query.org_id);

    const params = [weekIds];
    let where = 'week_id = ANY($1::int[])';
    if (orgId) { params.push(orgId); where += ` AND org_id = $${params.length}`; }

    const { rows: cells } = await db.query(
      `SELECT week_id, org_id, org_name, sort_order, total_users, submitted, draft, none_cnt
         FROM wr.v_org_week_summary
        WHERE ${where}
        ORDER BY sort_order NULLS LAST, org_name`,
      params
    );

    const orgMap = new Map();
    const map = {};
    for (const c of cells) {
      if (c.org_id && !orgMap.has(c.org_id)) orgMap.set(c.org_id, { id: c.org_id, name: c.org_name });
      map[`${c.week_id}:${c.org_id}`] = c;
    }

    // 주차별 전체 합계
    const totals = {};
    for (const w of weeks) {
      const list = cells.filter((c) => c.week_id === w.id);
      totals[w.id] = {
        total_users: list.reduce((a, c) => a + c.total_users, 0),
        submitted: list.reduce((a, c) => a + c.submitted, 0),
        draft: list.reduce((a, c) => a + c.draft, 0),
      };
    }

    res.json({ weeks: weeks.reverse(), orgs: [...orgMap.values()], cells: map, totals });
  } catch (err) { next(err); }
});

// =====================================================================
//  기관 관리
// =====================================================================
router.get('/orgs', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*, (SELECT count(*)::int FROM wr.users u WHERE u.org_id = o.id) AS user_count,
                   (SELECT count(*)::int FROM wr.reports r WHERE r.org_id = o.id) AS report_count
         FROM wr.organizations o ORDER BY o.sort_order, o.name`
    );
    res.json({ orgs: rows });
  } catch (err) { next(err); }
});

router.post('/orgs', adminOnly, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '기관명을 입력하세요.' });
    const sort = Number(req.body?.sort_order) || 0;
    const { rows } = await db.query(
      `INSERT INTO wr.organizations (name, sort_order) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [name, sort]
    );
    if (!rows[0]) return res.status(409).json({ error: '이미 존재하는 기관명입니다.' });
    await audit.log(req, 'ORG_CREATE', { targetType: 'org', targetId: rows[0].id, detail: name });
    res.status(201).json({ org: rows[0] });
  } catch (err) { next(err); }
});

router.put('/orgs/:id(\\d+)', adminOnly, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE wr.organizations
          SET name = COALESCE($1, name),
              sort_order = COALESCE($2, sort_order),
              is_active = COALESCE($3, is_active)
        WHERE id = $4 RETURNING *`,
      [
        req.body?.name ? String(req.body.name).trim() : null,
        req.body?.sort_order != null ? Number(req.body.sort_order) : null,
        req.body?.is_active != null ? Boolean(req.body.is_active) : null,
        Number(req.params.id),
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: '기관을 찾을 수 없습니다.' });
    await audit.log(req, 'ORG_UPDATE', { targetType: 'org', targetId: rows[0].id, detail: rows[0].name });
    res.json({ org: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/orgs/:id(\\d+)', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(`SELECT count(*)::int AS c FROM wr.reports WHERE org_id = $1`, [id]);
    if (rows[0].c > 0) {
      return res.status(409).json({
        error: `이 기관에 등록된 보고서가 ${rows[0].c}건 있습니다. 삭제 대신 '비활성' 처리하세요.`,
      });
    }
    await db.query(`DELETE FROM wr.organizations WHERE id = $1`, [id]);
    await audit.log(req, 'ORG_DELETE', { targetType: 'org', targetId: id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =====================================================================
//  사용자 관리
// =====================================================================
router.get('/users', userManager, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.name, u.email, u.phone, u.role, u.org_id, u.is_active,
              u.must_change_pw, u.approval_status, u.duty, u.can_view_all,
              u.last_login_at, u.created_at, o.name AS org_name,
              (SELECT count(*)::int FROM wr.reports r
                WHERE r.author_id = u.id AND r.org_id = u.org_id) AS report_count
         FROM wr.users u LEFT JOIN wr.organizations o ON o.id = u.org_id
        WHERE ($1::int IS NULL OR u.org_id = $1::int)
          AND ($2::text IS NULL
               OR u.name ILIKE '%' || $2 || '%'
               OR u.username ILIKE '%' || $2 || '%'
               OR u.email ILIKE '%' || $2 || '%')
        -- 기관 → 담당 역할(총괄책임자→실무책임자→참여연구원) → 이름(가나다)
        ORDER BY o.sort_order NULLS LAST, o.name, wr.duty_order(u.duty), u.name, u.username`,
      [auth.scopeOrg(req.user, req.query.org_id),
       req.query.q ? String(req.query.q).trim() : null]
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

// =====================================================================
//  가입 승인 / 비밀번호 재설정 요청
// =====================================================================

// ---------------------------------------------------------------------
// GET /api/admin/approvals  — 대기 중인 가입 신청 + 재설정 요청
// ---------------------------------------------------------------------
router.get('/approvals', userManager, async (req, res, next) => {
  try {
    const { rows: signups } = await db.query(
      `SELECT u.id, u.username, u.name, u.email, u.phone, u.signup_note,
              u.approval_status, u.org_id, u.created_at, o.name AS org_name
         FROM wr.users u LEFT JOIN wr.organizations o ON o.id = u.org_id
        WHERE u.approval_status IN ('PENDING', 'REJECTED')
          AND ($1::int IS NULL OR u.org_id = $1::int)
        ORDER BY (u.approval_status = 'PENDING') DESC, u.created_at DESC
        LIMIT 200`,
      [auth.scopeOrg(req.user, null)]
    );
    const { rows: resets } = await db.query(
      `SELECT r.id, r.status, r.created_at, r.requested_ip,
              u.id AS user_id, u.username, u.name, u.email, o.name AS org_name
         FROM wr.password_reset_requests r
         JOIN wr.users u ON u.id = r.user_id
         LEFT JOIN wr.organizations o ON o.id = u.org_id
        WHERE r.status = 'PENDING'
          AND ($1::int IS NULL OR u.org_id = $1::int)
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [auth.scopeOrg(req.user, null)]
    );
    res.json({ signups, resets, pending: {
      signups: signups.filter((s) => s.approval_status === 'PENDING').length,
      resets: resets.length,
    } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/admin/users/:id/approval   { approve: true|false, org_id? }
// ---------------------------------------------------------------------
router.post('/users/:id(\\d+)/approval', userManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const approve = req.body?.approve !== false;
    const orgId = req.body?.org_id ? Number(req.body.org_id) : null;

    const { rows } = await db.query(
      `UPDATE wr.users
          SET approval_status = $1::varchar,
              org_id      = COALESCE($2::int, org_id),
              approved_at = now(),
              approved_by = $3,
              is_active   = ($1::varchar = 'APPROVED')
        WHERE id = $4
        RETURNING id, username, name, approval_status, org_id`,
      [approve ? 'APPROVED' : 'REJECTED', orgId, req.user.id, id]
    );
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    await audit.log(req, approve ? 'SIGNUP_APPROVE' : 'SIGNUP_REJECT', {
      targetType: 'user', targetId: id, detail: rows[0].username,
    });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/admin/reset-requests/:id  { password?, reject? }
//   password 를 주면 임시 비밀번호로 설정하고 요청을 완료 처리한다.
// ---------------------------------------------------------------------
router.post('/reset-requests/:id(\\d+)', userManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reject = req.body?.reject === true;
    const password = String(req.body?.password || '');

    const { rows: reqRows } = await db.query(
      `SELECT r.id, r.user_id, u.username
         FROM wr.password_reset_requests r JOIN wr.users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.status = 'PENDING'`,
      [id]
    );
    if (!reqRows[0]) return res.status(404).json({ error: '처리 대기 중인 요청이 아닙니다.' });

    if (reject) {
      await db.query(
        `UPDATE wr.password_reset_requests
            SET status = 'REJECTED', handled_at = now(), handled_by = $1 WHERE id = $2`,
        [req.user.id, id]
      );
      await audit.log(req, 'RESET_REJECT', { targetType: 'user', targetId: reqRows[0].user_id, detail: reqRows[0].username });
      return res.json({ ok: true, status: 'REJECTED' });
    }

    if (password.length < 8) return res.status(400).json({ error: '임시 비밀번호는 8자 이상이어야 합니다.' });

    await db.tx(async (client) => {
      await client.query(
        `UPDATE wr.users SET password_hash = $1, must_change_pw = FALSE WHERE id = $2`,
        [auth.hashPassword(password), reqRows[0].user_id]
      );
      await client.query(
        `UPDATE wr.password_reset_requests
            SET status = 'DONE', handled_at = now(), handled_by = $1 WHERE id = $2`,
        [req.user.id, id]
      );
    });

    await audit.log(req, 'RESET_DONE', { targetType: 'user', targetId: reqRows[0].user_id, detail: reqRows[0].username });
    res.json({ ok: true, status: 'DONE', username: reqRows[0].username });
  } catch (err) { next(err); }
});

/**
 * 같은 기관에 이름이 같은 사람이 이미 있는지 찾는다.
 * 아이디는 유일하지만 이름은 겹칠 수 있어, 현황 화면에서 누가 누구인지 구분되지 않는다.
 */
function baseName(name) {
  return String(name || '').replace(/-[A-Z]$/, '');   // '홍길동-B' → '홍길동'
}

async function findSameName(name, orgId, exceptId) {
  // 이름이 정확히 같은 경우뿐 아니라 이미 접미사가 붙은 동명이인(홍길동-A)도 함께 찾는다.
  // 그래야 세 번째 동명이인이 들어와도 -C 를 제안할 수 있다.
  const base = baseName(name);
  const { rows } = await db.query(
    `SELECT id, username, name, email
       FROM wr.users
      WHERE org_id = $1
        AND (name = $2 OR name ~ ('^' || $2 || '-[A-Z]$'))
        AND ($3::int IS NULL OR id <> $3::int)
      ORDER BY id`,
    [orgId, base, exceptId || null]
  );
  return rows;
}

/** 동명이인 구분용 접미사 제안. 홍길동 → 홍길동-A / -B / -C … */
function suggestSuffixed(baseName, existing) {
  const used = new Set();
  for (const u of existing) {
    const m = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([A-Z])$`).exec(u.name);
    if (m) used.add(m[1]);
  }
  const next = (from) => {
    for (let c = from.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const ch = String.fromCharCode(c);
      if (!used.has(ch)) { used.add(ch); return ch; }
    }
    return null;
  };
  // 접미사 없는 기존 사용자가 있으면 그 사람을 -A 로, 새 사용자를 다음 글자로
  const plain = existing.find((u) => u.name === baseName);
  const renameExistingTo = plain ? `${baseName}-${next('A')}` : null;
  return { renameExistingTo, renameExistingId: plain ? plain.id : null,
           newName: `${baseName}-${next('A')}` };
}

router.post('/users', userManager, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    let role = ROLES.includes(req.body?.role) ? req.body.role : 'USER';
    let orgId = req.body?.org_id ? Number(req.body.org_id) : null;

    // 감독 기관 소속은 언제나 감독관리자
    if (await isSupervisorOrg(orgId)) role = 'SUPERVISOR';

    // 중복권한은 총괄관리자가 기관관리자에게만 준다.
    //  작성자는 본인 보고서만 다루고, 총괄·감독 관리자는 이미 전체를 본다.
    const canViewAll = req.user.role === 'ADMIN'
      && req.body?.can_view_all === true
      && role === 'ORG_ADMIN';

    // 기관관리자는 자기 기관에만, 그리고 작성자·기관관리자만 만들 수 있다
    if (req.user.role === 'ORG_ADMIN') {
      orgId = req.user.org_id;
      if (role !== 'USER' && role !== 'ORG_ADMIN') {
        return res.status(403).json({ error: '작성자 또는 기관관리자만 등록할 수 있습니다.' });
      }
    }

    // 비어 있는 것과 형식이 틀린 것을 구분해 안내한다 (회원가입과 같은 기준)
    if (!username) return res.status(400).json({ error: '아이디를 입력하세요.' });
    if (!/^[A-Za-z0-9._-]{4,50}$/.test(username)) {
      return res.status(400).json({ error: '아이디는 영문/숫자/._- 조합 4~50자여야 합니다.' });
    }
    if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
    if (!password) return res.status(400).json({ error: '초기 비밀번호를 입력하세요.' });
    if (password.length < 8) return res.status(400).json({ error: '초기 비밀번호는 8자 이상이어야 합니다.' });
    if (role !== 'ADMIN' && !orgId) return res.status(400).json({ error: '기관을 선택하세요.' });
    // 감독관리자는 참여 인력이 아니라 담당 역할이 없다
    if (role !== 'SUPERVISOR' && !['LEAD', 'MANAGER', 'RESEARCHER'].includes(req.body?.duty)) {
      return res.status(400).json({ error: '담당 역할을 선택하세요.' });
    }
    // 총괄책임자는 기관에 한 명뿐이라 기관관리자가 새로 지정하지 못한다
    if (req.user.role === 'ORG_ADMIN' && req.body?.duty === 'LEAD') {
      return res.status(403).json({ error: '총괄책임자는 총괄관리자가 지정합니다.' });
    }

    // 같은 기관 동명이인 확인 (allow_duplicate_name 이 true 면 그대로 진행)
    if (orgId && req.body?.allow_duplicate_name !== true) {
      const dup = await findSameName(name, orgId);
      if (dup.length) {
        return res.status(409).json({
          error: '같은 기관에 이름이 같은 사용자가 있습니다.',
          duplicate_name: true,
          duplicates: dup.map((d) => ({ id: d.id, username: d.username, name: d.name, email: d.email })),
          suggestion: suggestSuffixed(baseName(name), dup),
        });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO wr.users (username, password_hash, name, email, role, org_id, duty,
                             can_view_all, must_change_pw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, name, email, role, org_id, duty, can_view_all, is_active`,
      [username, auth.hashPassword(password), name, req.body?.email || null, role, orgId,
       (role !== 'SUPERVISOR' && ['LEAD', 'MANAGER', 'RESEARCHER'].includes(req.body?.duty))
         ? req.body.duty : null,
       canViewAll]
    );
    if (!rows[0]) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

    await audit.log(req, 'USER_CREATE', { targetType: 'user', targetId: rows[0].id, detail: username });
    res.status(201).json({ user: rows[0] });
  } catch (err) { next(err); }
});

router.put('/users/:id(\\d+)', userManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    let role = ROLES.includes(req.body?.role) ? req.body.role : null;

    // 감독 기관으로 옮기면 감독관리자가 된다
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'org_id')
        && await isSupervisorOrg(req.body?.org_id)) {
      role = 'SUPERVISOR';
    }

    if (req.user.role === 'ORG_ADMIN') {
      const { rows: t } = await db.query(`SELECT org_id, role FROM wr.users WHERE id = $1`, [id]);
      if (!t[0] || Number(t[0].org_id) !== Number(req.user.org_id)) {
        return res.status(403).json({ error: '다른 기관 사용자는 수정할 수 없습니다.' });
      }
      // 총괄·감독 관리자는 손대지도, 만들지도 못한다
      const heavy = (r) => r === 'ADMIN' || r === 'SUPERVISOR';
      if (heavy(t[0].role) || heavy(role)) {
        return res.status(403).json({ error: '총괄·감독 관리자 권한은 변경할 수 없습니다.' });
      }
    }

    // 마지막 관리자를 강등/비활성화하지 못하게 방어
    if (role === 'USER' || req.body?.is_active === false) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS c FROM wr.users WHERE role = 'ADMIN' AND is_active = TRUE AND id <> $1`, [id]
      );
      const { rows: target } = await db.query(`SELECT role, is_active FROM wr.users WHERE id = $1`, [id]);
      if (target[0]?.role === 'ADMIN' && target[0]?.is_active && rows[0].c === 0) {
        return res.status(409).json({ error: '마지막 총괄관리자 계정입니다. 다른 총괄관리자를 먼저 지정하세요.' });
      }
    }

    // 소속을 바꿀 때, 이 사용자가 이전 기관에서 쓴 보고서도 함께 옮길 수 있다.
    // (보고서는 작성 당시 소속을 스냅샷으로 갖고 있어 자동으로 따라가지 않는다)
    let movedReports = 0;
    const wantMove = req.body?.move_reports === true;
    const newOrgId = req.body?.org_id ? Number(req.body.org_id) : null;
    if (wantMove && newOrgId) {
      const { rows: before } = await db.query(`SELECT org_id FROM wr.users WHERE id = $1`, [id]);
      const oldOrgId = before[0]?.org_id;
      if (oldOrgId && Number(oldOrgId) !== newOrgId) {
        // 보고서 유일성은 (주차 × 작성자) 기준이라 기관을 옮겨도 충돌하지 않는다
        const mv = await db.query(
          `UPDATE wr.reports SET org_id = $1 WHERE author_id = $2 AND org_id = $3`,
          [newOrgId, id, oldOrgId]
        );
        movedReports = mv.rowCount;
      }
    }

    const DUTIES = ['LEAD', 'MANAGER', 'RESEARCHER'];
    let duty;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'duty')) {
      // 감독관리자는 참여 인력이 아니라 담당 역할이 없다
      if (req.body.role === 'SUPERVISOR') {
        duty = null;
      } else {
        if (!DUTIES.includes(req.body.duty)) {
          return res.status(400).json({ error: '담당 역할을 선택하세요.' });
        }
        // 총괄책임자는 기관에 한 명뿐이라 기관관리자가 새로 지정하지 못한다
        if (req.user.role === 'ORG_ADMIN' && req.body.duty === 'LEAD') {
          const { rows: cur } = await db.query(`SELECT duty FROM wr.users WHERE id = $1`, [id]);
          if (cur[0]?.duty !== 'LEAD') {
            return res.status(403).json({ error: '총괄책임자는 총괄관리자가 지정합니다.' });
          }
        }
        duty = req.body.duty;
      }
    }

    // 중복권한은 총괄관리자가 기관관리자에게만 준다
    let canViewAll;
    if (req.user.role === 'ADMIN'
        && Object.prototype.hasOwnProperty.call(req.body || {}, 'can_view_all')) {
      canViewAll = req.body.can_view_all === true;
    }
    if (canViewAll) {
      // 바꾸려는 권한이 없으면 지금 저장된 권한을 본다
      let target = role;
      if (!target) {
        const { rows: cur } = await db.query(`SELECT role FROM wr.users WHERE id = $1`, [id]);
        target = cur[0]?.role || null;
      }
      if (target !== 'ORG_ADMIN') canViewAll = false;
    }

    const { rows } = await db.query(
      `UPDATE wr.users
          SET name         = COALESCE($1, name),
              email        = COALESCE($2, email),
              role         = COALESCE($3, role),
              org_id       = CASE WHEN $4::boolean THEN $5::int ELSE org_id END,
              is_active    = COALESCE($6, is_active),
              duty         = CASE WHEN $8::boolean THEN $9::varchar ELSE duty END,
              can_view_all = COALESCE($10, can_view_all)
        WHERE id = $7
        RETURNING id, username, name, email, role, org_id, is_active, duty, can_view_all`,
      [
        req.body?.name ? String(req.body.name).trim() : null,
        req.body?.email ?? null,
        role,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'org_id'),
        req.body?.org_id ? Number(req.body.org_id) : null,
        req.body?.is_active != null ? Boolean(req.body.is_active) : null,
        id,
        duty !== undefined,
        duty ?? null,
        canViewAll ?? null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await audit.log(req, 'USER_UPDATE', {
      targetType: 'user', targetId: id,
      detail: rows[0].username + (movedReports ? ` / 보고서 ${movedReports}건 기관 이동` : ''),
    });
    res.json({ user: rows[0], moved_reports: movedReports });
  } catch (err) { next(err); }
});

router.post('/users/:id(\\d+)/password', userManager, async (req, res, next) => {
  try {
    if (req.user.role === 'ORG_ADMIN') {
      const { rows: t } = await db.query(`SELECT org_id FROM wr.users WHERE id = $1`, [Number(req.params.id)]);
      if (!t[0] || Number(t[0].org_id) !== Number(req.user.org_id)) {
        return res.status(403).json({ error: '다른 기관 사용자는 변경할 수 없습니다.' });
      }
    }
    const pw = String(req.body?.password || '');
    if (pw.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
    const { rows } = await db.query(
      `UPDATE wr.users SET password_hash = $1, must_change_pw = FALSE WHERE id = $2 RETURNING username`,
      [auth.hashPassword(pw), Number(req.params.id)]
    );
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await audit.log(req, 'USER_PASSWORD_RESET', {
      targetType: 'user', targetId: Number(req.params.id), detail: rows[0].username,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/users/:id(\\d+)', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
    const { rows } = await db.query(`DELETE FROM wr.users WHERE id = $1 RETURNING username`, [id]);
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    await audit.log(req, 'USER_DELETE', { targetType: 'user', targetId: id, detail: rows[0].username });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =====================================================================
//  보고서 소속 이관 (소속을 잘못 지정해 등록한 경우 바로잡기)
// =====================================================================
router.put('/reports/:id(\\d+)/org', userManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const toOrg = Number(req.body?.org_id);
    if (!toOrg) return res.status(400).json({ error: '옮길 기관을 선택하세요.' });

    const { rows: cur } = await db.query(
      `SELECT r.week_id, r.org_id, o.name AS org_name, w.label
         FROM wr.reports r
         JOIN wr.organizations o ON o.id = r.org_id
         JOIN wr.report_weeks w ON w.id = r.week_id
        WHERE r.id = $1`,
      [id]
    );
    if (!cur[0]) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
    if (Number(cur[0].org_id) === toOrg) return res.status(400).json({ error: '이미 해당 기관의 보고서입니다.' });

    const { rows: org } = await db.query(
      `SELECT name FROM wr.organizations WHERE id = $1 AND is_active = TRUE`, [toOrg]
    );
    if (!org[0]) return res.status(400).json({ error: '선택할 수 없는 기관입니다.' });

    // 같은 주차에 대상 기관 보고서가 이미 있으면 옮길 수 없다
    const { rows: dup } = await db.query(
      `SELECT id FROM wr.reports WHERE org_id = $1 AND week_id = $2`, [toOrg, cur[0].week_id]
    );
    if (dup[0]) {
      return res.status(409).json({
        error: `"${org[0].name}" 에는 ${cur[0].label} 보고서가 이미 있습니다. 먼저 정리한 뒤 옮기세요.`,
      });
    }

    await db.query(`UPDATE wr.reports SET org_id = $1 WHERE id = $2`, [toOrg, id]);
    await audit.log(req, 'REPORT_MOVE_ORG', {
      targetType: 'report', targetId: id,
      detail: `${cur[0].label} : ${cur[0].org_name} → ${org[0].name}`,
    });
    res.json({ ok: true, org_name: org[0].name });
  } catch (err) { next(err); }
});

// =====================================================================
//  주차 목록
// =====================================================================
router.get('/weeks', async (req, res, next) => {
  try {
    // 주차 자체가 사업 기간(~2027-03-31)까지만 만들어져 있으므로 전부 보여준다
    const { rows } = await db.query(
      `SELECT w.*, (SELECT count(*)::int FROM wr.reports r WHERE r.week_id = w.id) AS report_count
         FROM wr.report_weeks w
        ORDER BY w.start_date DESC
        LIMIT 200`
    );
    res.json({ weeks: rows });
  } catch (err) { next(err); }
});


// =====================================================================
//  감사 로그
// =====================================================================
// GET /api/admin/audit?page=&size=&from=&to=&action=&q=
//   from/to : 날짜 (YYYY-MM-DD). to 는 그날 끝까지 포함한다.
//   action  : 동작 코드 (LOGIN, REPORT_SAVE …)
//   q       : 사용자ID·이름·내용·IP 를 한 번에 훑는다
router.get('/audit', adminOnly, async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const size = Math.min(Math.max(Number(req.query.size) || 10, 1), 200);

    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('$$', `$${params.length}`)); };

    // 날짜만 오면 그날 처음·끝으로 넓힌다. 시각까지 오면 그대로 쓴다.
    const asStart = (v) => (String(v).includes('T') ? String(v) : `${v}T00:00:00`);
    const asEnd   = (v) => (String(v).includes('T') ? String(v) : `${v}T23:59:59`);
    if (req.query.from) add('a.created_at >= $$::timestamptz', asStart(req.query.from));
    if (req.query.to)   add('a.created_at <= $$::timestamptz', asEnd(req.query.to));
    if (req.query.action) add('a.action = $$', String(req.query.action));
    if (req.query.q) {
      const kw = `%${String(req.query.q).trim()}%`;
      params.push(kw);
      const n = params.length;
      where.push(`(a.username ILIKE $${n} OR COALESCE(a.user_name, u.name) ILIKE $${n}
                 OR a.detail ILIKE $${n} OR a.ip ILIKE $${n})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: cnt } = await db.query(
      `SELECT count(*)::int AS total
         FROM wr.audit_logs a LEFT JOIN wr.users u ON u.id = a.user_id ${whereSql}`,
      params
    );

    params.push(size, (page - 1) * size);
    const { rows } = await db.query(
      `SELECT a.id, a.username,
              -- 기록에 남은 이름을 먼저 쓴다 (계정이 지워져도 보인다)
              COALESCE(a.user_name, u.name) AS user_name,
              a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at
         FROM wr.audit_logs a
         LEFT JOIN wr.users u ON u.id = a.user_id
        ${whereSql}
        ORDER BY a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // 선택 상자에 채울 동작 목록 (기록에 실제로 남은 것만)
    const { rows: acts } = await db.query(
      `SELECT DISTINCT action FROM wr.audit_logs ORDER BY action`
    );

    res.json({ logs: rows, total: cnt[0].total, page, size, actions: acts.map((a) => a.action) });
  } catch (err) { next(err); }
});

module.exports = router;
