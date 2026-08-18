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

/** 조회 범위: 작성자·기관관리자는 자기 기관, 전체 관리자는 전부 */
function viewScopeOrg(user) {
  return user.role === 'ADMIN' ? null : (user.org_id || -1);
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
    `SELECT id, sort_order, task_title, plan_html, result_html
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
    // 업무명도 계획/실적과 같은 편집기를 쓰므로 동일하게 정제한다
    task_title: trimTitleIndent(sanitizeHtml(it.task_title, { maxLength: 20000 })),
    plan_html: sanitizeHtml(it.plan_html),
    result_html: sanitizeHtml(it.result_html),
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
            SET sort_order = $1, task_title = $2, plan_html = $3, result_html = $4
          WHERE id = $5 AND report_id = $6`,
        [it.sort_order, it.task_title, it.plan_html, it.result_html, it.id, reportId]
      );
      keptIds.add(it.id);
      idMap[it.sort_order] = it.id;
    } else {
      const { rows } = await client.query(
        `INSERT INTO wr.report_items (report_id, sort_order, task_title, plan_html, result_html)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [reportId, it.sort_order, it.task_title, it.plan_html, it.result_html]
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

    // 전체 관리자가 아니면 자기 기관 보고서만 볼 수 있다
    const scope = viewScopeOrg(req.user);
    if (scope) { params.push(scope); where.push(`r.org_id = $${params.length}`); }
    else if (req.query.org_id) { params.push(Number(req.query.org_id)); where.push(`r.org_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      const i = params.length;
      where.push(`EXISTS (
        SELECT 1 FROM wr.report_items ri
         WHERE ri.report_id = r.id
           AND (ri.task_title ILIKE $${i} OR ri.plan_html ILIKE $${i} OR ri.result_html ILIKE $${i})
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
             (SELECT string_agg(
                        btrim(regexp_replace(
                          replace(replace(ri.task_title, '&nbsp;', ' '), '&amp;', '&'),
                          '<[^>]*>', ' ', 'g')), ' / ' ORDER BY ri.sort_order, ri.id)
                FROM wr.report_items ri WHERE ri.report_id = r.id) AS titles,
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

    // 전체 관리자가 아니면 자기 기관 보고서만 열람할 수 있다
    const scope = viewScopeOrg(req.user);
    if (scope && Number(report.org_id) !== Number(scope)) {
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
// 보고서 문서 HTML 생성 (인쇄 / Word 다운로드 공용)
//   forWord=true 이면 Word·한글이 페이지 설정을 인식하도록 mso 지시문을 넣는다.
// ---------------------------------------------------------------------
function buildReportHtml(report, items, files, { forWord = false } = {}) {
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = items.map((it) => `
      <tr>
        <td class="title">${it.task_title || ''}</td>
        <td class="cell">${it.plan_html || ''}</td>
        <td class="cell">${it.result_html || ''}</td>
      </tr>`).join('');

  // 인쇄: @page 여백 0 → 브라우저가 머리글(날짜)/바닥글(URL)을 넣지 않는다
  // Word : WordSection1 으로 가로 방향 A4 지정
  const pageCss = forWord
    ? `@page WordSection1 { size: 29.7cm 21.0cm; mso-page-orientation: landscape; margin: 1.2cm 1.0cm; }
  div.WordSection1 { page: WordSection1; }`
    : `@page { size: A4 landscape; margin: 0; }
  body { padding: 12mm 10mm; }`;

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
  h1 { font-size: 15pt; margin: 0 0 4px; }
  .meta { color: #555; font-size: 9pt; margin-bottom: 10px; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td {
    border: 1px solid #333; padding: 6px 7px; vertical-align: top;
    overflow-wrap: anywhere; word-break: break-word;
  }
  th { background: #fffbcc; text-align: center; font-weight: 700; }
  td.title { background: #fcfcf0; font-weight: 600; }

  td img { max-width: 100%; height: auto; }
  td table { width: 100%; table-layout: fixed; font-size: 9.5pt; }
  td pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
  td ul, td ol { margin: 3px 0; padding-left: 18px; }
  td p { margin: 0 0 3px; }

  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }

  .note { margin-top: 12px; font-size: 10pt; page-break-inside: avoid; break-inside: avoid; }
  ol.files { margin: 5px 0 0; padding-left: 20px; font-size: 9.5pt; }
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
<div class="meta">기관: ${esc(report.org_name)} &nbsp;|&nbsp; 기간: ${esc(report.week_label)} &nbsp;|&nbsp; 작성자: ${esc(report.author_name || '-')} &nbsp;|&nbsp; 상태: ${report.status === 'SUBMITTED' ? '제출완료' : '임시저장'}</div>
<table>
  <colgroup><col style="width:25%"><col style="width:34%"><col style="width:41%"></colgroup>
  <thead><tr><th>업무명</th><th>① 당초 계획</th><th>② 추진 실적</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3">등록된 항목이 없습니다.</td></tr>'}</tbody>
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
    const items = await loadItems(report.id);
    const files = await loadAttachments(report.id);
    res.type('html').send(buildReportHtml(report, items, files, { forWord: false }));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// GET /api/reports/:id/export  — Word 문서로 다운로드 (한글에서도 열림)
// ---------------------------------------------------------------------
router.get('/:id(\\d+)/export', async (req, res, next) => {
  try {
    const report = await loadReport(Number(req.params.id));
    if (!report) return res.status(404).send('보고서를 찾을 수 없습니다.');
    const items = await loadItems(report.id);
    const files = await loadAttachments(report.id);

    const html = buildReportHtml(report, items, files, { forWord: true });
    const name = safeFileName(`${report.org_name}_주간보고_${report.week_label}`) + '.doc';

    await audit.log(req, 'REPORT_EXPORT', { targetType: 'report', targetId: report.id, detail: name });

    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="report.doc"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send('﻿' + html);   // Word 가 UTF-8 로 인식하도록 BOM
  } catch (err) { next(err); }
});

module.exports = router;
