-- ---------------------------------------------------------------------
-- 018. 감독관리자는 참여 인력이 아니다.
--   등록 현황의 '대상 인원' 에 들어가면 제출률이 틀어진다.
--   제출 현황 뷰에서 감독관리자를 뺀다. (기관별 소계도 이 뷰에서 나온다)
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW wr.v_submission_status AS
SELECT w.id            AS week_id,
       w.label         AS week_label,
       w.start_date,
       w.end_date,
       w.is_open,
       u.id            AS user_id,
       u.username,
       u.name          AS user_name,
       u.email,
       u.role,
       u.duty,
       o.id            AS org_id,
       o.name          AS org_name,
       o.sort_order,
       r.id            AS report_id,
       COALESCE(r.status, 'NONE'::VARCHAR) AS status,
       r.submitted_at,
       r.updated_at,
       COALESCE(i.item_count, 0) AS item_count,
       COALESCE(a.file_count, 0) AS file_count
  FROM wr.report_weeks w
 CROSS JOIN wr.users u
  LEFT JOIN wr.organizations o ON o.id = u.org_id
  LEFT JOIN wr.reports r ON r.week_id = w.id AND r.author_id = u.id
  LEFT JOIN LATERAL (SELECT count(*) AS item_count
                       FROM wr.report_items ri WHERE ri.report_id = r.id) i ON TRUE
  LEFT JOIN LATERAL (SELECT count(*) AS file_count
                       FROM wr.attachments at WHERE at.report_id = r.id) a ON TRUE
 WHERE u.is_active = TRUE
   AND u.approval_status = 'APPROVED'
   AND u.org_id IS NOT NULL
   AND u.role <> 'SUPERVISOR';          -- 감독관리자는 참여 인력이 아니다

COMMENT ON VIEW wr.v_submission_status
  IS '관리자 현황: 참여 인력 × 주차 제출 상태 (감독관리자 제외)';
