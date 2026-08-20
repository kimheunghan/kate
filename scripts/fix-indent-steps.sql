-- =====================================================================
--  저장된 들여쓰기 값을 한 단계(8px) 배수로 맞춘다
--
--  예전에는 화면에서 잰 공백 폭(4.5px 같은 값)으로 밀어 9.5px, 19px,
--  28.5px 같은 값이 남았다. 문서로 내보낼 때 공백 수가 한 칸씩 어긋난다.
--  8 의 배수(8, 16, 24 …)로 반올림한다. 여러 번 실행해도 안전하다.
-- =====================================================================
SET client_encoding = 'UTF8';

CREATE OR REPLACE FUNCTION pg_temp.snap_indent(html text) RETURNS text AS $$
DECLARE
  out text := html;
  m   text[];
  px  numeric;
  fixed int;
BEGIN
  IF out IS NULL THEN RETURN NULL; END IF;
  FOR m IN SELECT regexp_matches(out, '(padding-left|margin-left):\s*([0-9.]+)px', 'g') LOOP
    px := m[2]::numeric;
    fixed := GREATEST(8, round(px / 8) * 8);
    IF fixed <> px THEN
      out := replace(out, m[1] || ': ' || m[2] || 'px', m[1] || ': ' || fixed || 'px');
    END IF;
  END LOOP;
  RETURN out;
END $$ LANGUAGE plpgsql;

UPDATE wr.report_items SET
  plan_html      = pg_temp.snap_indent(plan_html),
  result_html    = pg_temp.snap_indent(result_html),
  next_plan_html = pg_temp.snap_indent(next_plan_html)
WHERE plan_html || result_html || next_plan_html ~ '(padding|margin)-left:\s*[0-9.]+px';
