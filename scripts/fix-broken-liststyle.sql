-- =====================================================================
--  저장 과정에서 깨진 list-style-type 값 정리
--
--  브라우저가 큰따옴표로 내보낸 글머리표 값(list-style-type: "■  ")이
--  엔티티 처리 과정에서 &amp;quot; 로 뭉개져 남았다. 글자는 이미 사라져
--  되살릴 수 없으므로 그 선언만 지워 목록 기본 모양으로 되돌린다.
--  (원인은 sanitize.js 에서 고쳤다)
-- =====================================================================
SET client_encoding = 'UTF8';

UPDATE wr.report_items SET
  plan_html      = regexp_replace(plan_html,      'list-style-type:\s*&amp;[^;"]*;?\s*', '', 'g'),
  result_html    = regexp_replace(result_html,    'list-style-type:\s*&amp;[^;"]*;?\s*', '', 'g'),
  next_plan_html = regexp_replace(next_plan_html, 'list-style-type:\s*&amp;[^;"]*;?\s*', '', 'g')
WHERE plan_html      LIKE '%list-style-type: &amp;%'
   OR result_html    LIKE '%list-style-type: &amp;%'
   OR next_plan_html LIKE '%list-style-type: &amp;%';
