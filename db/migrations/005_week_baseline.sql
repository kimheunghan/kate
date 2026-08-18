-- =====================================================================
--  마이그레이션 005 : 주차 기준일 변경
--
--  사업 시작 주차를 2026-04-01(수) ~ 2026-04-07(화) = 1주차 로 재정의한다.
--  - 기준일 이전 주차는 삭제 (단, 이미 보고서가 등록된 주차는 보존)
--  - 기준일부터 순번을 1주차, 2주차 … 로 다시 매긴다
--  멱등하므로 여러 번 실행해도 안전.
--
--  기준일을 바꾸려면 아래 WEEK_BASELINE 값 두 곳을 함께 수정하세요.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

-- 한글 요일 헬퍼 (신규 DB 에도 있도록 여기서도 정의)
CREATE OR REPLACE FUNCTION wr.kor_dow(d DATE)
RETURNS TEXT AS $$
    SELECT (ARRAY['일','월','화','수','목','금','토'])[EXTRACT(DOW FROM d)::INT + 1];
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------
-- 1) 기준일 이전 주차 제거
--    보고서가 등록된 주차는 자료 보호를 위해 남긴다.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_baseline DATE := DATE '2026-04-01';   -- WEEK_BASELINE
    v_deleted  INT;
    v_kept     INT;
BEGIN
    SELECT count(*) INTO v_kept
      FROM wr.report_weeks w
     WHERE w.start_date < v_baseline
       AND EXISTS (SELECT 1 FROM wr.reports r WHERE r.week_id = w.id);

    DELETE FROM wr.report_weeks w
     WHERE w.start_date < v_baseline
       AND NOT EXISTS (SELECT 1 FROM wr.reports r WHERE r.week_id = w.id);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RAISE NOTICE '기준일(%) 이전 주차 % 건 삭제', v_baseline, v_deleted;
    IF v_kept > 0 THEN
        RAISE NOTICE '보고서가 등록되어 있어 남겨둔 이전 주차: % 건', v_kept;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) 기준일부터 주차 생성 + 순번 재부여
--    라벨 예) 1주차 (2026/04/01수~04/07화)
--            40주차 (2026/12/30수~2027/01/05화)   ← 연도가 바뀌면 연도까지 표기
-- ---------------------------------------------------------------------
WITH gen AS (
    SELECT d::DATE                                   AS start_date,
           (d + INTERVAL '6 days')::DATE             AS end_date,
           row_number() OVER (ORDER BY d)::INT       AS week_no
      FROM generate_series(DATE '2026-04-01',        -- WEEK_BASELINE
                           DATE '2029-12-26',
                           INTERVAL '7 days') AS d
)
INSERT INTO wr.report_weeks (year, week_no, start_date, end_date, label)
SELECT EXTRACT(YEAR FROM g.start_date)::INT,
       g.week_no,
       g.start_date,
       g.end_date,
       g.week_no || '주차 ('
         || to_char(g.start_date, 'YYYY/MM/DD') || wr.kor_dow(g.start_date) || '~'
         || CASE WHEN EXTRACT(YEAR FROM g.end_date) = EXTRACT(YEAR FROM g.start_date)
                 THEN to_char(g.end_date, 'MM/DD')
                 ELSE to_char(g.end_date, 'YYYY/MM/DD') END
         || wr.kor_dow(g.end_date) || ')'
  FROM gen g
ON CONFLICT (start_date) DO UPDATE
   SET year     = EXCLUDED.year,
       week_no  = EXCLUDED.week_no,
       end_date = EXCLUDED.end_date,
       label    = EXCLUDED.label;
