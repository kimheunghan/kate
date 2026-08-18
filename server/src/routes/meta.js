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
    const limit = Math.min(Number(req.query.limit) || 60, 400);
    const { rows } = await db.query(
      `SELECT id, year, week_no, start_date, end_date, label, is_open
         FROM wr.report_weeks
        WHERE start_date <= (CURRENT_DATE + INTERVAL '28 days')
        ORDER BY start_date DESC
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
      `SELECT id, year, week_no, start_date, end_date, label, is_open
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
      `SELECT id, name, sort_order, is_active
         FROM wr.organizations
        WHERE is_active = TRUE
        ORDER BY sort_order, name`
    );
    res.json({ orgs: rows });
  } catch (err) { next(err); }
});

module.exports = router;
