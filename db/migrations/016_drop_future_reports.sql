-- ---------------------------------------------------------------------
-- 016. 아직 시작하지 않은 주차의 보고서를 지운다.
--   보고 주차 목록이 지난 주차만 보여주도록 바뀌기 전에, 앞으로의
--   주차에 시험 삼아 쓴 보고서가 남아 있었다. 등록 내역과 전체 주차
--   ZIP 에도 섞여 나오므로 정리한다. 주차 자체는 그대로 둔다.
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

-- 해당 보고서를 가리키던 활동 기록도 함께 지운다
DELETE FROM wr.audit_logs
 WHERE target_type = 'report'
   AND target_id IN (
     SELECT r.id FROM wr.reports r JOIN wr.report_weeks w ON w.id = r.week_id
      WHERE w.start_date > CURRENT_DATE
   );

-- 보고서 삭제 (항목·첨부는 외래키가 함께 지운다)
DELETE FROM wr.reports r
 USING wr.report_weeks w
 WHERE w.id = r.week_id AND w.start_date > CURRENT_DATE;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
    FROM wr.reports r JOIN wr.report_weeks w ON w.id = r.week_id
   WHERE w.start_date > CURRENT_DATE;
  RAISE NOTICE '016 완료: 앞으로의 주차에 남은 보고서 %건', n;
END $$;
