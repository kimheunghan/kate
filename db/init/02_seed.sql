-- =====================================================================
--  주간보고 시스템 - 초기 데이터
--
--  주차 기준: 2026-04-01(수) ~ 2026-04-07(화) = 1주차
--             이후 수요일~화요일 주기로 순번 부여
--
--  기준일/기간을 바꾸려면 아래 WEEK_BASELINE / WEEK_END 값을 수정하세요.
--  관리자 계정은 애플리케이션 기동 시 .env 값으로 자동 생성됩니다.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

-- ---------------------------------------------------------------------
-- 한글 요일 변환 헬퍼
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wr.kor_dow(d DATE)
RETURNS TEXT AS $$
    SELECT (ARRAY['일','월','화','수','목','금','토'])[EXTRACT(DOW FROM d)::INT + 1];
$$ LANGUAGE sql IMMUTABLE;


-- ---------------------------------------------------------------------
-- 기관 (프로젝트에 맞게 수정/추가하세요)
-- ---------------------------------------------------------------------
INSERT INTO wr.organizations (name, sort_order) VALUES
    ('㈜비아이매트릭스', 10)
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------
-- 주차 마스터 생성
--   라벨 예) 1주차 (2026/04/01수~04/07화)
--           40주차 (2026/12/30수~2027/01/05화)  ← 연도가 바뀌면 연도까지 표기
-- ---------------------------------------------------------------------
WITH gen AS (
    SELECT d::DATE                             AS start_date,
           (d + INTERVAL '6 days')::DATE       AS end_date,
           row_number() OVER (ORDER BY d)::INT AS week_no
      FROM generate_series(DATE '2026-04-01',   -- WEEK_BASELINE : 1주차 시작일(수)
                           DATE '2029-12-26',   -- WEEK_END      : 생성 종료일
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
ON CONFLICT (start_date) DO NOTHING;
