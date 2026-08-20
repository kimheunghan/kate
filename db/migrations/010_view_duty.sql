-- =====================================================================
--  마이그레이션 010 : 제출 현황 뷰에 담당 역할 추가
--
--  작성자 목록을 담당 역할(총괄책임자 → 실무책임자 → 참여연구원) 순으로
--  정렬하려면 뷰에 duty 가 있어야 한다.
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

DROP VIEW IF EXISTS wr.v_org_week_summary;
DROP VIEW IF EXISTS wr.v_submission_status;

CREATE VIEW wr.v_submission_status AS
SELECT
    w.id                        AS week_id,
    w.label                     AS week_label,
    w.start_date,
    w.end_date,
    w.is_open,
    u.id                        AS user_id,
    u.username,
    u.name                      AS user_name,
    u.email,
    u.role,
    u.duty,
    o.id                        AS org_id,
    o.name                      AS org_name,
    o.sort_order,
    r.id                        AS report_id,
    COALESCE(r.status, 'NONE')  AS status,
    r.submitted_at,
    r.updated_at,
    COALESCE(i.item_count, 0)   AS item_count,
    COALESCE(a.file_count, 0)   AS file_count
FROM wr.report_weeks w
CROSS JOIN wr.users u
LEFT JOIN wr.organizations o ON o.id = u.org_id
LEFT JOIN wr.reports r       ON r.week_id = w.id AND r.author_id = u.id
LEFT JOIN LATERAL (
    SELECT count(*) AS item_count FROM wr.report_items ri WHERE ri.report_id = r.id
) i ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*) AS file_count FROM wr.attachments at WHERE at.report_id = r.id
) a ON TRUE
WHERE u.is_active = TRUE
  AND u.approval_status = 'APPROVED'
  AND u.org_id IS NOT NULL;

COMMENT ON VIEW wr.v_submission_status
    IS '관리자 현황: 사용자 × 주차 제출 상태. 소속 기관이 있는 모든 계정이 대상';

CREATE OR REPLACE VIEW wr.v_org_week_summary AS
SELECT
    week_id, week_label, start_date, is_open,
    org_id, org_name, sort_order,
    count(*)::INT                                     AS total_users,
    count(*) FILTER (WHERE status = 'SUBMITTED')::INT  AS submitted,
    count(*) FILTER (WHERE status = 'DRAFT')::INT      AS draft,
    count(*) FILTER (WHERE status = 'NONE')::INT       AS none_cnt
FROM wr.v_submission_status
GROUP BY week_id, week_label, start_date, is_open, org_id, org_name, sort_order;

COMMENT ON VIEW wr.v_org_week_summary IS '주차 × 기관별 제출 인원 집계';
