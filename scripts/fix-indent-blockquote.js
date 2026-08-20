/**
 * 옛 들여쓰기 잔재 정리
 *
 * 예전 편집기는 들여쓰기에 execCommand('indent') 를 써서
 *   <blockquote style="margin: 0 0 0 40px; border: none; padding: 0px">
 * 형태로 저장했다. 지금은 padding-left 로 바뀌었으므로,
 * 남아 있는 옛 데이터를 같은 형태로 변환한다.
 *
 * 실행:  podman exec wr-app node /app/scripts/fix-indent-blockquote.js [--dry]
 */
'use strict';
const db = require('/app/server/src/lib/db');

const DRY = process.argv.includes('--dry');

/** 들여쓰기용 blockquote 를 padding-left 를 가진 div 로 바꾼다 (중첩 포함) */
function convert(html) {
  if (!html || !html.includes('<blockquote')) return html;
  let out = html;
  let guard = 0;

  while (guard++ < 20) {
    // 가장 안쪽의 (중첩되지 않은) 들여쓰기 blockquote 부터 변환
    const re = /<blockquote([^>]*border:\s*none[^>]*)>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/i;
    const m = re.exec(out);
    if (!m) break;

    const px = (/margin:\s*0\s+0\s+0\s+([\d.]+)px/i.exec(m[1])
             || /margin-left:\s*([\d.]+)px/i.exec(m[1]) || [, '40'])[1];
    const style = Number(px) > 0 ? ` style="padding-left: ${px}px"` : '';
    out = out.slice(0, m.index) + `<div${style}>${m[2]}</div>` + out.slice(m.index + m[0].length);
  }
  return out;
}

(async () => {
  const { rows } = await db.query(
    `SELECT id, plan_html, result_html, next_plan_html FROM wr.report_items`
  );
  let changed = 0;

  for (const r of rows) {
    const p = convert(r.plan_html);
    const s = convert(r.result_html);
    const n = convert(r.next_plan_html);
    if (p === r.plan_html && s === r.result_html && n === r.next_plan_html) continue;

    changed++;
    console.log(`  항목 #${r.id}`);
    if (p !== r.plan_html)   console.log(`    당초계획 : ${r.plan_html}\n           → ${p}`);
    if (s !== r.result_html) console.log(`    추진실적 : ${r.result_html}\n           → ${s}`);
    if (n !== r.next_plan_html) console.log(`    향후계획 : ${r.next_plan_html}\n           → ${n}`);

    if (!DRY) {
      await db.query(
        `UPDATE wr.report_items SET plan_html=$1, result_html=$2, next_plan_html=$3 WHERE id=$4`,
        [p, s, n, r.id]
      );
    }
  }
  console.log(`\n검사 ${rows.length}건 / ${DRY ? '변환 예정' : '변환'} ${changed}건`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
