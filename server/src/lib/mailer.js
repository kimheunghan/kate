'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');

/**
 * 메일 발송기.
 * SMTP 설정이 없으면 비활성 상태가 되고, 호출부는 관리자 처리 방식으로 대체한다.
 */

let transporter = null;

if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,                       // 465 면 true
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    tls: { rejectUnauthorized: config.smtp.rejectUnauthorized },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  console.log(`[mail] SMTP 설정됨: ${config.smtp.host}:${config.smtp.port} (secure=${config.smtp.secure})`);
} else {
  const mode = config.reset.fallback === 'admin'
    ? '관리자가 임시 비밀번호를 발급하는 방식'
    : '본인 확인 후 화면에 임시 비밀번호를 알려주는 방식';
  console.log(`[mail] SMTP 미설정 — 메일은 발송되지 않습니다. 비밀번호 재설정은 ${mode}으로 동작합니다.`);
}

function isEnabled() { return !!transporter; }

/** 기동 시 SMTP 연결을 한 번 확인해 설정 오류를 일찍 알린다. */
async function verify() {
  if (!transporter) return false;
  try {
    await transporter.verify();
    console.log('[mail] SMTP 연결 확인 완료');
    return true;
  } catch (err) {
    console.error(`[mail] SMTP 연결 실패: ${err.message} — 메일 발송이 동작하지 않습니다.`);
    return false;
  }
}

async function send({ to, subject, html, text }) {
  if (!transporter) throw new Error('SMTP 가 설정되지 않았습니다.');
  const from = config.smtp.fromName
    ? `"${config.smtp.fromName}" <${config.smtp.from}>`
    : config.smtp.from;
  const info = await transporter.sendMail({ from, to, subject, html, text });
  console.log(`[mail] 발송: ${subject} → ${to} (${info.messageId})`);
  return info;
}

// ---------------------------------------------------------------------
// 비밀번호 재설정 안내 메일
// ---------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendPasswordReset({ to, name, username, link, expireMinutes }) {
  const subject = '[주간실적 보고 시스템] 비밀번호 재설정 안내';

  const text = [
    `${name} 님, 안녕하세요.`,
    '',
    '주간실적 보고 시스템의 비밀번호 재설정이 요청되었습니다.',
    `아이디: ${username}`,
    '',
    '아래 주소로 접속해 새 비밀번호를 설정하세요.',
    link,
    '',
    `이 링크는 ${expireMinutes}분 후 만료되며, 한 번만 사용할 수 있습니다.`,
    '본인이 요청하지 않았다면 이 메일을 무시하시면 됩니다. 비밀번호는 변경되지 않습니다.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="ko"><body style="margin:0;padding:24px;background:#f4f6f9;
     font-family:'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',sans-serif;color:#1e2733">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8dee7;border-radius:8px;overflow:hidden">
    <div style="background:#1f5fa9;color:#fff;padding:16px 22px;font-size:16px;font-weight:700">
      주간실적 보고 시스템
    </div>
    <div style="padding:24px 22px;font-size:14px;line-height:1.7">
      <p style="margin:0 0 14px"><b>${esc(name)}</b> 님, 안녕하세요.</p>
      <p style="margin:0 0 6px">비밀번호 재설정이 요청되었습니다.</p>
      <p style="margin:0 0 18px;color:#5d6b7d">아이디: <b style="color:#1e2733">${esc(username)}</b></p>

      <p style="margin:0 0 16px">아래 버튼을 눌러 새 비밀번호를 설정하세요.</p>
      <p style="margin:0 0 20px">
        <a href="${esc(link)}" style="display:inline-block;background:#1f5fa9;color:#fff;
           text-decoration:none;padding:11px 26px;border-radius:6px;font-weight:700">비밀번호 재설정</a>
      </p>

      <p style="margin:0 0 6px;font-size:12.5px;color:#5d6b7d">버튼이 동작하지 않으면 아래 주소를 복사해 브라우저에 붙여넣으세요.</p>
      <p style="margin:0 0 20px;font-size:12.5px;word-break:break-all"><a href="${esc(link)}" style="color:#1f5fa9">${esc(link)}</a></p>

      <div style="border-top:1px solid #e3e8ee;padding-top:14px;font-size:12.5px;color:#5d6b7d">
        <p style="margin:0 0 5px">이 링크는 <b>${expireMinutes}분 후 만료</b>되며 한 번만 사용할 수 있습니다.</p>
        <p style="margin:0">본인이 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 변경되지 않습니다.</p>
      </div>
    </div>
  </div>
</body></html>`;

  return send({ to, subject, html, text });
}

module.exports = { isEnabled, verify, send, sendPasswordReset };
