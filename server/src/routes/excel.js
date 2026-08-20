'use strict';

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { sanitizeHtml } = require('../lib/sanitize');

const router = express.Router();
router.use(auth.requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    try { file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch { /* 원본 유지 */ }
    if (!String(file.originalname).toLowerCase().endsWith('.xlsx')) {
      return cb(new Error('Excel .xlsx 파일만 업로드할 수 있습니다.'));
    }
    cb(null, true);
  },
});

// 양식은 딱 세 칸이다. 주차는 화면에서 고른 값을 쓰므로 엑셀에 날짜 열을 두지 않는다.
const COLUMNS = [
  { header: '① 당초 계획', key: 'plan',   width: 52 },
  { header: '② 추진 실적', key: 'result', width: 52 },
  { header: '③ 향후 계획', key: 'next',   width: 52 },
];

const SAMPLE = {
  plan: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n'
      + '■ 규제 도메인 구조 설계(~9/30)\n■ 온톨로지 모델 설계(~9/30)\n■ 지식-Rule 연계 설계(~9/30)',
  result: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n'
      + '■ 온톨로지 모델 설계\n- 용도지역지구별 관련법령 수집\n- 수집 법령의 관계 구성 및 추가\n'
      + '■ 지식-Rule 연계 설계\n- Rule engine 적용 항목 분류',
  next: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n'
      + '■ 규제 도메인 구조 설계 계속\n■ 온톨로지 모델 보완\n■ 지식-Rule 연계 설계 계속',
};

/** 셀 값을 평문으로 (수식·리치텍스트·하이퍼링크 대응) */
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
  if (v.text != null) return String(v.text);
  if (v.result != null) return String(v.result);
  if (v.hyperlink) return String(v.hyperlink);
  return '';
}

/**
 * 줄머리 기호에 따른 들여쓰기 단계.
 * 엑셀 셀에서는 앞 공백을 넣기 번거롭고, 넣어도 HTML 에서는 공백이 합쳐져 사라진다.
 * 그래서 기호를 보고 자동으로 단계를 매긴다.
 *    ■ ◼ ▪ ● □ ○  → 1단계
 *    - – — · *      → 2단계
 *    그 외          → 0단계 (다만 직접 넣은 앞 공백이 있으면 그만큼 반영)
 */
const INDENT_PX = 8;   // 1단계 8px, 2단계 16px (공백 2칸 / 4칸 정도)

function lineIndentLevel(line) {
  const body = line.replace(/^[\s\u00a0]+/, '');
  if (/^[■◼▪●□○◆◇]/.test(body)) return 1;
  if (/^[-–—·*]\s*/.test(body)) return 2;

  const lead = (line.match(/^[\s\u00a0]*/) || [''])[0].replace(/\t/g, '  ').length;
  return lead >= 2 ? Math.min(Math.floor(lead / 2), 4) : 0;
}

/** 줄바꿈이 있는 평문을 보고서 본문 HTML 로 (한 줄 = 한 단락, 기호별 들여쓰기 적용) */
function textToHtml(v) {
  const text = cellText(v).replace(/\r\n?/g, '\n').replace(/[\s\u00a0]+$/, '');
  if (!text.trim()) return '';
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = text.split('\n').map((line) => {
    const level = lineIndentLevel(line);
    const body = esc(line.replace(/^[\s\u00a0]+/, ''));
    const style = level ? ` style="padding-left: ${level * INDENT_PX}px"` : '';
    return `<div${style}>${body || '<br>'}</div>`;
  }).join('');

  return sanitizeHtml(html);
}

// ---------------------------------------------------------------------
// GET /api/reports/excel/template  — 입력 양식 내려받기 (3열)
// ---------------------------------------------------------------------
router.get('/template', async (req, res, next) => {
  try {
    const book = new ExcelJS.Workbook();
    book.creator = '주간실적 보고 시스템';

    const sheet = book.addWorksheet('주간보고');
    sheet.columns = COLUMNS;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const head = sheet.getRow(1);
    head.height = 26;
    head.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FA9' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
    });

    // 1행: 바로 고쳐 쓸 수 있는 작성 예시
    const sample = sheet.addRow(SAMPLE);
    sample.height = 120;

    // 입력 행 100개에 서식 지정 (줄바꿈 표시 + 위쪽 정렬)
    for (let r = 2; r <= 101; r++) {
      const row = sheet.getRow(r);
      if (r > 2) row.height = 90;
      for (let c = 1; c <= COLUMNS.length; c++) {
        row.getCell(c).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(c).border = {
          top: { style: 'hair', color: { argb: 'FFCCCCCC' } },
          bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } },
          left: { style: 'hair', color: { argb: 'FFCCCCCC' } },
          right: { style: 'hair', color: { argb: 'FFCCCCCC' } },
        };
      }
    }

    const guide = book.addWorksheet('작성안내');
    guide.columns = [{ width: 100 }];
    [
      '■ 주간보고 Excel 양식 안내',
      '',
      '1. [주간보고] 시트의 세 칸만 채우면 됩니다.',
      '     ① 당초 계획   ② 추진 실적   ③ 향후 계획',
      '',
      '2. 보고 주차는 엑셀에 적지 않습니다.',
      '     웹 화면에서 [보고 주차] 를 고른 뒤 [Excel 일괄등록] 을 누르면',
      '     그 주차의 보고서로 바로 등록됩니다.',
      '',
      '3. 한 행이 보고서의 한 항목(순번 1, 2, 3 …) 이 됩니다.',
      '     셀 안에서 줄을 바꾸려면 Alt + Enter 를 사용하세요. 줄바꿈은 그대로 반영됩니다.',
      '',
      '4. 세 칸이 모두 빈 행은 건너뜁니다.',
      '',
      '5. 1행의 예시는 지우고 쓰시거나, 내용만 고쳐서 쓰셔도 됩니다.',
      '',
      '※ 등록하면 해당 주차에 이미 있던 내용은 Excel 내용으로 교체됩니다.',
    ].forEach((line) => {
      const row = guide.addRow([line]);
      if (line.startsWith('■')) row.getCell(1).font = { bold: true, size: 12 };
      if (line.startsWith('※')) row.getCell(1).font = { color: { argb: 'FFC0392B' }, bold: true };
    });

    const buf = await book.xlsx.writeBuffer();
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="weekly-report-template.xlsx"; filename*=UTF-8''${encodeURIComponent('주간보고_양식.xlsx')}`);
    res.end(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 업로드된 통합문서에서 항목 배열을 뽑아낸다
// ---------------------------------------------------------------------
async function parseItems(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);

  const sheet = book.getWorksheet('주간보고') || book.worksheets[0];
  if (!sheet) throw new Error('시트를 찾을 수 없습니다.');

  // 헤더 행에서 세 칸의 열 번호를 찾는다 (열 순서가 바뀌어도 동작)
  const idx = { plan: 0, result: 0, next: 0 };
  sheet.getRow(1).eachCell((cell, col) => {
    const t = cellText(cell.value).replace(/\s/g, '');
    if (t.includes('당초계획')) idx.plan = col;
    else if (t.includes('추진실적')) idx.result = col;
    else if (t.includes('향후계획')) idx.next = col;
  });
  if (!idx.plan && !idx.result && !idx.next) {
    // 헤더가 없으면 A·B·C 열로 간주
    idx.plan = 1; idx.result = 2; idx.next = 3;
  }

  const items = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;                       // 헤더
    if (items.length >= 100) return;
    const plan   = idx.plan   ? textToHtml(row.getCell(idx.plan).value)   : '';
    const result = idx.result ? textToHtml(row.getCell(idx.result).value) : '';
    const next   = idx.next   ? textToHtml(row.getCell(idx.next).value)   : '';
    if (!plan && !result && !next) return;     // 빈 행은 건너뛴다
    items.push({ plan_html: plan, result_html: result, next_plan_html: next });
  });
  return items;
}

// ---------------------------------------------------------------------
// POST /api/reports/excel/import  — 선택한 주차에 바로 등록
//   multipart: file, week_id
// ---------------------------------------------------------------------
router.post('/import', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Excel 파일을 선택하세요.' });

    try {
      const weekId = Number(req.body?.week_id);
      if (!weekId) return res.status(400).json({ error: '보고 주차를 먼저 선택하세요.' });
      // 전체 관리자는 요청한 기관으로, 그 외는 본인 소속으로 저장한다
      let orgId = req.user.org_id;
      if (req.user.role === 'ADMIN' && req.body?.org_id) {
        const { rows: o } = await db.query(
          `SELECT id FROM wr.organizations WHERE id = $1 AND is_active = TRUE`,
          [Number(req.body.org_id)]
        );
        if (!o[0]) return res.status(400).json({ error: '선택할 수 없는 기관입니다.' });
        orgId = o[0].id;
      }

      if (!orgId) {
        return res.status(400).json({ error: '소속 기관이 없습니다. 내 정보에서 소속을 지정하세요.' });
      }

      const { rows: wk } = await db.query(
        `SELECT id, label FROM wr.report_weeks WHERE id = $1`, [weekId]
      );
      if (!wk[0]) return res.status(400).json({ error: '존재하지 않는 주차입니다.' });

      const items = await parseItems(req.file.buffer);
      if (!items.length) {
        return res.status(400).json({ error: '등록할 내용이 없습니다. 세 칸을 모두 채워주세요.' });
      }
      // 화면에서 저장할 때와 같은 규칙 : 세 칸을 모두 채워야 등록된다
      const missing = require('./reports').findEmptyCell(items);
      if (missing) return res.status(400).json({ error: `엑셀 ${missing}` });

      const reportId = await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO wr.reports (week_id, org_id, author_id, status)
           VALUES ($1, $2, $3, 'SUBMITTED')
           ON CONFLICT (week_id, author_id) WHERE author_id IS NOT NULL DO UPDATE
              SET org_id = EXCLUDED.org_id, status = 'SUBMITTED',
                  submitted_at = COALESCE(reports.submitted_at, now())
           RETURNING id`,
          [weekId, orgId, req.user.id]
        );
        const id = rows[0].id;

        // 해당 주차 내용은 Excel 내용으로 교체한다
        await client.query(`UPDATE wr.attachments SET item_id = NULL WHERE report_id = $1`, [id]);
        await client.query(`DELETE FROM wr.report_items WHERE report_id = $1`, [id]);

        for (let i = 0; i < items.length; i++) {
          await client.query(
            `INSERT INTO wr.report_items
               (report_id, sort_order, task_title, plan_html, result_html, next_plan_html)
             VALUES ($1, $2, '', $3, $4, $5)`,
            [id, i, items[i].plan_html, items[i].result_html, items[i].next_plan_html]
          );
        }
        return id;
      });

      await audit.log(req, 'EXCEL_IMPORT', {
        targetType: 'report', targetId: reportId,
        detail: `${req.file.originalname} → ${wk[0].label} / ${items.length}건`,
      });

      res.json({
        ok: true, report_id: reportId, week_label: wk[0].label, count: items.length,
        message: `${wk[0].label} 에 ${items.length}건이 등록되었습니다.`,
      });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Excel 파일을 읽을 수 없습니다.' });
    }
  });
});

module.exports = router;
