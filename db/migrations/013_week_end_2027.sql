-- =====================================================================
--  마이그레이션 013 : 대상 주차를 2027-03-31 까지로 제한
--
--  사업 기간이 2027-03-31 에 끝나므로 그 뒤 주차는 두지 않는다.
--  2027-03-31 은 49주차(2027/03/25목~03/31수)의 마지막 날이라
--  그 주차까지 남기고 이후를 지운다.
--  보고서가 달린 주차는 지우지 않는다 (실수로 자료를 잃지 않도록).
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

DELETE FROM wr.report_weeks w
 WHERE w.end_date > DATE '2027-03-31'
   AND NOT EXISTS (SELECT 1 FROM wr.reports r WHERE r.week_id = w.id);

DO $$
DECLARE
  kept   int;
  last_l text;
  extra  int;
BEGIN
  SELECT count(*), max(label) INTO kept, last_l FROM wr.report_weeks;
  SELECT count(*) INTO extra FROM wr.report_weeks WHERE end_date > DATE '2027-03-31';
  RAISE NOTICE '013 완료: 남은 주차 %건 / 기준일 이후 남은 주차 %건 (보고서가 달려 있어 보존)',
    kept, extra;
END $$;
