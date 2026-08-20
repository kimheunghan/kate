-- =====================================================================
--  마이그레이션 011 : 주차 마감 기능 제거
--
--  마감(is_open=FALSE)으로 작성을 막던 기능을 없앤다.
--  이미 마감된 주차가 있으면 모두 열어 누구나 등록·수정할 수 있게 한다.
--  컬럼 자체는 뷰(v_submission_status, v_org_week_summary)가 참조하고
--  있어 남겨 두되, 항상 TRUE 로 유지된다.
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

UPDATE wr.report_weeks SET is_open = TRUE WHERE is_open IS DISTINCT FROM TRUE;

ALTER TABLE wr.report_weeks ALTER COLUMN is_open SET DEFAULT TRUE;

COMMENT ON COLUMN wr.report_weeks.is_open IS '사용하지 않음. 마감 기능 제거(011) 이후 항상 TRUE';

DO $$
BEGIN
  RAISE NOTICE '011 완료: 주차 마감 해제 (열린 주차 %건)',
    (SELECT count(*) FROM wr.report_weeks WHERE is_open);
END $$;
