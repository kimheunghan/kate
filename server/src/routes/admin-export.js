'use strict';

/* =====================================================================
   관리자 화면의 엑셀 내려받기
     /api/admin/export/status   등록 현황 (기관별 소계)
     /api/admin/export/matrix   주차별 현황판
     /api/admin/export/audit    활동 로그
   화면에 걸어 둔 조회 조건을 그대로 받아 같은 내용을 내려받는다.
   ===================================================================== */

const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

const router = express.Router();
// 등록 현황·주차별 현황판은 관리자 화면을 볼 수 있는 사람이면 내려받는다.
// 활동 로그만 총괄관리자 전용이다.
router.use(auth.requireAuth, auth.requireManager);

const AUDIT_MAX = 5000;          // 활동 로그는 최신 이 건수까지만 내려받는다

/** 2026-08-21 01:27:52 형태로 (엑셀에서 24시 41분 처럼 나오지 않게) */
function stamp(d) {
  if (!d) return '-';
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} `
       + `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/** 동작 코드를 우리말로 (화면과 같은 표기) */
const ACTION_TEXT = {
  LOGIN: '로그인', LOGOUT: '로그아웃', LOGIN_FAIL: '로그인 실패',
  SIGNUP: '회원가입', FIND_ID: '아이디 찾기',
  PASSWORD_CHANGE: '비밀번호 변경', PROFILE_UPDATE: '내 정보 수정',
  RESET_REQUEST: '비밀번호 재설정 요청', RESET_DIRECT: '비밀번호 재설정 진행',
  RESET_COMPLETE: '비밀번호 재설정 완료', RESET_DONE: '비밀번호 재설정 완료',
  RESET_REJECT: '비밀번호 재설정 반려',
  RESET_MAIL_SENT: '재설정 메일 발송', RESET_MAIL_FAIL: '재설정 메일 실패',
  REPORT_SAVE: '보고서 저장', REPORT_UPDATE: '보고서 수정',
  REPORT_DELETE: '보고서 삭제', REPORT_STATUS: '보고서 상태 변경',
  REPORT_EXPORT: 'Word 다운로드', REPORT_EXPORT_HWPX: '한글 다운로드',
  REPORT_EXPORT_HWPX_WEEK: '주차 한글 다운로드',
  REPORT_EXPORT_HWPX_ALL: '전체 주차 ZIP 다운로드',
    FILE_EXPORT_ZIP: '증적자료 ZIP 다운로드',
  REPORT_MOVE_ORG: '보고서 기관 이관', REPORT_ORG_CHANGE: '보고서 기관 변경',
  EXCEL_PREVIEW: '엑셀 업로드', EXCEL_IMPORT: '엑셀 업로드(즉시 등록)',
  FILE_UPLOAD: '증적자료 첨부', FILE_DOWNLOAD: '증적자료 다운로드', FILE_DELETE: '증적자료 삭제',
  USER_CREATE: '사용자 추가', USER_UPDATE: '사용자 수정',
  USER_DELETE: '사용자 삭제', USER_PASSWORD_RESET: '비밀번호 초기화',
  ORG_CREATE: '기관 추가', ORG_UPDATE: '기관 수정', ORG_DELETE: '기관 삭제',
  EXPORT_STATUS: '등록 현황 엑셀', EXPORT_MATRIX: '주차별 현황 엑셀',
  EXPORT_USERS: '사용자 목록 엑셀', EXPORT_AUDIT: '활동 로그 엑셀',
};

/**
 * 시트 맨 위에 제목과 부제를 넣는다.
 * @returns {number} 다음에 쓸 줄 번호
 */
function putTitle(ws, cols, title, subtitle) {
  const last = String.fromCharCode(64 + cols);          // A, B, C …

  ws.mergeCells(`A1:${last}1`);
  const t = ws.getCell('A1');
  t.value = title;
  t.font = { bold: true, size: 16 };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${last}2`);
  const s = ws.getCell('A2');
  s.value = subtitle;
  s.font = { size: 11, color: { argb: 'FF5D6B7D' } };
  s.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 20;

  return 3;                                             // 3행은 비워 둔다
}

/** 요약 상자 (대상 인원 / 제출완료 / 미등록 / 제출률) */
function putSummary(ws, at, pairs) {
  const head = ws.getRow(at);
  const body = ws.getRow(at + 1);
  pairs.forEach(([k, v], i) => {
    const hc = head.getCell(i + 1);
    hc.value = k;
    hc.font = { bold: true, size: 11 };
    hc.alignment = { horizontal: 'center', vertical: 'middle' };
    hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    hc.border = BORDER;

    const bc = body.getCell(i + 1);
    bc.value = v;
    bc.font = { bold: true, size: 14 };
    bc.alignment = { horizontal: 'center', vertical: 'middle' };
    bc.border = BORDER;
  });
  head.height = 20;
  body.height = 26;
  return at + 3;                                        // 한 줄 띄운다
}

/** 구역 제목 (기관별 소계 …) */
function putSectionTitle(ws, at, text) {
  const c = ws.getRow(at).getCell(1);
  c.value = text;
  c.font = { bold: true, size: 12, color: { argb: 'FF17497F' } };
  ws.getRow(at).height = 22;
  return at + 1;
}

/**
 * 표 아래 안내 문구.
 * text 안의 **굵게** 부분은 굵은 글자로 찍는다.
 */
function putNote(ws, at, text) {
  const c = ws.getRow(at + 1).getCell(1);
  const base = { size: 10, color: { argb: 'FF5D6B7D' } };
  const parts = String(`※ ${text}`).split(/\*\*(.+?)\*\*/g);
  c.value = {
    richText: parts.map((t, i) => ({ text: t, font: { ...base, bold: i % 2 === 1 } }))
      .filter((r) => r.text !== ''),
  };
  return at + 2;
}

/** 색 범례 (전원 제출 / 일부 제출 / 제출 없음) */
function putLegend(ws, at) {
  const items = [
    ['전원 제출', 'FFE6F6EC'],
    ['일부 제출', 'FFFFF5E0'],
    ['제출 없음', 'FFFAFAFA'],
  ];
  const row = ws.getRow(at);
  row.getCell(1).value = '범례';
  row.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF5D6B7D' } };
  items.forEach(([label, color], i) => {
    const c = row.getCell(i + 2);
    c.value = label;
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.font = { size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    c.border = BORDER;
  });
  row.height = 20;
  return at + 2;
}

const BORDER = {
  top: { style: 'thin' }, bottom: { style: 'thin' },
  left: { style: 'thin' }, right: { style: 'thin' },
};

/** 표 제목 줄 꾸미기 (가운데 정렬 · 연노랑 배경 · 굵게) */
function styleHeader(ws, at = 1) {
  const row = ws.getRow(at);
  row.font = { bold: true, size: 11 };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
  row.height = 22;
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBDD' } };
    c.border = BORDER;
  });
}

/** 내용 칸에 테두리 (제목 줄 다음부터) */
function styleBody(ws, from = 2) {
  ws.eachRow((row, n) => {
    if (n < from) return;
    row.eachCell((c) => {
      c.border = BORDER;
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
router.get('/export/status', auth.requireStatusView, async (req, res, next) => {
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

    // 화면의 '작성자 제출 현황' 과 같은 사람별 목록 (접속IP 포함)
    const { rows: people } = await db.query(
      `SELECT s.org_name, s.user_name, s.username, s.status, s.file_count,
              s.submitted_at, s.updated_at, s.report_id,
              COALESCE(
                (SELECT u2.last_login_ip FROM wr.users u2 WHERE u2.id = s.user_id),
                (SELECT a.ip FROM wr.audit_logs a
                  WHERE a.user_id = s.user_id AND a.ip IS NOT NULL
                  ORDER BY a.created_at DESC LIMIT 1)
              ) AS last_ip
         FROM wr.v_submission_status s
        WHERE ${where}
        ORDER BY s.sort_order NULLS LAST, s.org_name,
                 wr.duty_order(s.duty), s.user_name`,
      params
    );

    const tot = rows.reduce((a, r) => ({ t: a.t + r.total_users, s: a.s + r.submitted }), { t: 0, s: 0 });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('등록 현황');
    [24, 12, 14, 11, 8, 20, 20, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // '18주차 (2026/08/20목~08/26수)' → 제목은 '18주차', 부제는 괄호 안
    const m = /^(\S+)\s*(\(.*\))?$/.exec(week.label) || [];
    let at = putTitle(ws, 8, `${m[1] || week.label} 주간보고 실적현황`, m[2] || '');

    // ── 보고서 제출현황 ──────────────────────────────────────────
    at = putSectionTitle(ws, at, '보고서 제출현황');

    ws.mergeCells(`A${at}:B${at}`);
    ws.mergeCells(`A${at + 1}:B${at + 1}`);
    const sumHead = ws.getRow(at);
    const sumBody = ws.getRow(at + 1);
    [['대상 인원', tot.t], ['제출완료', tot.s], ['미등록', tot.t - tot.s],
     ['제출률', tot.t ? `${Math.round((tot.s / tot.t) * 100)}%` : '0%']]
      .forEach(([k, v], i) => {
        const col = i === 0 ? 1 : i + 2;           // 첫 칸은 A:B 를 합쳐 쓴다
        const hc = sumHead.getCell(col);
        hc.value = k;
        hc.font = { bold: true, size: 11 };
        hc.alignment = { horizontal: 'center', vertical: 'middle' };
        hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBDD' } };
        hc.border = BORDER;

        const bc = sumBody.getCell(col);
        bc.value = v;
        bc.font = { bold: true, size: 13 };
        bc.alignment = { horizontal: 'center', vertical: 'middle' };
        bc.border = BORDER;
      });
    // 합친 칸의 테두리가 끊기지 않게 B 칸에도 선을 넣는다
    [sumHead, sumBody].forEach((r) => { r.getCell(2).border = BORDER; });
    sumHead.height = 20;
    sumBody.height = 24;
    at += 3;                                        // 한 줄 띄운다

    // ── 기관별 소계 ──────────────────────────────────────────────
    at = putSectionTitle(ws, at, '기관별 소계');
    const headAt = at;
    ws.getRow(at).values = ['기관', '대상 인원', '제출', '미등록', '제출률'];
    styleHeader(ws, at);
    at += 1;

    rows.forEach((r) => {
      ws.getRow(at).values = [
        r.org_name || '(소속없음)',
        r.total_users,
        r.submitted,
        r.total_users - r.submitted,
        r.total_users ? `${Math.round((r.submitted / r.total_users) * 100)}%` : '0%',
      ];
      at += 1;
    });
    const lastRow = ws.getRow(at);
    lastRow.values = ['전체', tot.t, tot.s, tot.t - tot.s,
      tot.t ? `${Math.round((tot.s / tot.t) * 100)}%` : '0%'];
    lastRow.font = { bold: true };
    lastRow.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
    });

    for (let r = headAt; r <= at; r++) {
      for (let c = 2; c <= 5; c++) {
        ws.getRow(r).getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
    styleBody(ws, headAt);
    at = putNote(ws, at, '해당 주차 참여 인력(상주/비상주)에 대한 보고서 제출 현황입니다.');
    at = putNote(ws, at - 1, '감독관리자는 참여 인력이 아니므로 대상 인원에서 제외됩니다. 감독관리자가 쓴 보고서는 등록 내역에 나오지 않고, 본인만 한글로 내려받을 수 있습니다.');

    // ── 작성자 제출 현황 (사람별) ────────────────────────────────
    at += 1;                                        // 한 줄 띄운다
    at = putSectionTitle(ws, at, `작성자 제출 현황 (${people.length}명)`);
    const pHeadAt = at;
    ws.getRow(at).values =
      ['기관', '이름', '아이디', '상태', '첨부', '제출시각', '최종수정', '접속IP'];
    styleHeader(ws, at);
    at += 1;

    const STATUS_TEXT = { SUBMITTED: '제출완료', NONE: '미등록' };
    people.forEach((r) => {
      ws.getRow(at).values = [
        r.org_name || '(소속없음)',
        r.user_name || '-',
        r.username || '-',
        STATUS_TEXT[r.status] || r.status || '-',
        Number(r.file_count) || 0,
        r.submitted_at ? stamp(r.submitted_at) : '-',
        r.report_id ? stamp(r.updated_at) : '-',
        r.last_ip || '-',
      ];
      at += 1;
    });

    // 상태·첨부·시각·IP 는 가운데로
    for (let r = pHeadAt; r < at; r++) {
      for (const c of [4, 5, 6, 7, 8]) {
        ws.getRow(r).getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
    styleBody(ws, pHeadAt);
    putNote(ws, at - 1, '접속IP 는 활동 기록에 마지막으로 남은 접속 주소입니다.');

    const name = `${safeName(`등록현황_${week.label.replace(/\//g, '.')}`)}.xlsx`;
    await audit.log(req, 'EXPORT_STATUS', { detail: name });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 주차별 현황판
// ---------------------------------------------------------------------
router.get('/export/matrix', auth.requireMatrixView, async (req, res, next) => {
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
    ws.getColumn(1).width = 26;
    weeks.forEach((w, i) => { ws.getColumn(i + 2).width = 18; });

    const cols = weeks.length + 1;
    let at = putTitle(ws, cols, `최근 ${weeks.length}주차별 주간보고 실적현황`,
      `[ ${weeks[0].label} ~ ${weeks[weeks.length - 1].label} ]`);

    // 범례는 칸을 칠하지 않고 한 줄 글자로 둔다 (■ 색만 다르게)
    const legendAt = at + 1;
    ws.mergeCells(legendAt, 1, legendAt, cols);
    const lg = ws.getCell(legendAt, 1);
    lg.value = {
      richText: [
        { text: '■ ', font: { size: 11, color: { argb: 'FF7DC49A' } } },
        { text: '전원 제출    ', font: { size: 10, color: { argb: 'FF5D6B7D' } } },
        { text: '■ ', font: { size: 11, color: { argb: 'FFE9B95C' } } },
        { text: '일부 제출    ', font: { size: 10, color: { argb: 'FF5D6B7D' } } },
        { text: '■ ', font: { size: 11, color: { argb: 'FFC9CFD6' } } },
        { text: '제출 없음', font: { size: 10, color: { argb: 'FF5D6B7D' } } },
      ],
    };
    lg.alignment = { horizontal: 'right', vertical: 'middle' };
    ws.getRow(legendAt).height = 20;
    at = legendAt + 2;

    // 표 제목 줄 : 주차와 기간을 줄을 나눠 적는다
    const headAt = at;
    const headRow = ws.getRow(at);
    headRow.getCell(1).value = '기관';
    weeks.forEach((w, i) => {
      headRow.getCell(i + 2).value = String(w.label).replace(' (', '\n(').replace('~', '\n~');
    });
    styleHeader(ws, at);
    headRow.height = 60;
    headRow.eachCell((c) => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
    at += 1;

    /** 제출률에 따라 칸 색을 칠한다 (화면과 같은 기준) */
    const paint = (cell, sub, total) => {
      const rate = total ? sub / total : 0;
      const color = rate >= 1 ? 'FFE6F6EC' : (rate > 0 ? 'FFFFF5E0' : 'FFFAFAFA');
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    };
    /** 0/3 아래 (0%) 로 적는다 */
    const cellText = (sub, total) =>
      `${sub}/${total}\n(${total ? Math.round((sub / total) * 100) : 0}%)`;

    orgs.forEach((o) => {
      const row = ws.getRow(at);
      row.getCell(1).value = o.name;
      row.getCell(1).alignment = { vertical: 'middle' };
      weeks.forEach((w, i) => {
        const c = find(w.id, o.name);
        const cell = row.getCell(i + 2);
        cell.value = c ? cellText(c.submitted, c.total_users) : '-';
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        paint(cell, c ? c.submitted : 0, c ? c.total_users : 0);
      });
      row.height = 38;
      at += 1;
    });

    const totalRow = ws.getRow(at);
    totalRow.getCell(1).value = '전체';
    weeks.forEach((w, i) => {
      const list = cells.filter((c) => c.week_id === w.id);
      const sub = list.reduce((a2, c) => a2 + c.submitted, 0);
      const tot = list.reduce((a2, c) => a2 + c.total_users, 0);
      const cell = totalRow.getCell(i + 2);
      cell.value = cellText(sub, tot);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    totalRow.font = { bold: true };
    totalRow.height = 38;
    totalRow.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
    });

    styleBody(ws, headAt);
    putNote(ws, at,
      '주차별 참여 인력(상주/비상주)에 대한 보고서 제출 현황입니다. (칸의 숫자 = **제출 / 대상**, ( )은 **제출률** 현황)');

    const name = `주차별현황_최근${n}주.xlsx`;
    await audit.log(req, 'EXPORT_MATRIX', { detail: name });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 활동 로그 — 화면과 같은 조건. 최신 AUDIT_MAX 건까지.
// ---------------------------------------------------------------------
router.get('/export/audit', auth.requireAdmin, async (req, res, next) => {
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
    [20, 16, 14, 24, 20, 46, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // 조회 조건을 부제로 적는다
    const cond = [];
    // 기간을 걸지 않았으면 실제로 담긴 기록의 처음~끝 시각을 적는다
    const newest = rows.length ? rows[0].created_at : null;
    const oldest = rows.length ? rows[rows.length - 1].created_at : null;
    cond.push(req.query.from || req.query.to
      ? `기간 ${String(req.query.from || stamp(oldest)).replace('T', ' ')}`
        + ` ~ ${String(req.query.to || stamp(newest)).replace('T', ' ')}`
      : (rows.length ? `기간 ${stamp(oldest)} ~ ${stamp(newest)}` : '기간 -'));
    if (req.query.action) cond.push(`행위 ${ACTION_TEXT[req.query.action] || req.query.action}`);
    if (req.query.q) cond.push(`검색어 "${String(req.query.q).trim()}"`);

    let at = putTitle(ws, 7, '주간보고 실적 활동 로그', cond.join('  ·  '));
    at = putSectionTitle(ws, at, `활동 로그 (총 ${rows.length.toLocaleString()}건)`);

    const headAt = at;
    ws.getRow(at).values = ['일시', '사용자ID', '사용자', '동작', '행위', '내용', 'IP'];
    styleHeader(ws, at);
    at += 1;

    rows.forEach((l) => {
      const row = ws.getRow(at);
      row.values = [
        stamp(l.created_at),
        l.username || '(비로그인)',
        l.user_name || '(비로그인)',
        l.action,
        ACTION_TEXT[l.action] || '-',
        l.detail || '',
        l.ip || '-',
      ];
      [1, 2, 3, 5, 7].forEach((c) => {
        row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
      });
      at += 1;
    });
    styleBody(ws, headAt);
    putNote(ws, at, `조회 조건에 맞는 기록을 최신순 최대 ${AUDIT_MAX.toLocaleString()}건까지 내려받습니다.`);

    const name = `활동로그_${rows.length}건.xlsx`;
    await audit.log(req, 'EXPORT_AUDIT', { detail: `${name} (최대 ${limit}건)` });
    await send(res, wb, name);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.AUDIT_MAX = AUDIT_MAX;
