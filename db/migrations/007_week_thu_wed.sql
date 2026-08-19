-- =====================================================================
--  마이그레이션 007 : 주차 주기를 "수~화" → "목~수" 로 변경
--
--  주간보고는 매주 수요일에 작성하며, 대상 기간은 직전 목요일 ~ 당일 수요일이다.
--    예) 2026-08-13(목) ~ 2026-08-19(수)  = 17주차
--  따라서 1주차 시작일(WEEK_BASELINE)은 2026-04-23(목) 이 된다.
--    2026-04-23 + 16주 = 2026-08-13  →  17주차 ✔
--
--  - 기존 보고서는 기간이 가장 많이 겹치는 새 주차로 자동 이관한다.
--  - 이관 후 옛 주차(수요일 시작)는 삭제한다.
--  멱등하므로 여러 번 실행해도 안전.
--
--  기준일을 바꾸려면 아래 '2026-04-23' 을 원하는 목요일로 모두 교체하세요.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

CREATE OR REPLACE FUNCTION wr.kor_dow(d DATE)
RETURNS TEXT AS $$
    SELECT (ARRAY['일','월','화','수','목','금','토'])[EXTRACT(DOW FROM d)::INT + 1];
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------
-- 1) 새 주차(목~수) 생성 : 2026-04-23 ~ 2030-04-17
-- ---------------------------------------------------------------------
WITH gen AS (
    SELECT d::DATE                             AS start_date,
           (d + INTERVAL '6 days')::DATE       AS end_date,
           row_number() OVER (ORDER BY d)::INT AS week_no
      FROM generate_series(DATE '2026-04-23',   -- WEEK_BASELINE (목)
                           DATE '2030-04-17',
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
   SET year = EXCLUDED.year, week_no = EXCLUDED.week_no,
       end_date = EXCLUDED.end_date, label = EXCLUDED.label;

-- ---------------------------------------------------------------------
-- 2) 기존 보고서를 겹치는 기간이 가장 큰 새 주차로 이관
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_base   DATE := DATE '2026-04-23';
    r        RECORD;
    v_new    INT;
    v_moved  INT := 0;
    v_skip   INT := 0;
BEGIN
    FOR r IN
        SELECT rp.id, rp.author_id, ow.start_date AS os, ow.end_date AS oe, ow.label AS olabel
          FROM wr.reports rp
          JOIN wr.report_weeks ow ON ow.id = rp.week_id
         WHERE ow.start_date < v_base
            OR ((ow.start_date - v_base) % 7) <> 0        -- 옛 주기(수요일 시작)
    LOOP
        SELECT nw.id INTO v_new
          FROM wr.report_weeks nw
         WHERE nw.start_date >= v_base
           AND ((nw.start_date - v_base) % 7) = 0
           AND LEAST(nw.end_date, r.oe) >= GREATEST(nw.start_date, r.os)
         ORDER BY (LEAST(nw.end_date, r.oe) - GREATEST(nw.start_date, r.os)) DESC, nw.start_date
         LIMIT 1;

        IF v_new IS NULL THEN
            v_skip := v_skip + 1;
            CONTINUE;
        END IF;

        -- 같은 주차에 같은 작성자 보고서가 이미 있으면 건너뛴다
        IF EXISTS (SELECT 1 FROM wr.reports x
                    WHERE x.week_id = v_new AND x.author_id IS NOT DISTINCT FROM r.author_id
                      AND x.id <> r.id) THEN
            v_skip := v_skip + 1;
            RAISE NOTICE '보고서 #% 이관 보류(중복): %', r.id, r.olabel;
            CONTINUE;
        END IF;

        UPDATE wr.reports SET week_id = v_new WHERE id = r.id;
        v_moved := v_moved + 1;
    END LOOP;

    RAISE NOTICE '보고서 이관: % 건 이동, % 건 보류', v_moved, v_skip;
END $$;

-- ---------------------------------------------------------------------
-- 3) 옛 주기(수요일 시작) 주차 제거 — 남은 보고서가 없는 것만
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_base DATE := DATE '2026-04-23';
    v_del  INT;
    v_keep INT;
BEGIN
    SELECT count(*) INTO v_keep
      FROM wr.report_weeks w
     WHERE (w.start_date < v_base OR ((w.start_date - v_base) % 7) <> 0)
       AND EXISTS (SELECT 1 FROM wr.reports r WHERE r.week_id = w.id);

    DELETE FROM wr.report_weeks w
     WHERE (w.start_date < v_base OR ((w.start_date - v_base) % 7) <> 0)
       AND NOT EXISTS (SELECT 1 FROM wr.reports r WHERE r.week_id = w.id);
    GET DIAGNOSTICS v_del = ROW_COUNT;

    RAISE NOTICE '옛 주기 주차 % 건 삭제', v_del;
    IF v_keep > 0 THEN
        RAISE NOTICE '보고서가 남아 있어 유지한 옛 주차: % 건 (관리자 화면에서 확인하세요)', v_keep;
    END IF;
END $$;
