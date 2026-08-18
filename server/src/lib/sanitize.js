'use strict';

/**
 * 의존성 없는 HTML Sanitizer (allowlist 방식).
 *
 * 에디터(contenteditable)에서 넘어온 HTML을 서버에서 재검증한다.
 * 클라이언트 검증만 믿으면 다른 사용자가 보고서를 열 때 XSS 가 발생하므로
 * 저장 직전에 반드시 이 함수를 통과시킨다.
 */

// 내용까지 통째로 버릴 태그
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math']);

// 닫는 태그가 없는 태그
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'wbr']);

// 허용 태그
const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'mark', 'small', 'big', 'font',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img',
]);

// 모든 허용 태그에 공통 허용되는 속성
const GLOBAL_ATTRS = new Set(['style', 'align', 'dir', 'title']);

// 태그별 추가 허용 속성
const TAG_ATTRS = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  table: new Set(['border', 'cellpadding', 'cellspacing', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor']),
  th: new Set(['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor']),
  col: new Set(['span', 'width']),
  ol: new Set(['start', 'type']),
  ul: new Set(['type']),
};

// style 속성에서 허용할 CSS 프로퍼티
const ALLOWED_CSS = new Set([
  'color', 'background-color', 'background',
  'font-size', 'font-family', 'font-weight', 'font-style', 'font-variant',
  'text-decoration', 'text-decoration-line', 'text-align',
  // text-indent 는 제외한다. 붙여넣기 시 음수 값이 딸려와 글자가 칸 밖으로 밀려난다.
  'line-height', 'letter-spacing', 'white-space', 'vertical-align',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'width', 'height', 'max-width', 'min-width',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-collapse', 'border-color', 'border-width', 'border-style',
  'list-style-type', 'list-style-position',
]);

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// 이미 올바른 형태인 엔티티(&nbsp; &amp; &#160; &#x2013; ...)
const ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;

/**
 * 본문 텍스트 이스케이프.
 * '&' 를 무조건 바꾸면 &nbsp; 같은 정상 엔티티가 &amp;nbsp; 로 이중 인코딩되어
 * 화면에 "&nbsp;" 라는 글자로 보인다. 유효한 엔티티는 그대로 두고
 * 홀로 쓰인 '&' 만 이스케이프한다.
 * (텍스트 노드의 엔티티는 태그를 만들지 못하므로 그대로 두어도 안전하다)
 */
function escapeText(s) {
  return s
    .replace(new RegExp(`&(?!${ENTITY_RE.source.slice(1)})`, 'g'), '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 속성값 이스케이프.
 * 여기서는 '&' 를 항상 이스케이프한다. 속성값의 엔티티는 브라우저가 디코딩하므로
 * href="jav&#9;ascript:..." 같은 스킴 우회가 가능해지기 때문이다.
 */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 위험한 스킴 차단. 허용: http, https, mailto, 상대경로, data:image/* */
function safeUrl(raw, { allowDataImage = false } = {}) {
  // 제어문자·공백을 이용한 스킴 우회(jav\tascript:) 차단
  const v = String(raw).replace(/[\u0000-\u0020\u007f]/g, '');
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) {
    return v.replace(/\s+/g, '');
  }
  // 스킴이 없는 상대/절대 경로만 허용 (javascript:, vbscript:, data:text/html 차단)
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return v;
}

function safeStyle(raw) {
  const out = [];
  for (const decl of String(raw).split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!ALLOWED_CSS.has(prop)) continue;
    if (!value || value.length > 200) continue;
    // url(), expression(), 스크립트 스킴 차단
    if (/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|<|>/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

function sanitizeAttrs(tag, rawAttrs) {
  const allowed = TAG_ATTRS[tag];
  const out = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';

    if (name.startsWith('on')) continue;                       // 모든 이벤트 핸들러 차단
    if (!GLOBAL_ATTRS.has(name) && !(allowed && allowed.has(name))) continue;

    if (name === 'style') {
      const s = safeStyle(value);
      if (s) out.push(`style="${escapeAttr(s)}"`);
      continue;
    }
    if (name === 'href') {
      const u = safeUrl(value);
      if (u) out.push(`href="${escapeAttr(u)}" target="_blank" rel="noopener noreferrer nofollow"`);
      continue;
    }
    if (name === 'src') {
      const u = safeUrl(value, { allowDataImage: true });
      if (u) out.push(`src="${escapeAttr(u)}"`);
      continue;
    }
    if (name === 'target' || name === 'rel') continue;          // href 처리에서 이미 세팅
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/**
 * @param {string} html
 * @param {{maxLength?: number}} opts
 * @returns {string} 정제된 HTML
 */
function sanitizeHtml(html, opts = {}) {
  if (html == null) return '';
  let input = String(html);

  const maxLength = opts.maxLength ?? 2 * 1024 * 1024; // 필드당 2MB
  if (input.length > maxLength) input = input.slice(0, maxLength);

  const out = [];
  const stack = [];
  let last = 0;
  let skipDepth = 0;      // DROP_WITH_CONTENT 내부인지
  let skipTag = null;
  let m;

  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(input)) !== null) {
    const text = input.slice(last, m.index);
    if (!skipDepth && text) out.push(escapeText(text));
    last = TOKEN_RE.lastIndex;

    const closeTag = m[1] ? m[1].toLowerCase() : null;
    const openTag = m[2] ? m[2].toLowerCase() : null;

    // 주석 / DOCTYPE / CDATA → 버림
    if (!closeTag && !openTag) continue;

    if (skipDepth) {
      if (openTag === skipTag) skipDepth++;
      else if (closeTag === skipTag && --skipDepth === 0) skipTag = null;
      continue;
    }

    if (openTag) {
      if (DROP_WITH_CONTENT.has(openTag)) {
        // 자기 닫힘 형태(<svg/>)면 내용이 없으므로 스킵 상태로 들어가지 않는다
        if (!/\/\s*>$/.test(m[0])) { skipDepth = 1; skipTag = openTag; }
        continue;
      }
      if (!ALLOWED_TAGS.has(openTag)) continue;                 // 태그만 버리고 내용은 유지

      const attrs = sanitizeAttrs(openTag, m[3] || '');
      if (VOID_TAGS.has(openTag)) {
        out.push(`<${openTag}${attrs}>`);
      } else if (/\/\s*>$/.test(m[0])) {
        out.push(`<${openTag}${attrs}></${openTag}>`);
      } else {
        out.push(`<${openTag}${attrs}>`);
        stack.push(openTag);
      }
      continue;
    }

    if (closeTag) {
      if (!ALLOWED_TAGS.has(closeTag) || VOID_TAGS.has(closeTag)) continue;
      const at = stack.lastIndexOf(closeTag);
      if (at === -1) continue;                                  // 짝 없는 닫는 태그 → 버림
      // 중간에 안 닫힌 태그들을 함께 닫아 구조를 맞춘다
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    }
  }

  const tail = input.slice(last);
  if (!skipDepth && tail) out.push(escapeText(tail));
  while (stack.length) out.push(`</${stack.pop()}>`);

  return out.join('');
}

/** HTML 을 평문으로 (목록 미리보기·검색용) */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { sanitizeHtml, htmlToText };
