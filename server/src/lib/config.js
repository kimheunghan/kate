'use strict';

const path = require('path');

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const config = {
  env: process.env.NODE_ENV || 'production',
  port: num(process.env.APP_PORT, 8080),

  db: {
    host: process.env.DB_HOST || 'db',
    port: num(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'weekly_report',
    user: process.env.DB_USER || 'wruser',
    password: process.env.DB_PASSWORD || '',
    schema: process.env.DB_SCHEMA || 'wr',
    max: num(process.env.DB_POOL_MAX, 10),
  },

  session: {
    secret: process.env.SESSION_SECRET || '',
    // 초 단위. 기본 12시간
    ttlSeconds: num(process.env.SESSION_TTL_SECONDS, 12 * 60 * 60),
    cookieName: 'wr_session',
    // 리버스 프록시에서 HTTPS 종단 시 true 로
    secureCookie: String(process.env.COOKIE_SECURE || 'false') === 'true',
  },

  upload: {
    dir: process.env.UPLOAD_DIR || path.resolve(__dirname, '../../../uploads'),
    maxBytes: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
    maxFiles: num(process.env.MAX_UPLOAD_FILES, 20),
  },

  bootstrap: {
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    adminName: process.env.ADMIN_NAME || '관리자',
  },

  // 메일에 넣을 링크의 기준 주소. 비우면 요청 헤더로 추정한다.
  //   예) http://183.101.26.137:8080
  baseUrl: (process.env.APP_BASE_URL || '').replace(/\/+$/, ''),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',   // 465 면 true
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost',
    fromName: process.env.SMTP_FROM_NAME || '주간실적 보고 시스템',
    // 사내 메일서버의 자체서명 인증서를 쓰는 경우 false 로
    rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true') !== 'false',
    // 재설정 링크 유효시간(분)
    resetTokenMinutes: num(process.env.RESET_TOKEN_MINUTES, 30),
  },

  reset: {
    // SMTP 가 없을 때의 동작
    //   direct = 본인 확인 후 즉시 재설정 화면으로 (관리자 개입 없음)
    //   admin  = 요청만 접수하고 관리자가 임시 비밀번호 발급
    fallback: (process.env.RESET_FALLBACK || 'direct').toLowerCase() === 'admin' ? 'admin' : 'direct',
    // 즉시 재설정용 토큰 유효시간(분). 메일 없이 바로 넘기므로 짧게 둔다.
    directMinutes: num(process.env.RESET_DIRECT_MINUTES, 15),
  },

  signup: {
    // true  = 가입 즉시 사용 가능 (관리자 승인 불필요)
    // false = 관리자 승인 후 사용 가능
    autoApprove: String(process.env.SIGNUP_AUTO_APPROVE || 'true') !== 'false',
    // 비어 있으면 제한 없음. 예) "bimatrix.co.kr,partner.co.kr"
    allowedEmailDomains: String(process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS || '')
      .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  },
};

if (!config.session.secret) {
  if (config.env === 'production') {
    console.error('[FATAL] SESSION_SECRET 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
    process.exit(1);
  }
  config.session.secret = 'dev-only-insecure-secret';
}

module.exports = config;
