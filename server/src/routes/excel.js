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
    const name = String(file.originalname || '').toLowerCase();
    if (!name.endsWith('.xlsx')) return cb(new Error('Excel .xlsx 파일만 업로드할 수 있습니다.'));
    cb(null, true);
  },
});

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (value && typeof value === 'object') {
    if (value.result != null) return isoDate(value.result);
    if (value.text != null) return isoDate(value.text);
  }
  const s = String(value == null ? '' : value).trim().replace(/[./]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const out = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out ? null : out;
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((x) => x.text || '').join('');
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
    if (value.hyperlink) return String(value.text || value.hyperlink);
  }
  return String(value);
}

function textHtml(value) {
  const text = cellText(value).trim().slice(0, 200000);
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sanitizeHtml(escaped.replace(/\r?\n/g, '<br>'));
}

function parseStatus(value) {
  const s = cellText(value).trim().toUpperCase().replace(/\s+/g, '');
  return ['SUBMITTED', '제출', '제출완료', '완료'].includes(s) ? 'SUBMITTED' : 'DRAFT';
}

async function parseWorkbook(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.getWorksheet('주간보고') || book.worksheets.find((s) => s.state === 'visible');
  if (!sheet) throw new Error('읽을 수 있는 시트가 없습니다.');

  const headers = {};
  sheet.getRow(1).eachCell((cell, col) => { headers[cellText(cell.value).trim()] = col; });
  const required = ['① 당초 계획', '② 추진 실적', '③ 향후 계획'];
  const missing = required.filter((h) => !headers[h]);
  if (missing.length) throw new Error(`필수 열이 없습니다: ${missing.join(', ')}`);
  const endDateColumn = headers['주차 종료일(자동입력)'] || headers['주차 종료일'];

  const grouped = new Map();
  const errors = [];
  let itemCount = 0;
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo++) {
    const row = sheet.getRow(rowNo);
    if (headers['양식구분'] && cellText(row.getCell(headers['양식구분']).value).trim() === 'EXAMPLE') continue;
    const weekLabel = headers['주차'] ? cellText(row.getCell(headers['주차']).value).trim() : '';
    const startRaw = headers['주차 시작일'] ? row.getCell(headers['주차 시작일']).value : null;
    const endRaw = endDateColumn ? row.getCell(endDateColumn).value : null;
    const plan = textHtml(row.getCell(headers['① 당초 계획']).value);
    const result = textHtml(row.getCell(headers['② 추진 실적']).value);
    const next = textHtml(row.getCell(headers['③ 향후 계획']).value);
    // 양식에는 모든 대상 주차의 날짜가 미리 들어 있다. 내용이 없는 주차는 건너뛴다.
    if (!plan && !result && !next) continue;

    const startDate = isoDate(startRaw);
    const endDate = isoDate(endRaw);
    if (!weekLabel && !startDate) {
      errors.push({ row: rowNo, message: '주차 시작일을 선택하세요.' });
      continue;
    }
    const key = weekLabel || `${startDate}:${endDate}`;
    if (!grouped.has(key)) grouped.set(key, {
      week_label_input: weekLabel, start_date: startDate, end_date: endDate,
      statuses: new Set(), items: [],
    });
    const group = grouped.get(key);
    group.statuses.add(parseStatus(headers['저장상태'] ? row.getCell(headers['저장상태']).value : ''));
    group.items.push({ plan_html: plan, result_html: result, next_plan_html: next });
    itemCount++;
    if (itemCount > 1000) throw new Error('한 파일에서 최대 1,000개 업무 행까지 등록할 수 있습니다.');
  }
  if (!grouped.size && !errors.length) throw new Error('등록할 내용이 없습니다.');
  if (grouped.size > 52) throw new Error('한 파일에서 최대 52개 주차까지 등록할 수 있습니다.');
  return { groups: [...grouped.values()], errors };
}

async function enrichGroups(parsed, user) {
  const groups = [];
  for (const g of parsed.groups) {
    const { rows } = await db.query(
      `SELECT w.id AS week_id, w.label, w.start_date, w.end_date, w.is_open,
              r.id AS report_id, r.status AS existing_status,
              (SELECT count(*)::int FROM wr.report_items i WHERE i.report_id = r.id) AS existing_items
         FROM wr.report_weeks w
         LEFT JOIN wr.reports r ON r.week_id = w.id AND r.author_id = $3
        WHERE (($1::text <> '' AND w.label = $1)
           OR  ($1::text = '' AND w.start_date = $2::date
                AND ($4::date IS NULL OR w.end_date = $4::date)))`,
      [g.week_label_input || '', g.start_date, user.id, g.end_date]
    );
    const match = rows[0];
    if (!match) {
      groups.push({ ...g, statuses: undefined, status: [...g.statuses][0] || 'DRAFT', valid: false, error: '등록된 주차와 일치하지 않습니다.' });
      continue;
    }
    const mixed = g.statuses.size > 1;
    groups.push({
      start_date: match.start_date || g.start_date, end_date: match.end_date || g.end_date, week_id: match.week_id,
      week_label: match.label, is_open: match.is_open, report_id: match.report_id,
      existing_status: match.existing_status, existing_items: match.existing_items || 0,
      status: mixed ? 'DRAFT' : ([...g.statuses][0] || 'DRAFT'), items: g.items,
      valid: Boolean(match.is_open || user.role === 'ADMIN'),
      error: (!match.is_open && user.role !== 'ADMIN') ? '마감된 주차입니다.' : (mixed ? '행별 저장상태가 달라 임시저장으로 처리됩니다.' : null),
    });
  }
  return { groups, errors: parsed.errors };
}

router.get('/template', async (req, res, next) => {
  try {
    // 과거 주차를 포함한 전체 주차 목록. 날짜는 DB 주차 마스터를 단일 기준으로 사용한다.
    const { rows: weeks } = await db.query(
      `SELECT id, week_no, label, start_date, end_date, is_open
         FROM wr.report_weeks
        ORDER BY start_date`
    );
    const book = new ExcelJS.Workbook();
    book.creator = '주간실적 보고 시스템';
    book.calcProperties.fullCalcOnLoad = true;
    book.calcProperties.forceFullCalc = true;
    book.calcProperties.calcMode = 'auto';
    const guide = book.addWorksheet('작성안내');
    guide.addRows([
      ['주간보고 엑셀 일괄등록 안내'],
      ['1. 주차 시작일 칸의 드롭다운에서 날짜를 선택하면 종료일이 DB 기준으로 자동 세팅됩니다.'],
      ['2. 작성하려는 주차의 계획·실적·향후계획만 입력하세요. 내용이 없는 행은 자동으로 무시됩니다.'],
      ['3. 여러 주차를 한 파일에 작성하여 한꺼번에 등록할 수 있습니다.'],
      ['4. 한 셀 안에서 Alt+Enter로 줄을 나누어 여러 업무를 작성할 수 있습니다.'],
      ['5. 저장상태는 임시저장 또는 제출완료로 선택합니다. 비우면 임시저장입니다.'],
      ['6. 기존 보고서가 있으면 업로드 미리보기에서 건너뛰기/교체를 선택합니다.'],
    ]);
    guide.getColumn(1).width = 90;
    guide.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1F5FA9' } };

    const lookup = book.addWorksheet('주차목록');
    lookup.state = 'veryHidden';
    lookup.addRow(['시작일', '종료일', '주차', '마감여부']);
    for (const w of weeks) {
      const row = lookup.addRow([
        w.start_date, w.end_date,
        w.label, w.is_open ? '작성가능' : '마감',
      ]);
    }
    if (weeks.length) {
      book.definedNames.add(`'주차목록'!$A$2:$A$${weeks.length + 1}`, '주차선택목록');
    }

    const sheet = book.addWorksheet('주간보고');
    sheet.columns = [
      { header: '주차 시작일', key: 'start', width: 16 },
      { header: '주차 종료일(자동입력)', key: 'end', width: 23 },
      { header: '① 당초 계획', key: 'plan', width: 48 },
      { header: '② 추진 실적', key: 'result', width: 48 },
      { header: '③ 향후 계획', key: 'next', width: 48 },
      { header: '저장상태', key: 'status', width: 14 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = 'A1:F1';
    sheet.getRow(1).height = 28;
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FA9' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    // 주간보고 시트 첫 행에 작성예시를 직접 제공하며, 사용자가 바로 수정해 등록할 수 있다.
    const sampleWeek = weeks.find((w) => w.start_date <= new Date().toISOString().slice(0, 10)
      && new Date().toISOString().slice(0, 10) <= w.end_date) || weeks[0];
    sheet.addRow({
      start: sampleWeek?.start_date || '2026-08-13', end: sampleWeek?.end_date || '2026-08-19',
      plan: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n■ 규제 도메인 구조 설계(~9/30)\n■ 온톨로지 모델 설계(~9/30)\n■ 지식-Rule 연계 설계(~9/30)',
      result: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n■ 온톨로지 모델 설계\n- 용도지역지구별 관련법령 수집\n- 수집 법령의 관계 구성 및 추가\n■ 지식-Rule 연계 설계\n- Rule engine 적용 항목 분류',
      next: '3. 온톨로지 기반 규제 지식체계 설계 및 데이터 구조\n■ 규제 도메인 구조 설계 계속\n■ 온톨로지 모델 보완\n■ 지식-Rule 연계 설계 계속',
      status: '임시저장',
    });
    sheet.getRow(2).height = 125;

    // 예시 행을 포함해 200개 입력 행 제공
    for (let r = 2; r <= 201; r++) {
      sheet.getCell(`A${r}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['주차선택목록'],
        showErrorMessage: true, errorTitle: '시작일 선택 오류', error: '목록에서 주차 시작일을 선택하세요.',
      };
      const endFormula = `IFERROR(VLOOKUP(A${r},'주차목록'!$A$2:$B$${weeks.length + 1},2,FALSE),"")`;
      sheet.getCell(`B${r}`).value = r === 2 && sampleWeek
        ? { formula: endFormula, result: sampleWeek.end_date }
        : { formula: endFormula };
      sheet.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"임시저장,제출완료"'] };
      for (let c = 3; c <= 5; c++) {
        sheet.getCell(r, c).alignment = { wrapText: true, vertical: 'top' };
      }
    }

    for (const target of [sheet]) {
      target.getRow(1).height = 28;
      target.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FA9' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      target.eachRow((row, rowNo) => {
        if (rowNo > 1) row.eachCell((cell) => { cell.alignment = { ...cell.alignment, wrapText: true, vertical: 'top' }; });
      });
    }
    const buffer = await book.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-report-template.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
});

router.post('/preview', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Excel 파일을 선택하세요.' });
    try {
      const parsed = await parseWorkbook(req.file.buffer);
      const preview = await enrichGroups(parsed, req.user);
      await audit.log(req, 'EXCEL_PREVIEW', { detail: `${req.file.originalname} / ${preview.groups.length}주차` });
      res.json(preview);
    } catch (e) { res.status(400).json({ error: e.message || 'Excel 파일을 읽을 수 없습니다.' }); }
  });
});

router.post('/commit', async (req, res, next) => {
  try {
    if (!req.user.org_id) return res.status(400).json({ error: '소속 기관이 없습니다.' });
    const mode = req.body?.mode === 'replace' ? 'replace' : 'skip';
    const rawGroups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 52) : [];
    if (!rawGroups.length) return res.status(400).json({ error: '저장할 주차가 없습니다.' });

    const parsed = { errors: [], groups: rawGroups.map((g) => ({
      start_date: isoDate(g.start_date), end_date: isoDate(g.end_date),
      statuses: new Set([g.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT']),
      items: Array.isArray(g.items) ? g.items.slice(0, 100).map((it) => ({
        plan_html: sanitizeHtml(it.plan_html), result_html: sanitizeHtml(it.result_html),
        next_plan_html: sanitizeHtml(it.next_plan_html),
      })).filter((it) => it.plan_html || it.result_html || it.next_plan_html) : [],
    })) };
    if (parsed.groups.some((g) => !g.start_date || !g.end_date || !g.items.length)) {
      return res.status(400).json({ error: '주차 또는 업무 내용이 올바르지 않습니다. 다시 미리보기 하세요.' });
    }
    const checked = await enrichGroups(parsed, req.user);
    const invalid = checked.groups.filter((g) => !g.valid);
    if (invalid.length) return res.status(400).json({ error: invalid.map((g) => `${g.start_date}: ${g.error}`).join('\n') });

    const result = await db.tx(async (client) => {
      const saved = []; const skipped = [];
      for (const g of checked.groups) {
        if (g.report_id && mode === 'skip') { skipped.push(g.week_label); continue; }
        const { rows } = await client.query(
          `INSERT INTO wr.reports (week_id, org_id, author_id, status, submitted_at)
           VALUES ($1,$2,$3,$4::varchar,CASE WHEN $4::varchar='SUBMITTED' THEN now() ELSE NULL END)
           ON CONFLICT (week_id, author_id) WHERE author_id IS NOT NULL DO UPDATE
              SET org_id=EXCLUDED.org_id, status=EXCLUDED.status,
                  submitted_at=CASE WHEN EXCLUDED.status='SUBMITTED' THEN now() ELSE NULL END
           RETURNING id`,
          [g.week_id, req.user.org_id, req.user.id, g.status]
        );
        const reportId = rows[0].id;
        if (g.report_id && mode === 'replace') {
          await client.query(`UPDATE wr.attachments SET item_id=NULL WHERE report_id=$1`, [reportId]);
          await client.query(`DELETE FROM wr.report_items WHERE report_id=$1`, [reportId]);
        }
        for (let i = 0; i < g.items.length; i++) {
          const it = g.items[i];
          await client.query(
            `INSERT INTO wr.report_items (report_id,sort_order,task_title,plan_html,result_html,next_plan_html)
             VALUES ($1,$2,'',$3,$4,$5)`, [reportId, i, it.plan_html, it.result_html, it.next_plan_html]
          );
        }
        saved.push({ week_id: g.week_id, week_label: g.week_label, report_id: reportId, items: g.items.length });
      }
      return { saved, skipped };
    });
    await audit.log(req, 'EXCEL_IMPORT', { detail: `저장 ${result.saved.length}주차 / 건너뜀 ${result.skipped.length}주차 / mode=${mode}` });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
// 컨테이너 빌드 검증에서 실제 DB/세션을 변경하지 않고 파서만 시험한다.
module.exports._test = { parseWorkbook, enrichGroups, isoDate, cellText, textHtml, parseStatus };
