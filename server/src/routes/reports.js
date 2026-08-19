'use strict';

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { sanitizeHtml, htmlToText } = require('../lib/sanitize');

const router = express.Router();
router.use(auth.requireAuth);

// ---------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------

/** 보고서를 편집할 수 있는가 — 본인 것이거나 전체 관리자 */
function canEditReport(user, report) {
  if (user.role === 'ADMIN') return true;
  return report.author_id != null && Number(report.author_id) === Number(user.id);
}

/**
 * 조회 범위
 *   USER      : 본인이 작성한 보고서만
 *   ORG_ADMIN : 자기 기관 소속 전체
 *   ADMIN     : 전부
 */
function addViewScope(user, where, params) {
  if (user.role === 'ADMIN') return;
  if (user.role === 'ORG_ADMIN') {
    params.push(user.org_id || -1);
    where.push(`r.org_id = $${params.length}`);
  } else {
    params.push(user.id);
    where.push(`r.author_id = $${params.length}`);
  }
}

/** 이 보고서를 열람할 수 있는가 */
function canViewReport(user, report) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'ORG_ADMIN') return Number(report.org_id) === Number(user.org_id);
  return report.author_id != null && Number(report.author_id) === Number(user.id);
}

async function loadReport(id) {
  const { rows } = await db.query(
    `SELECT r.*, w.label AS week_label, w.start_date, w.end_date, w.is_open,
            o.name AS org_name, u.name AS author_name
       FROM wr.reports r
       JOIN wr.report_weeks  w ON w.id = r.week_id
       JOIN wr.organizations o ON o.id = r.org_id
       LEFT JOIN wr.users    u ON u.id = r.author_id
      WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function loadItems(reportId) {
  const { rows } = await db.query(
    `SELECT id, sort_order, task_title, plan_html, result_html, next_plan_html
       FROM wr.report_items
      WHERE report_id = $1
      ORDER BY sort_order, id`,
    [reportId]
  );
  return rows;
}

async function loadAttachments(reportId) {
  const { rows } = await db.query(
    `SELECT a.id, a.item_id, a.original_name, a.content_type, a.byte_size, a.created_at,
            u.name AS uploaded_by_name
       FROM wr.attachments a
       LEFT JOIN wr.users u ON u.id = a.uploaded_by
      WHERE a.report_id = $1
      ORDER BY a.id`,
    [reportId]
  );
  return rows;
}

/**
 * 업무명(제목)의 줄머리 들여쓰기 공백을 제거한다.
 * 원본 문서에서 붙여넣으면 줄 앞에 &nbsp; 가 딸려와, 좁은 제목 칸에서
 * 그 줄만 떨어져 보인다. 계획/실적 본문은 들여쓰기가 의미가 있으므로 건드리지 않는다.
 */
function trimTitleIndent(html) {
  if (!html) return html;
  return String(html)
    // 맨 앞 / <br> 직후 / 블록 시작 직후의 연속 공백(&nbsp;, 일반 공백) 제거
    .replace(/(^|<br[^>]*>|<(?:p|div|li)[^>]*>)((?:\s|&nbsp;|<span[^>]*>\s*<\/span>)+)/gi, '$1')
    // 태그 사이에 홀로 남은 공백 span 정리
    .replace(/<span([^>]*)>((?:\s|&nbsp;)+)<\/span>/gi, (m, attrs, sp) => (/&nbsp;/.test(sp) ? ' ' : ' '));
}

/** 클라이언트가 보낸 items 배열 정규화 + HTML 정제 */
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).map((it, idx) => ({
    id: Number.isInteger(Number(it.id)) && Number(it.id) > 0 ? Number(it.id) : null,
    sort_order: idx,
    // 보고 양식과 동일하게 ①당초계획 ②추진실적 ③향후계획 세 칸을 저장한다
    task_title: '',
    plan_html: sanitizeHtml(it.plan_html),
    result_html: sanitizeHtml(it.result_html),
    next_plan_html: sanitizeHtml(it.next_plan_html),
  }));
}

/** 기존 항목과 비교해 INSERT / UPDATE / DELETE 를 수행 (첨부 연결 유지) */
async function saveItems(client, reportId, items) {
  const { rows: existing } = await client.query(
    `SELECT id FROM wr.report_items WHERE report_id = $1`, [reportId]
  );
  const existingIds = new Set(existing.map((r) => r.id));
  const keptIds = new Set();
  const idMap = {}; // 클라이언트 임시 인덱스 → 실제 id

  for (const it of items) {
    if (it.id && existingIds.has(it.id)) {
      await client.query(
        `UPDATE wr.report_items
            SET sort_order = $1, task_title = $2, plan_html = $3,
                result_html = $4, next_plan_html = $5
          WHERE id = $6 AND report_id = $7`,
        [it.sort_order, it.task_title, it.plan_html, it.result_html, it.next_plan_html, it.id, reportId]
      );
      keptIds.add(it.id);
      idMap[it.sort_order] = it.id;
    } else {
      const { rows } = await client.query(
        `INSERT INTO wr.report_items
           (report_id, sort_order, task_title, plan_html, result_html, next_plan_html)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [reportId, it.sort_order, it.task_title, it.plan_html, it.result_html, it.next_plan_html]
      );
      keptIds.add(rows[0].id);
      idMap[it.sort_order] = rows[0].id;
    }
  }

  const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
  if (toDelete.length) {
    // 항목에 붙어 있던 첨부는 보고서 단위로 승격(item_id = NULL)시켜 유실 방지
    await client.query(`UPDATE wr.attachments SET item_id = NULL WHERE item_id = ANY($1::int[])`, [toDelete]);
    await client.query(`DELETE FROM wr.report_items WHERE id = ANY($1::int[])`, [toDelete]);
  }
  return idMap;
}

// ---------------------------------------------------------------------
// GET /api/reports  — 목록 / 조회
//   query: week_id, org_id, status, q, mine, page, size
// ---------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const size = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);
    const where = [];
    const params = [];

    if (req.query.week_id) { params.push(Number(req.query.week_id)); where.push(`r.week_id = $${params.length}`); }
    if (req.query.status)  { params.push(String(req.query.status));  where.push(`r.status  = $${params.length}`); }
    if (req.query.author_id) { params.push(Number(req.query.author_id)); where.push(`r.author_id = $${params.length}`); }
    if (String(req.query.mine) === '1') {
      params.push(req.user.id); where.push(`r.author_id = $${params.length}`);
    }

    // 권한별 조회 범위 (작성자는 본인 것만)
    addViewScope(req.user, where, params);
    if (req.user.role === 'ADMIN' && req.query.org_id) {
      params.push(Number(req.query.org_id)); where.push(`r.org_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      const i = params.length;
      where.push(`EXISTS (
        SELECT 1 FROM wr.report_items ri
         WHERE ri.report_id = r.id
           AND (ri.plan_html ILIKE $${i} OR ri.result_html ILIKE $${i} OR ri.next_plan_html ILIKE $${i})
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `SELECT count(*)::int AS total FROM wr.reports r ${whereSql}`;
    const { rows: cnt } = await db.query(countSql, params);

    params.push(size, (page - 1) * size);
    const listSql = `
      SELECT r.id, r.week_id, r.org_id, r.status, r.submitted_at, r.updated_at, r.note,
             w.label AS week_label, w.start_date, w.end_date, w.is_open,
             o.name  AS org_name,
             u.name  AS author_name,
             (SELECT count(*)::int FROM wr.report_items ri WHERE ri.report_id = r.id) AS item_count,
             (SELECT left(btrim(regexp_replace(
                        replace(replace(
                          string_agg(coalesce(nullif(ri.plan_html, ''), ri.result_html), ' / '
                                     ORDER BY ri.sort_order, ri.id),
                          '&nbsp;', ' '), '&amp;', '&'),
                        '<[^>]*>', ' ', 'g')), 200)
                FROM wr.report_items ri WHERE ri.report_id = r.id) AS summary,
             (SELECT count(*)::int FROM wr.attachments  a WHERE a.report_id  = r.id) AS file_count
        FROM wr.reports r
        JOIN wr.report_weeks  w ON w.id = r.week_id
        JOIN wr.organizations o ON o.id = r.org_id
        LEFT JOIN wr.users    u ON u.id = r.author_id
        ${whereSql}
       ORDER BY w.start_date DESC, o.sort_order, o.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await db.query(listSql, params);

    res.json({ reports: rows, total: cnt[0].total, page, size });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/reports/lookup?week_id=&org_id=  — 특정 주차/기관 보고서 찾기
// ---------------------------------------------------------------------
router.get('/lookup', async (req, res, next) => {
  try {
    const weekId = Number(req.query.week_id);
    if (!weekId) return res.status(400).json({ error: 'week_id 가 필요합니다.' });

    // 기본은 "내 보고서". 전체 관리자만 다른 사람 것을 지정해 볼 수 있다.
    const authorId = (req.user.role === 'ADMIN' && req.query.author_id)
      ? Number(req.query.author_id) : req.user.id;

    const { rows } = await db.query(
      `SELECT id FROM wr.reports WHERE week_id = $1 AND author_id = $2`, [weekId, authorId]
    );
    if (!rows[0]) return res.json({ report: null });

    const report = await loadReport(rows[0].id);
    report.items = await loadItems(report.id);
    report.attachments = await loadAttachments(report.id);
    report.can_edit = canEditReport(req.user, report) && (report.is_open || req.user.role === 'ADMIN');
    res.json({ report });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/reports/:id  — 상세
// ---------------------------------------------------------------------
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const report = await loadReport(Number(req.params.id));
    if (!report) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });

    if (!canViewReport(req.user, report)) {
      return res.status(403).json({ error: '열람 권한이 없습니다.' });
    }

    report.items = await loadItems(report.id);
    report.attachments = await loadAttachments(report.id);
    report.can_edit = canEditReport(req.user, report) && (report.is_open || req.user.role === 'ADMIN');
    res.json({ report });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/reports  — 등록 (해당 주차/기관 건이 있으면 수정으로 처리)
// ---------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const weekId = Number(req.body?.week_id);
    // 보고서는 항상 "본인 것" 으로 만들어진다. 기관은 작성 시점 소속을 기록한다.
    const orgId = req.user.org_id;
    if (!weekId) return res.status(400).json({ error: '주차를 선택하세요.' });
    if (!orgId)  return res.status(400).json({ error: '소속 기관이 없습니다. 내 정보에서 소속을 지정하세요.' });

    const { rows: wrows } = await db.query(`SELECT is_open FROM wr.report_weeks WHERE id = $1`, [weekId]);
    if (!wrows[0]) return res.status(400).json({ error: '존재하지 않는 주차입니다.' });
    if (!wrows[0].is_open && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: '마감된 주차입니다. 관리자에게 문의하세요.' });
    }

    const items = normalizeItems(req.body?.items);
    const note = String(req.body?.note || '').slice(0, 5000);
    const status = req.body?.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT';

    const reportId = await db.tx(async (client) => {
      const { rows } = await client.query(
        // $4 를 두 곳에서 쓰므로 명시적으로 캐스팅해야 타입 추론 충돌이 나지 않는다
        `INSERT INTO wr.reports (week_id, org_id, author_id, status, note, submitted_at)
         VALUES ($1, $2, $3, $4::varchar, $5,
                 CASE WHEN $4::varchar = 'SUBMITTED' THEN now() ELSE NULL END)
         ON CONFLICT (week_id, author_id) WHERE author_id IS NOT NULL DO UPDATE
            SET org_id       = EXCLUDED.org_id,
                status       = EXCLUDED.status,
                note         = EXCLUDED.note,
                submitted_at = CASE WHEN EXCLUDED.status = 'SUBMITTED'
                                    THEN COALESCE(reports.submitted_at, now()) ELSE NULL END
         RETURNING id`,
        [weekId, orgId, req.user.id, status, note]
      );
      const id = rows[0].id;
      await saveItems(client, id, items);
      return id;
    });

    await audit.log(req, 'REPORT_SAVE', { targetType: 'report', targetId: reportId, detail: `status=${status}` });

    const report = await loadReport(reportId);
    report.items = await loadItems(reportId);
    report.attachments = await loadAttachments(reportId);
    report.can_edit = true;
    res.status(201).json({ report });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// PUT /api/reports/:id  — 수정
// ---------------------------------------------------------------------
router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadReport(id);
    if (!existing) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
    if (!canEditReport(req.user, existing)) return res.status(403).json({ error: '본인이 작성한 보고서만 수정할 수 있습니다.' });
    if (!existing.is_open && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: '마감된 주차입니다. 관리자에게 문의하세요.' });
    }

    const items = normalizeItems(req.body?.items);
    const note = String(req.body?.note || '').slice(0, 5000);
    const status = req.body?.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT';

    await db.tx(async (client) => {
      await client.query(
        `UPDATE wr.reports
            SET note = $1,
                status = $2::varchar,
                submitted_at = CASE WHEN $2::varchar = 'SUBMITTED'
                                    THEN COALESCE(submitted_at, now()) ELSE NULL END
          WHERE id = $3`,
        [note, status, id]
      );
      await saveItems(client, id, items);
    });

    await audit.log(req, 'REPORT_UPDATE', { targetType: 'report', targetId: id, detail: `status=${status}` });

    const report = await loadReport(id);
    report.items = await loadItems(id);
    report.attachments = await loadAttachments(id);
    report.can_edit = true;
    res.json({ report });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// POST /api/reports/:id/status  — 제출 / 임시저장 전환
// ---------------------------------------------------------------------
router.post('/:id(\\d+)/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT';

    const existing = await loadReport(id);
    if (!existing) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
    if (!canEditReport(req.user, existing)) return res.status(403).json({ error: '본인이 작성한 보고서만 변경할 수 있습니다.' });
    if (!existing.is_open && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: '마감된 주차입니다.' });
    }

    await db.query(
      `UPDATE wr.reports
          SET status = $1::varchar,
              submitted_at = CASE WHEN $1::varchar = 'SUBMITTED'
                                  THEN COALESCE(submitted_at, now()) ELSE NULL END
        WHERE id = $2`,
      [status, id]
    );
    await audit.log(req, 'REPORT_STATUS', { targetType: 'report', targetId: id, detail: status });
    res.json({ ok: true, status });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// DELETE /api/reports/:id  — 삭제 (항목·첨부 CASCADE)
// ---------------------------------------------------------------------
router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadReport(id);
    if (!existing) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
    if (!canEditReport(req.user, existing)) return res.status(403).json({ error: '본인이 작성한 보고서만 삭제할 수 있습니다.' });
    if (!existing.is_open && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: '마감된 주차입니다.' });
    }

    // 물리 파일 정리는 files 라우터의 헬퍼를 재사용
    const { removeFilesOfReport } = require('./files');
    await removeFilesOfReport(id);

    await db.query(`DELETE FROM wr.reports WHERE id = $1`, [id]);
    await audit.log(req, 'REPORT_DELETE', {
      targetType: 'report', targetId: id,
      detail: `${existing.org_name} / ${existing.week_label}`,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 날짜 표기 : 2026-08-13 → 8/13.목
// ---------------------------------------------------------------------
const KOR_DOW = ['일', '월', '화', '수', '목', '금', '토'];

function fmtDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${m}/${d}.${KOR_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

function fmtRange(start, end) {
  const a = fmtDate(start); const b = fmtDate(end);
  return a && b ? `${a}~${b}` : '';
}

/** 해당 주차 바로 다음 주차 (향후 계획의 대상 기간) */
async function loadNextWeek(startDate) {
  const { rows } = await db.query(
    `SELECT start_date, end_date FROM wr.report_weeks
      WHERE start_date > $1 ORDER BY start_date LIMIT 1`,
    [startDate]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// 보고서 문서 HTML 생성 (인쇄 / Word 다운로드 공용)
//   forWord=true 이면 Word·한글이 페이지 설정을 인식하도록 mso 지시문을 넣는다.
// ---------------------------------------------------------------------
function buildReportHtml(report, items, files, { forWord = false, nextWeek = null } = {}) {
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const thisRange = fmtRange(report.start_date, report.end_date);
  const nextRange = nextWeek ? fmtRange(nextWeek.start_date, nextWeek.end_date) : '';

  const n = items.length || 1;

  // 들여쓰기는 padding-left 로 저장되는데 Word 는 이 속성을 무시한다.
  // 문서로 내보낼 때는 Word 가 문단 들여쓰기로 인식하는 margin-left 로 바꾼다.
  // (브라우저 인쇄에서도 결과는 같다)
  /**
   * 들여쓰기를 공백 문자로 바꾼다.
   * Word 는 표 칸 안 <div> 의 padding-left / margin-left 를 무시해서
   * 여백 속성으로는 들여쓰기가 전혀 표시되지 않는다.
   * 줄머리에 &nbsp; 를 넣으면 Word·브라우저·한글 모두에서 동일하게 보인다.
   * (화면 편집기는 8px 단위 = 공백 2칸)
   */
  const toDoc = (h) => String(h || '').replace(
    /<(div|p|li)([^>]*)>/gi,
    (m, tag, attrs) => {
      const px = (/(?:padding|margin)-left\s*:\s*([\d.]+)px/i.exec(attrs) || [])[1];
      const spaces = px ? Math.min(Math.round(Number(px) / 4), 40) : 0;
      const cleaned = attrs
        .replace(/(?:padding|margin)-left\s*:\s*[\d.]+px;?\s*/gi, '')
        .replace(/style="\s*"/i, '');
      return `<${tag}${cleaned}>${'&nbsp;'.repeat(spaces)}`;
    });

  const rows = items.map((it, i) => `
      <tr>
        ${i === 0 ? `<td class="org" rowspan="${n}">${esc(report.org_name)}</td>
        <td class="who" rowspan="${n}">${esc(report.author_name || '-')}</td>` : ''}
        <td class="cell">${toDoc(it.plan_html)}</td>
        <td class="cell">${toDoc(it.result_html)}</td>
        <td class="cell">${toDoc(it.next_plan_html)}</td>
      </tr>`).join('');

  // 인쇄: @page 여백 0 → 브라우저가 머리글(날짜)/바닥글(URL)을 넣지 않는다
  // Word : WordSection1 으로 가로 방향 A4 지정
  const pageCss = forWord
    ? `@page WordSection1 {
       /* 세로 A4 (595.3 x 841.9pt). Word 는 pt 로 줘야 확실히 인식한다 */
       size: 595.3pt 841.9pt;
       mso-page-orientation: portrait;
       margin: 1.0cm 1.0cm 1.0cm 1.0cm;
       mso-header-margin: 0.5cm; mso-footer-margin: 0.5cm;
     }
  div.WordSection1 { page: WordSection1; }
  /* Word 는 문서 첫 문단 위 여백을 무시하는 경우가 있어 제목 위에 여유를 준다 */
  h1 { margin-top: 6pt !important; }`
    : `@page { size: A4 portrait; margin: 0; }
  body { padding: 10mm; }`;

  return `<!doctype html>
<html lang="ko"${forWord ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"' : ''}>
<head>
<meta charset="utf-8">
<title>주간보고 - ${esc(report.org_name)} ${esc(report.week_label)}</title>
${forWord ? `<!--[if gte mso 9]><xml>
 <w:WordDocument>
  <w:View>Print</w:View><w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml><![endif]-->` : ''}
<style>
  ${pageCss}
  html, body { margin: 0; }
  body {
    font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif;
    font-size: 10.5pt; line-height: 1.5; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* Word 는 문단마다 기본 아래 여백(10pt)을 넣는다. 전부 0 으로 맞춘다. */
  p, div, li, td, th { mso-para-margin: 0; mso-pagination: none; }
  h1 { font-size: 15pt; margin: 0 0 10px; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td {
    border: 1px solid #333; padding: 6px 7px; vertical-align: top;
    overflow-wrap: anywhere; word-break: break-word;
  }
  /* 제목보다 본문을 한 단계 작게 (같은 크기면 표가 답답해 보인다) */
  th { background: #fffbcc; text-align: center; font-weight: 700; font-size: 10pt; }
  td { font-size: 9pt; line-height: 1.45; }
  td.org, td.who {
    background: #fcfcf0; text-align: center; vertical-align: middle;
    font-weight: 600; font-size: 9.5pt;
  }

  td img { max-width: 100%; height: auto; }
  td table { width: 100%; table-layout: fixed; font-size: 8.5pt; }
  td pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
  td ul, td ol { margin: 3px 0; padding-left: 18px; }
  td p { margin: 0 0 3px; }

  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }

  .note { margin-top: 12px; font-size: 10pt; page-break-inside: avoid; break-inside: avoid; }
  ol.files { margin: 5px 0 0; padding-left: 20px; font-size: 9pt; }
  ol.files li { margin-bottom: 2px; overflow-wrap: anywhere; }

  /* Word 용: 목록 태그 없이 번호를 직접 붙인 줄. 여백·줄간격을 명시해
     Word 기본 문단 간격(10pt)과 목록 들여쓰기가 끼어들지 못하게 한다. */
  .fitem {
    margin: 0 0 1pt 0; padding: 0;
    text-indent: 0; font-size: 9.5pt; line-height: 1.35;
    mso-line-height-rule: exactly; mso-para-margin: 0; mso-pagination: none;
  }
  .note > b { line-height: 1.35; }
</style>
</head>
<body>
${forWord ? '<div class="WordSection1">' : ''}
<h1>주간 추진실적 보고</h1>
<table>
  <colgroup><col style="width:11%"><col style="width:9%"><col style="width:26%"><col style="width:28%"><col style="width:26%"></colgroup>
  <thead><tr>
    <th>기관명</th>
    <th>참여인력</th>
    <th>① 당초 계획${thisRange ? `(${thisRange})` : ''}</th>
    <th>② 추진 실적${thisRange ? `(${thisRange})` : ''}</th>
    <th>향후 계획${nextRange ? `(${nextRange})` : ''}</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="5">등록된 항목이 없습니다.</td></tr>'}</tbody>
</table>
${report.note ? `<div class="note"><b>특이사항</b><br>${esc(report.note).replace(/\n/g, '<br>')}</div>` : ''}
${files.length ? `<div class="note">
  <b>증적자료 (${files.length}건)</b>
  ${forWord
    // Word 는 <ol> 에 자체 목록 들여쓰기·문단 간격을 강제 적용하므로 직접 번호를 붙인다
    ? files.map((f, i) => `<div class="fitem">${i + 1}. ${esc(f.original_name)}</div>`).join('')
    : `<ol class="files">${files.map((f) => `<li>${esc(f.original_name)}</li>`).join('')}</ol>`}
</div>` : ''}
${forWord ? '</div>' : ''}
</body></html>`;
}

/**
 * HWPX 변환용 HTML 로 다듬는다.
 * hwp-convert 는 표 칸 안의 <div>/<p> 를 한 문단으로 합쳐 버리므로
 * 줄바꿈은 <br>, 들여쓰기는 앞쪽 &nbsp; 로 바꿔서 넘긴다.
 */
function toHwpxCell(html) {
  if (!html) return '';
  const SPACE_PX = 4;                     // 공백 한 칸 대략 폭

  // 블록 요소를 줄 단위로 자른다
  const lines = String(html)
    .replace(/<br\s*\/?>/gi, '\n@@BR@@\n')
    .split(/(?=<(?:div|p|li)\b)/i)
    .flatMap((chunk) => {
      const m = /<(?:div|p|li)\b([^>]*)>([\s\S]*)/i.exec(chunk);
      if (!m) return [{ pad: 0, html: chunk }];
      const padM = /padding-left\s*:\s*([\d.]+)px/i.exec(m[1]);
      const marM = /margin-left\s*:\s*([\d.]+)px/i.exec(m[1]);
      const pad = Number((padM && padM[1]) || (marM && marM[1]) || 0);
      return [{ pad, html: m[2] }];
    });

  return lines.map(({ pad, html: body }) => {
    const inner = String(body)
      .replace(/<\/(?:div|p|li|ul|ol)>/gi, '')
      .replace(/@@BR@@/g, '<br>')
      .replace(/\n/g, '')
      .trim();
    if (!inner) return '';
    const indent = '&nbsp;'.repeat(Math.min(Math.round(pad / SPACE_PX), 24));
    return indent + inner;
  }).filter(Boolean).join('<br>');
}

/**
 * hwp-convert 가 만든 HWPX 의 표 레이아웃을 보정한다.
 *
 * 라이브러리는 (1) 가로 방향 플래그만 켜고 용지 크기는 세로 그대로 두며,
 * (2) 모든 열을 같은 폭으로 나누고, (3) 테두리 없는 borderFill 을 쓴다.
 * 그 결과 한글에서 열면 표가 좁게 뭉개져 보인다.
 * 생성된 XML 을 직접 고쳐 가로 A4 · 열 비율 · 실선 테두리를 적용한다.
 *
 * 단위는 HWPUNIT (1mm = 283.465)
 */
async function fixHwpxLayout(buf, ratios) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);

  const PAGE_W = 59528;                  // A4 세로 — 폭 210mm
  const PAGE_H = 84186;                  // A4 세로 — 높이 297mm
  const MARGIN = 2835;                   // 상하좌우 10mm
  const HEAD_FOOT = 1417;                // 머리말·꼬리말 5mm
  const CONTENT = PAGE_W - MARGIN * 2;
  const HEAD_FILL = '#FFFBCC';           // 표 제목 배경 (인쇄본과 동일)

  // ---------- header.xml : 글자 크기·줄간격·정렬·표 제목 배경 ----------
  let head = await zip.file('Contents/header.xml').async('string');

  // 본문 9pt / 제목 10pt. (charPr 0=본문, 1=굵은 제목)
  head = head.replace(/<hh:charPr id="0" height="\d+"/, '<hh:charPr id="0" height="900"');
  head = head.replace(/<hh:charPr id="2" height="\d+"/, '<hh:charPr id="2" height="900"');
  head = head.replace(/<hh:charPr id="4" height="\d+"/, '<hh:charPr id="4" height="900"');
  head = head.replace(/<hh:charPr id="1" height="\d+"/, '<hh:charPr id="1" height="1000"');
  head = head.replace(/<hh:charPr id="3" height="\d+"/, '<hh:charPr id="3" height="1000"');
  head = head.replace(/<hh:charPr id="5" height="\d+"/, '<hh:charPr id="5" height="1500"');

  // 양쪽 정렬이면 글자 사이가 벌어진다. 왼쪽 정렬로.
  head = head.replace(/horizontal="JUSTIFY"/g, 'horizontal="LEFT"');
  // 줄간격 160% → 130%
  head = head.replace(/(<hh:lineSpacing type="PERCENT" value=")\d+/g, '$1150');

  // 표 제목 칸 배경색용 borderFill 추가 (실선 테두리 + 연노랑 채우기)
  const solid = /<hh:borderFill id="2"[\s\S]*?<\/hh:borderFill>/.exec(head);
  let headFillId = 2;
  if (solid) {
    const cntM = /<hh:borderFills itemCnt="(\d+)"/.exec(head);
    headFillId = cntM ? Number(cntM[1]) + 1 : 3;
    const filled = solid[0]
      .replace(/id="2"/, `id="${headFillId}"`)
      .replace('</hh:borderFill>',
        `<hc:fillBrush><hc:winBrush faceColor="${HEAD_FILL}" hatchColor="#000000" alpha="0"/>` +
        `</hc:fillBrush></hh:borderFill>`);
    head = head.replace('</hh:borderFills>', `${filled}</hh:borderFills>`);
    if (cntM) head = head.replace(/(<hh:borderFills itemCnt=")\d+/, `$1${headFillId}`);
  }
  // 가운데 정렬용 문단 모양 추가 (표 제목 행, 기관명·참여인력 칸에 쓴다)
  let centerParaId = 0;
  const para0 = /<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/.exec(head);
  if (para0) {
    const cntM = /<hh:paraProperties itemCnt="(\d+)"/.exec(head);
    centerParaId = cntM ? Number(cntM[1]) : 1;
    const centered = para0[0]
      .replace(/id="0"/, `id="${centerParaId}"`)
      .replace(/horizontal="[A-Z]*"/, 'horizontal="CENTER"');
    head = head.replace('</hh:paraProperties>', `${centered}</hh:paraProperties>`);
    if (cntM) head = head.replace(/(<hh:paraProperties itemCnt=")\d+/, `$1${centerParaId + 1}`);
  }

  zip.file('Contents/header.xml', head);

  // ---------- section0.xml : 용지·여백·표 크기·셀 여백 ----------
  let xml = await zip.file('Contents/section0.xml').async('string');

  // landscape 속성도 세로(NARROWLY)로 맞춘다
  xml = xml.replace(/(<hp:pagePr[^>]*?)landscape="[A-Z]*"/, '$1landscape="NARROWLY"');
  xml = xml.replace(/(<hp:pagePr[^>]*?)width="\d+" height="\d+"/,
    `$1width="${PAGE_W}" height="${PAGE_H}"`);
  xml = xml.replace(/<hp:margin[^>]*\/>/,
    `<hp:margin header="${HEAD_FOOT}" footer="${HEAD_FOOT}" gutter="0" ` +
    `left="${MARGIN}" right="${MARGIN}" top="${MARGIN}" bottom="${MARGIN}"/>`);
  xml = xml.replace(/(<hp:sz )width="\d+"( widthRelTo="ABSOLUTE")/g, `$1width="${CONTENT}"$2`);

  // 열 비율대로 셀 폭 배분 (병합 셀은 걸친 열 폭의 합)
  const widths = ratios.map((r) => Math.round(CONTENT * r));
  widths[widths.length - 1] = CONTENT - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  xml = xml.replace(
    /<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"\/><hp:cellSz width="\d+"/g,
    (mm, col, row, cspan) => {
      let w = 0;
      for (let i = 0; i < Number(cspan); i++) w += widths[Number(col) + i] || 0;
      return mm.replace(/<hp:cellSz width="\d+"/, `<hp:cellSz width="${w}"`);
    });

  // 셀 안쪽 여백을 넓혀 글자가 선에 붙지 않게 한다
  // hasMargin="0" 이면 셀별 여백을 무시하므로 반드시 1 로 켜야 한다
  xml = xml.replace(/(<hp:tc [^>]*)hasMargin="0"/g, '$1hasMargin="1"');

  // Word 의 셀 여백(6x7px)과 비슷하게 : 좌우 2mm, 상하 1.5mm
  xml = xml.replace(/<hp:cellMargin[^>]*\/>/g,
    '<hp:cellMargin left="566" right="566" top="425" bottom="425"/>');
  xml = xml.replace(/<hp:inMargin[^>]*\/>/g,
    '<hp:inMargin left="566" right="566" top="425" bottom="425"/>');

  // 모든 칸에 실선 테두리, 제목 행(rowAddr=0)은 배경색 있는 테두리
  xml = xml.replace(/(<hp:tbl [^>]*borderFillIDRef=")1(")/g, '$12$2');
  xml = xml.replace(/<hp:tc ([^>]*)borderFillIDRef="\d+"([^>]*)>([\s\S]*?)<\/hp:tc>/g,
    (mm, a, b, body) => {
      const isHead = /rowAddr="0"/.test(body);
      // 제목 행과 기관명(0)·참여인력(1) 칸은 가운데 정렬
      const isLabel = /colAddr="[01]"/.test(body);
      const id = isHead ? headFillId : 2;

      let inner = body;
      if ((isHead || isLabel) && centerParaId) {
        inner = inner.replace(/(<hp:p [^>]*paraPrIDRef=")\d+/g, `$1${centerParaId}`);
      }
      // 세로 가운데 정렬
      inner = inner.replace(/(<hp:subList [^>]*vertAlign=")[A-Z]*/g, '$1CENTER');

      return `<hp:tc ${a}borderFillIDRef="${id}"${b}>${inner}</hp:tc>`;
    });

  xml = xml.replace(/horzsize="\d+"/g, `horzsize="${CONTENT}"`);

  // ---------- 재압축 (mimetype 은 첫 항목·무압축이어야 한글이 인식) ----------
  const out = new JSZip();
  out.file('mimetype', await zip.file('mimetype').async('string'), { compression: 'STORE' });
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name];
    if (name === 'mimetype' || f.dir) continue;
    let data;
    if (name === 'Contents/section0.xml') data = xml;
    else if (name === 'Contents/header.xml') data = head;
    else data = await f.async('nodebuffer');
    out.file(name, data, { compression: 'DEFLATE' });
  }
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** HWPX 변환에 넘길 문서 HTML (표 칸 내용만 위 규칙으로 치환) */
function buildHwpxHtml(report, items, files, nextWeek) {
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const thisRange = fmtRange(report.start_date, report.end_date);
  const nextRange = nextWeek ? fmtRange(nextWeek.start_date, nextWeek.end_date) : '';
  const n = items.length || 1;

  const rows = items.map((it, i) => `
    <tr>
      ${i === 0 ? `<td rowspan="${n}">${esc(report.org_name)}</td>
      <td rowspan="${n}">${esc(report.author_name || '-')}</td>` : ''}
      <td>${toHwpxCell(it.plan_html)}</td>
      <td>${toHwpxCell(it.result_html)}</td>
      <td>${toHwpxCell(it.next_plan_html)}</td>
    </tr>`).join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>주간 추진실적 보고</title></head><body>
<h1>주간 추진실적 보고</h1>
<table border="1">
  <thead><tr>
    <th>기관명</th><th>참여인력</th>
    <th>① 당초 계획${thisRange ? `(${thisRange})` : ''}</th>
    <th>② 추진 실적${thisRange ? `(${thisRange})` : ''}</th>
    <th>향후 계획${nextRange ? `(${nextRange})` : ''}</th>
  </tr></thead>
  <tbody>${rows || '<tr><td>등록된 항목이 없습니다.</td></tr>'}</tbody>
</table>
${report.note ? `<p><b>특이사항</b></p>${
  esc(report.note).split('\n').map((t) => `<p>${t}</p>`).join('')}` : ''}
${files.length ? `<p><b>증적자료 (${files.length}건)</b></p>${
  files.map((f, i) => `<p>${i + 1}. ${esc(f.original_name)}</p>`).join('')}` : ''}
</body></html>`;
}

/** 파일명에 쓸 수 없는 문자 정리 */
function safeFileName(v) {
  return String(v || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ---------------------------------------------------------------------
// GET /api/reports/:id/print  — 인쇄용 화면
// ---------------------------------------------------------------------
router.get('/:id(\\d+)/print', async (req, res, next) => {
  try {
    const report = await loadReport(Number(req.params.id));
    if (!report) return res.status(404).send('보고서를 찾을 수 없습니다.');
    if (!canViewReport(req.user, report)) return res.status(403).send('열람 권한이 없습니다.');
    const items = await loadItems(report.id);
    const files = await loadAttachments(report.id);
    const nextWeek = await loadNextWeek(report.start_date);
    res.type('html').send(buildReportHtml(report, items, files, { forWord: false, nextWeek }));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/reports/:id/export  — Word 문서로 다운로드 (한글에서도 열림)
// ---------------------------------------------------------------------
router.get('/:id(\\d+)/export', async (req, res, next) => {
  try {
    const report = await loadReport(Number(req.params.id));
    if (!report) return res.status(404).send('보고서를 찾을 수 없습니다.');
    if (!canViewReport(req.user, report)) return res.status(403).send('열람 권한이 없습니다.');
    const items = await loadItems(report.id);
    const files = await loadAttachments(report.id);

    const nextWeek = await loadNextWeek(report.start_date);
    const html = buildReportHtml(report, items, files, { forWord: true, nextWeek });
    const name = safeFileName(`${report.org_name}_주간보고_${report.week_label}`) + '.doc';

    await audit.log(req, 'REPORT_EXPORT', { targetType: 'report', targetId: report.id, detail: name });

    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="report.doc"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send('﻿' + html);   // Word 가 UTF-8 로 인식하도록 BOM
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/reports/:id/export-hwpx  — 한글 문서(HWPX)로 다운로드
// ---------------------------------------------------------------------
router.get('/:id(\\d+)/export-hwpx', async (req, res, next) => {
  try {
    const report = await loadReport(Number(req.params.id));
    if (!report) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
    if (!canViewReport(req.user, report)) return res.status(403).json({ error: '열람 권한이 없습니다.' });

    const items = await loadItems(report.id);
    const files = await loadAttachments(report.id);
    const nextWeek = await loadNextWeek(report.start_date);

    // hwp-convert 는 ESM 전용이라 동적 import 로 불러온다
    const { htmlToHwpx } = await import('hwp-convert');
    const html = buildHwpxHtml(report, items, files, nextWeek);
    const out = await htmlToHwpx(html);
    // 기관명 11% / 참여인력 9% / 계획 26% / 실적 28% / 향후 26%
    const buf = await fixHwpxLayout(
      Buffer.isBuffer(out) ? out : Buffer.from(out),
      [0.11, 0.09, 0.26, 0.28, 0.26]
    );

    const name = safeFileName(`${report.org_name}_주간보고_${report.week_label}`) + '.hwpx';
    await audit.log(req, 'REPORT_EXPORT_HWPX', { targetType: 'report', targetId: report.id, detail: name });

    res.setHeader('Content-Type', 'application/hwp+zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="report.hwpx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.end(buf);
  } catch (err) {
    console.error('[hwpx] 변환 실패:', err.message);
    res.status(500).json({ error: '한글 문서로 변환하지 못했습니다. Word 다운로드를 이용해 주세요.' });
  }
});

module.exports = router;
module.exports.canViewReport = canViewReport;
