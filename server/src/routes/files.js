'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const config = require('../lib/config');

const router = express.Router();

// ---------------------------------------------------------------------
// 저장소: uploads/<reportId>/<uuid><ext>
//   - 원본 파일명은 DB 에만 보관 (경로 조작·인코딩 문제 회피)
// ---------------------------------------------------------------------
fs.mkdirSync(config.upload.dir, { recursive: true });

// 실행 가능 파일은 업로드 자체를 막는다 (웹셸 업로드 방지)
const BLOCKED_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.scr', '.msi', '.dll', '.cpl',
  '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.jar',
  '.php', '.phtml', '.jsp', '.jspx', '.asp', '.aspx', '.cgi', '.sh',
]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(config.upload.dir, String(req.params.id));
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 12);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxBytes, files: config.upload.maxFiles },
  fileFilter(req, file, cb) {
    // multer 는 latin1 로 파일명을 주므로 UTF-8 로 복원 (한글 파일명 대응)
    try {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch { /* 원본 유지 */ }

    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) {
      return cb(new Error(`업로드할 수 없는 파일 형식입니다: ${ext}  (필요 시 zip 으로 압축해서 올려주세요)`));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------
// 권한 확인
// ---------------------------------------------------------------------
async function loadReportForFiles(reportId) {
  const { rows } = await db.query(
    `SELECT r.id, r.org_id, r.author_id FROM wr.reports r WHERE r.id = $1`,
    [reportId]
  );
  return rows[0] || null;
}

/** 열람: USER=본인 보고서, ORG_ADMIN=자기 기관, ADMIN=전부 */
function canView(user, report) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'ORG_ADMIN') return Number(report.org_id) === Number(user.org_id);
  return report.author_id != null && Number(report.author_id) === Number(user.id);
}

/** 첨부 등록·삭제는 보고서 소유자 본인만 (전체 관리자는 예외) */
function canEdit(user, report) {
  if (user.role === 'ADMIN') return true;
  return report.author_id != null && Number(report.author_id) === Number(user.id);
}

// ---------------------------------------------------------------------
// POST /api/reports/:id/attachments   (multipart, field: files)
// ---------------------------------------------------------------------
router.post('/reports/:id(\\d+)/attachments', auth.requireAuth, async (req, res, next) => {
  const reportId = Number(req.params.id);
  const report = await loadReportForFiles(reportId);
  if (!report) return res.status(404).json({ error: '보고서를 찾을 수 없습니다.' });
  if (!canEdit(req.user, report)) return res.status(403).json({ error: '첨부 권한이 없습니다.' });

  upload.array('files', config.upload.maxFiles)(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `파일이 너무 큽니다. 최대 ${Math.round(config.upload.maxBytes / 1024 / 1024)}MB 까지 가능합니다.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    try {
      const itemId = req.body?.item_id ? Number(req.body.item_id) : null;
      const saved = [];

      for (const f of req.files || []) {
        const rel = path.relative(config.upload.dir, f.path);
        const buf = await fsp.readFile(f.path);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');

        const { rows } = await db.query(
          `INSERT INTO wr.attachments
             (report_id, item_id, original_name, stored_path, content_type, byte_size, checksum_sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, item_id, original_name, content_type, byte_size, created_at`,
          [reportId, itemId, f.originalname, rel, f.mimetype, f.size, sha, req.user.id]
        );
        saved.push(rows[0]);
      }

      await audit.log(req, 'FILE_UPLOAD', {
        targetType: 'report', targetId: reportId, detail: saved.map((s) => s.original_name).join(', '),
      });
      res.status(201).json({ attachments: saved });
    } catch (e) { next(e); }
  });
});

// ---------------------------------------------------------------------
// GET /api/attachments/:id/download
// ---------------------------------------------------------------------
router.get('/attachments/:id(\\d+)/download', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, r.org_id, r.author_id FROM wr.attachments a JOIN wr.reports r ON r.id = a.report_id WHERE a.id = $1`,
      [Number(req.params.id)]
    );
    const att = rows[0];
    if (!att) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });

    // 보고서 열람 권한이 있어야 첨부도 받을 수 있다
    //   USER=본인 것, ORG_ADMIN=자기 기관, ADMIN=전부
    if (!canView(req.user, att)) {
      return res.status(403).json({ error: '열람 권한이 없습니다.' });
    }

    // 저장 경로가 uploads 밖을 가리키지 않는지 확인
    const abs = path.resolve(config.upload.dir, att.stored_path);
    if (!abs.startsWith(path.resolve(config.upload.dir) + path.sep)) {
      return res.status(400).json({ error: '잘못된 파일 경로입니다.' });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '파일이 서버에 존재하지 않습니다.' });

    // 브라우저에서 실행되지 않도록 항상 다운로드로 강제
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(abs, att.original_name);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// DELETE /api/attachments/:id
// ---------------------------------------------------------------------
router.delete('/attachments/:id(\\d+)', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, r.org_id, r.author_id
         FROM wr.attachments a
         JOIN wr.reports r ON r.id = a.report_id
        WHERE a.id = $1`,
      [Number(req.params.id)]
    );
    const att = rows[0];
    if (!att) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (!canEdit(req.user, att)) return res.status(403).json({ error: '삭제 권한이 없습니다.' });

    await db.query(`DELETE FROM wr.attachments WHERE id = $1`, [att.id]);

    const abs = path.resolve(config.upload.dir, att.stored_path);
    if (abs.startsWith(path.resolve(config.upload.dir) + path.sep)) {
      await fsp.unlink(abs).catch(() => {});
    }

    await audit.log(req, 'FILE_DELETE', {
      targetType: 'report', targetId: att.report_id, detail: att.original_name,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// 보고서 삭제 시 물리 파일 정리 (reports 라우터에서 호출)
// ---------------------------------------------------------------------
async function removeFilesOfReport(reportId) {
  const dir = path.resolve(config.upload.dir, String(reportId));
  if (!dir.startsWith(path.resolve(config.upload.dir) + path.sep)) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch((e) => {
    console.error('[files] 파일 정리 실패:', e.message);
  });
}

module.exports = router;
module.exports.removeFilesOfReport = removeFilesOfReport;
