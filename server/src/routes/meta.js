'use strict';

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');

// 이 라우터는 '/api' 에 마운트되므로 router.use(requireAuth) 를 쓰면
// 뒤에 마운트되는 다른 /api 라우터까지 이 게이트를 통과하게 된다.
// 마운트 순서에 의존하지 않도록 라우트마다 인증을 건다.
const router = express.Router();

// ---------------------------------------------------------------------
// GET /api/weeks?limit=60
//   기본: 오늘 기준 가까운 주차부터 최신순
// ---------------------------------------------------------------------
router.get('/weeks', auth.requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 400);
    // 시작한 주차만 최신순으로 준다.
    //  아직 오지 않은 주차는 쓸 일이 없는데 목록 위쪽을 채워서
    //  현재 주차가 한참 아래에 묻혔다. 이제 맨 위가 현재 주차다.
    // 향후 계획 칸에 쓸 '다음 주차' 기간도 함께 준다.
    //  목록에는 시작한 주차만 나오므로, 가장 최근 주차는 다음 주차를
    //  목록에서 찾을 수 없다. 그래서 여기서 붙여 보낸다.
    const { rows } = await db.query(
      `SELECT w.id, w.year, w.week_no, w.start_date, w.end_date, w.label,
              n.start_date AS next_start_date, n.end_date AS next_end_date
         FROM wr.report_weeks w
         LEFT JOIN LATERAL (
           SELECT start_date, end_date FROM wr.report_weeks x
            WHERE x.start_date > w.start_date
            ORDER BY x.start_date LIMIT 1
         ) n ON TRUE
        WHERE w.start_date <= CURRENT_DATE
        ORDER BY w.start_date DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ weeks: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/weeks/current  — 오늘이 속한 주차 (없으면 가장 최근 주차)
// ---------------------------------------------------------------------
router.get('/weeks/current', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, year, week_no, start_date, end_date, label
         FROM wr.report_weeks
        WHERE start_date <= CURRENT_DATE
        ORDER BY start_date DESC
        LIMIT 1`
    );
    res.json({ week: rows[0] || null });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/orgs
// ---------------------------------------------------------------------
router.get('/orgs', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, sort_order, is_active, is_signup_visible
         FROM wr.organizations
        WHERE is_active = TRUE
        ORDER BY sort_order, name`
    );
    res.json({ orgs: rows });
  } catch (err) { next(err); }
});

module.exports = router;
