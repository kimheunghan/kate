'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const config = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);   // 리버스 프록시(nginx) 뒤 배포 대비

// ---------------------------------------------------------------------
// 기본 미들웨어
// ---------------------------------------------------------------------
app.use(express.json({ limit: '12mb' }));           // 에디터 본문(이미지 포함) 여유
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());

// 보안 헤더 (외부 CDN 을 쓰지 않으므로 CSP 를 강하게 걸 수 있다)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; font-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// CSRF 방어: 상태 변경 요청은 커스텀 헤더를 요구 (교차 사이트 폼 전송 차단)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('X-Requested-With') !== 'WeeklyReport') {
    return res.status(403).json({ error: '잘못된 요청입니다. 페이지를 새로고침한 뒤 다시 시도하세요.' });
  }
  next();
});

app.use(auth.loadUser);

// ---------------------------------------------------------------------
// 라우터
// ---------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'up', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/meta'));
app.use('/api/reports/excel', require('./routes/excel'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api', require('./routes/files'));
app.use('/api/admin', require('./routes/admin-export'));   // 엑셀 내려받기 (먼저 붙인다)
app.use('/api/admin', require('./routes/admin'));

// ---------------------------------------------------------------------
// 정적 파일 + 페이지
// ---------------------------------------------------------------------
const publicDir = path.resolve(__dirname, '../../public');
// maxAge 를 두면 CSS/JS 수정이 브라우저 캐시에 막혀 반영되지 않는다.
// ETag 로 재검증만 하게 두면(변경 없을 때 304) 성능 손해 없이 즉시 반영된다.
// .html 을 정적 파일로 그냥 내보내면 __V__ 자리가 그대로 나간다.
// 주소로 /app.html 을 직접 쳐도 아래 sendPage 를 타도록 넘긴다.
app.use((req, res, next) => {
  if (!/\.html$/i.test(req.path)) return next();
  const file = path.basename(req.path);
  if (!fs.existsSync(path.join(publicDir, file))) return next();
  return sendPage(res, file);
});

app.use(express.static(publicDir, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

// ---------------------------------------------------------------------
// 정적 자원 버전 (캐시 무효화)
//   css/js 파일 중 가장 최근 수정시각으로 버전 문자열을 만들어
//   HTML 의 __V__ 자리에 넣는다. 파일이 바뀌면 URL 이 바뀌므로
//   브라우저가 옛 파일을 계속 쓰는 일이 없다.
// ---------------------------------------------------------------------
function computeAssetVersion() {
  let latest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css)$/i.test(e.name)) latest = Math.max(latest, fs.statSync(p).mtimeMs);
    }
  };
  try { walk(publicDir); } catch { /* 무시 */ }
  return String(Math.floor(latest || Date.now())).slice(-10);
}

const ASSET_VERSION = computeAssetVersion();
const pageCache = new Map();

function sendPage(res, file) {
  let html = pageCache.get(file);
  if (html === undefined) {
    html = fs.readFileSync(path.join(publicDir, file), 'utf8').replace(/__V__/g, ASSET_VERSION);
    pageCache.set(file, html);
  }
  res.type('html').set('Cache-Control', 'no-cache').send(html);
}

app.get(['/', '/login'], (req, res) => sendPage(res, req.user ? 'app.html' : 'login.html'));
app.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/report');
  sendPage(res, 'signup.html');
});
app.get('/reset', (req, res) => sendPage(res, 'reset.html'));
app.get('/report', (req, res) => sendPage(res, 'app.html'));
app.get('/admin', (req, res) => sendPage(res, 'admin.html'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '없는 API 입니다.' });
  res.status(404);
  sendPage(res, 'login.html');
});

// ---------------------------------------------------------------------
// 에러 핸들러
// ---------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.originalUrl, '-', err.message);
  if (config.env !== 'production') console.error(err.stack);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: config.env === 'production' ? '서버 오류가 발생했습니다.' : err.message,
  });
});

// ---------------------------------------------------------------------
// 기동
// ---------------------------------------------------------------------
async function start() {
  fs.mkdirSync(config.upload.dir, { recursive: true });

  await db.waitForReady();
  await auth.ensureAdminAccount();
  require('./lib/audit').startPurgeSchedule();
  await require('./lib/mailer').verify();

  // 인증서가 지정되어 있으면 HTTPS 로 기동한다
  let server;
  let scheme = 'http';
  const { certFile, keyFile } = config.ssl;
  if (certFile && keyFile) {
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      console.error(`[FATAL] 인증서 파일을 찾을 수 없습니다: ${certFile} / ${keyFile}`);
      process.exit(1);
    }
    const https = require('https');
    server = https.createServer(
      { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app
    );
    scheme = 'https';
    console.log('[app] HTTPS 로 기동합니다.');
  } else {
    console.log('[app] HTTP 로 기동합니다. (SSL_CERT_FILE/SSL_KEY_FILE 을 지정하면 HTTPS)');
    console.log('[app] ※ HTTP 에서는 Chrome 이 파일 다운로드를 차단할 수 있습니다.');
  }

  const onReady = () => {
    console.log(`[app] 주간보고 시스템 기동 완료 → ${scheme}://0.0.0.0:${config.port}`);
    console.log(`[app] DB: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database} (schema=${config.db.schema})`);
    console.log(`[app] 업로드 경로: ${config.upload.dir}`);
  };

  if (server) server.listen(config.port, '0.0.0.0', onReady);
  else server = app.listen(config.port, '0.0.0.0', onReady);

  const shutdown = (sig) => {
    console.log(`[app] ${sig} 수신 - 종료합니다.`);
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[FATAL] 기동 실패:', err);
  process.exit(1);
});
