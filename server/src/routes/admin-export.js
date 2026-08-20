'use strict';

/* =====================================================================
   관리자 화면의 엑셀 내려받기
     /api/admin/export/status   등록 현황 (기관별 소계)
     /api/admin/export/matrix   주차별 현황판
     /api/admin/export/users    사용자 목록
     /api/admin/export/audit    활동 로그
   화면에 걸어 둔 조회 조건을 그대로 받아 같은 내용을 내려받는다.
   ===================================================================== */

const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

const router = express.Router();
router.use(auth.requireAuth, auth.requireAdmin);

const AUDIT_MAX = 5000;          // 활동 로그는 최신 이 건수까지만 내려받는다

/** 제목 줄 꾸미기 (가운데 정렬 · 연노랑 배경 · 굵게) */
function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, size: 11 };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
  row.height = 22;
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBDD' } };
    c.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' },
    };
  });
}

/** 내용 칸에 테두리 */
function styleBody(ws) {
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.eachCell((c) => {
      c.border = {
        top: { style: 'hair' }, bottom: { style: 'hair' },
        left: { style: 'hair' }, right: { style: 'hair' },
      };
      c.alignment = { vertical: 'middle', wrapText: true, ...(c.alignment || {}) };
    });
  });
}

/** 만든 파일을 내려보낸다 */
async function send(res, wb, name) {
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(Buffer.from(buf));
}

/** 파일 이름에 쓸 수 없는 글자 정리 */
const safeName = (v) => String(v || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------
// 등록 현황 — 기관별 소계
// ---------------------------------------------------------------------
router.get('/export/status', async (req, res, next) => {
  try {
    const q = new URLSearchParams();
    if (req.query.week_id) q.set('week_id', String(req.query.week_id));
    if (req.query.org_id) q.set('org_id', String(req.query.org_id));

    const weekId = Number(req.query.week_id) || null;
    const { rows: wrows } = await db.query(
      weekId
        ? `SELECT id, label FROM wr.report_weeks WHERE id = $1`
        : `SELECT id, label FROM wr.report_weeks WHERE start_date <= CURRENT_DATE
            ORDER BY start_date DESC LIMIT 1`,
      weekId ? [weekId] : []
    );
    const week = wrows[0];
    if (!week) return res.status(404).json({ error: '주차를 찾을 수 없습니다.' });

    const params = [week.id];
    let where = 'week_id = $1';
    if (req.query.org_id) { params.push(Number(req.query.org_id)); where += ` AND org_id = $${params.length}`; }

    const { rows } = await db.query(
      `SELECT org_name, sort_order,
              count(*)::int AS total_users,
              count(*) FILTER (WHERE status = 'SUBMITTED')::int AS submitted
         FROM wr.v_submission_status
        WHERE ${where}
        GROUP BY org_name, sort_order
        ORDER BY sort_order, org_name`,
      params
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('등록 현황');
    ws.columns = [
      { header: '기관', key: 'org', width: 28 },
      { header: '대상 인원', key: 'total', width: 12 },
      { header: '제출', key: 'sub', width: 10 },
      { header: '미등록', key: 'none', width: 10 },
      { header: '제출률', key: 'rate', width: 10 },
    ];
    rows.forEach((r) => ws.addRow({
      org: r.org_name || '(소속없음)',
      total: r.total_users,
      sub: r.submitted,
      none: r.total_users - r.submitted,
      rate: r.total_users ? `${Math.round((r.submitted / r.total_users) * 100)}%` : '0%',
    }));
    const tot = rows.reduce((a, r) => ({ t: a.t + r.total_users, s: a.s + r.submitted }), { t: 0, s: 0 });
    const last = ws.addRow({
      org: '전체', total: tot.t, sub: tot.s, none: tot.t - tot.s,
      rate: tot.t ? `${Math.round((tot.s / tot.t) * 100)}%` : '0%',
    });
    last.font = { bold: true };
    ['total', 'sub', 'none', 'rate'].forEach((k) => {
      ws.getColumn(k).alignment = { horizontal: 'center', vertical: 'middle' };
    });
    styleHeader(ws); styleBody(ws);

    const name = `${safeName(`등록현황_${week.label.replace(/\//g, '.')}`)}.xlsx`;
    await audit.log(req, 'EXPORT_STATUS', { detail: name });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 주차별 현황판
// ---------------------------------------------------------------------
router.get('/export/matrix', async (req, res, next) => {
  try {
    const n = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 26);
    const { rows: weeks } = await db.query(
      `SELECT id, label FROM wr.report_weeks
        WHERE start_date <= CURRENT_DATE ORDER BY start_date DESC LIMIT $1`, [n]
    );
    if (!weeks.length) return res.status(404).json({ error: '주차가 없습니다.' });
    weeks.reverse();                                   // 왼쪽이 오래된 주차

    const { rows: cells } = await db.query(
      `SELECT week_id, org_name, sort_order,
              count(*)::int AS total_users,
              count(*) FILTER (WHERE status = 'SUBMITTED')::int AS submitted
         FROM wr.v_submission_status
        WHERE week_id = ANY($1)
        GROUP BY week_id, org_name, sort_order
        ORDER BY sort_order, org_name`,
      [weeks.map((w) => w.id)]
    );

    const orgs = [];
    cells.forEach((c) => { if (!orgs.some((o) => o.name === c.org_name)) orgs.push({ name: c.org_name, sort: c.sort_order }); });
    const find = (wid, org) => cells.find((c) => c.week_id === wid && c.org_name === org);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('주차별 현황');
    ws.columns = [
      { header: '기관', key: 'org', width: 26 },
      ...weeks.map((w, i) => ({ header: w.label, key: `w${i}`, width: 18 })),
    ];
    orgs.forEach((o) => {
      const row = { org: o.name };
      weeks.forEach((w, i) => {
        const c = find(w.id, o.name);
        row[`w${i}`] = c ? `${c.submitted} / ${c.total_users}` : '-';
      });
      ws.addRow(row);
    });
    const totalRow = { org: '전체' };
    weeks.forEach((w, i) => {
      const list = cells.filter((c) => c.week_id === w.id);
      const s = list.reduce((a, c) => a + c.submitted, 0);
      const t = list.reduce((a, c) => a + c.total_users, 0);
      totalRow[`w${i}`] = `${s} / ${t}`;
    });
    ws.addRow(totalRow).font = { bold: true };
    weeks.forEach((w, i) => {
      ws.getColumn(`w${i}`).alignment = { horizontal: 'center', vertical: 'middle' };
    });
    styleHeader(ws); styleBody(ws);

    const name = `주차별현황_최근${n}주.xlsx`;
    await audit.log(req, 'EXPORT_MATRIX', { detail: name });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 사용자 목록
// ---------------------------------------------------------------------
router.get('/export/users', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.org_id) { params.push(Number(req.query.org_id)); where.push(`u.org_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      const i = params.length;
      where.push(`(u.name ILIKE $${i} OR u.username ILIKE $${i} OR u.email ILIKE $${i})`);
    }
    const { rows } = await db.query(
      `SELECT o.name AS org_name, u.name, u.username, u.duty, u.role,
              u.approval_status, u.is_active, u.last_login_at, u.created_at
         FROM wr.users u
         LEFT JOIN wr.organizations o ON o.id = u.org_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY o.sort_order, o.name, wr.duty_order(u.duty), u.name, u.username`,
      params
    );

    const DUTY = { LEAD: '총괄책임자', MANAGER: '실무책임자', RESEARCHER: '참여연구원' };
    const ROLE = { ADMIN: '총괄관리자', ORG_ADMIN: '기관관리자', USER: '작성자' };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('사용자 목록');
    ws.columns = [
      { header: '기관', key: 'org', width: 26 },
      { header: '이름', key: 'name', width: 14 },
      { header: '아이디', key: 'id', width: 18 },
      { header: '담당 역할', key: 'duty', width: 14 },
      { header: '권한', key: 'role', width: 14 },
      { header: '상태', key: 'state', width: 10 },
      { header: '최근 로그인', key: 'login', width: 20 },
      { header: '가입일', key: 'created', width: 20 },
    ];
    const fmt = (d) => (d ? new Date(d).toLocaleString('ko-KR', { hour12: false }) : '-');
    rows.forEach((u) => ws.addRow({
      org: u.org_name || '-', name: u.name, id: u.username,
      duty: DUTY[u.duty] || '-', role: ROLE[u.role] || u.role,
      state: u.approval_status === 'PENDING' ? '승인대기'
        : u.approval_status === 'REJECTED' ? '반려'
          : (u.is_active ? '활성' : '중지'),
      login: fmt(u.last_login_at), created: fmt(u.created_at),
    }));
    ['duty', 'role', 'state'].forEach((k) => {
      ws.getColumn(k).alignment = { horizontal: 'center', vertical: 'middle' };
    });
    styleHeader(ws); styleBody(ws);

    const name = `사용자목록_${rows.length}명.xlsx`;
    await audit.log(req, 'EXPORT_USERS', { detail: name });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 활동 로그 — 화면과 같은 조건. 최신 AUDIT_MAX 건까지.
// ---------------------------------------------------------------------
router.get('/export/audit', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    const asStart = (v) => (String(v).includes('T') ? String(v) : `${v}T00:00:00`);
    const asEnd = (v) => (String(v).includes('T') ? String(v) : `${v}T23:59:59`);

    if (req.query.from) { params.push(asStart(req.query.from)); where.push(`a.created_at >= $${params.length}::timestamptz`); }
    if (req.query.to) { params.push(asEnd(req.query.to)); where.push(`a.created_at <= $${params.length}::timestamptz`); }
    if (req.query.action) { params.push(String(req.query.action)); where.push(`a.action = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      const i = params.length;
      where.push(`(a.username ILIKE $${i} OR COALESCE(a.user_name, u.name) ILIKE $${i}
                   OR a.detail ILIKE $${i} OR a.ip ILIKE $${i})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limit = Math.min(Number(req.query.limit) || AUDIT_MAX, AUDIT_MAX);
    params.push(limit);
    const { rows } = await db.query(
      `SELECT a.created_at, a.username, COALESCE(a.user_name, u.name) AS user_name,
              a.action, a.detail, a.ip
         FROM wr.audit_logs a
         LEFT JOIN wr.users u ON u.id = a.user_id
        ${whereSql}
        ORDER BY a.id DESC
        LIMIT $${params.length}`,
      params
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('활동 로그');
    ws.columns = [
      { header: '일시', key: 'at', width: 20 },
      { header: '사용자ID', key: 'id', width: 16 },
      { header: '사용자', key: 'name', width: 14 },
      { header: '동작', key: 'action', width: 22 },
      { header: '내용', key: 'detail', width: 50 },
      { header: 'IP', key: 'ip', width: 16 },
    ];
    rows.forEach((l) => ws.addRow({
      at: new Date(l.created_at).toLocaleString('ko-KR', { hour12: false }),
      id: l.username || '(비로그인)',
      name: l.user_name || '(비로그인)',
      action: l.action,
      detail: l.detail || '',
      ip: l.ip || '-',
    }));
    styleHeader(ws); styleBody(ws);

    const name = `활동로그_${rows.length}건.xlsx`;
    await audit.log(req, 'EXPORT_AUDIT', { detail: `${name} (최대 ${limit}건)` });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.AUDIT_MAX = AUDIT_MAX;
