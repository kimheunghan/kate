-- ---------------------------------------------------------------------
-- 014. 임시저장(DRAFT) 상태를 없앤다.
--   화면에는 저장 버튼 하나뿐이라 임시저장을 고를 방법이 없다.
--   그런데도 증적자료를 먼저 올리면 빈 임시저장 보고서가 만들어져
--   쓴 적 없는 주차가 '등록된 보고서' 로 잡혔다.
--   내용이 있는 임시저장은 제출완료로 올리고, 빈 것은 지운다.
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

-- 내용이 있는 임시저장 → 제출완료
UPDATE wr.reports r
   SET status = 'SUBMITTED',
       submitted_at = COALESCE(r.submitted_at, r.updated_at, r.created_at)
 WHERE r.status = 'DRAFT'
   AND EXISTS (SELECT 1 FROM wr.report_items i WHERE i.report_id = r.id);

-- 내용이 없는 임시저장 → 삭제 (첨부는 외래키가 함께 지운다)
DELETE FROM wr.reports r
 WHERE r.status = 'DRAFT'
   AND NOT EXISTS (SELECT 1 FROM wr.report_items i WHERE i.report_id = r.id);

-- 앞으로 만들어지는 보고서는 제출완료로 둔다
ALTER TABLE wr.reports ALTER COLUMN status SET DEFAULT 'SUBMITTED';
COMMENT ON COLUMN wr.reports.status IS 'SUBMITTED=제출완료 (임시저장은 쓰지 않는다)';
