-- =====================================================================
--  마이그레이션 006 : 보고서 단위를 "기관별" → "개인별" 로 변경
--
--  변경 전 : 기관 × 주차 = 보고서 1건   (기관 담당자가 취합해 등록)
--  변경 후 : 사용자 × 주차 = 보고서 1건 (구성원 각자 등록, 160명 규모)
--
--  - reports.author_id 가 보고서 소유자가 된다 (UNIQUE: week_id + author_id)
--  - reports.org_id 는 "작성 당시 소속" 스냅샷으로 남겨 기관별 집계에 쓴다
--    (작성자가 나중에 소속을 옮겨도 과거 실적은 그 기관에 남는다)
--  - 권한에 ORG_ADMIN(기관 관리자) 추가
--
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

-- ---------------------------------------------------------------------
-- 1) 권한에 기관 관리자 추가
--    ADMIN     : 전체 관리자
--    ORG_ADMIN : 자기 기관만 관리
--    USER      : 작성자
-- ---------------------------------------------------------------------
ALTER TABLE wr.users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE wr.users
    ADD CONSTRAINT users_role_chk CHECK (role IN ('USER', 'ORG_ADMIN', 'ADMIN'));

COMMENT ON COLUMN wr.users.role IS 'USER=작성자, ORG_ADMIN=기관 관리자, ADMIN=전체 관리자';


-- ---------------------------------------------------------------------
-- 2) 소유자가 없는 보고서 정리
--    (계정 삭제로 author_id 가 NULL 이 된 건은 개인별 체계에서 주인이 없다)
-- ---------------------------------------------------------------------
DO $$
DECLARE v_orphan INT;
BEGIN
    SELECT count(*) INTO v_orphan FROM wr.reports WHERE author_id IS NULL;
    IF v_orphan > 0 THEN
        RAISE NOTICE '작성자가 없는 보고서 % 건이 있습니다. 삭제하지 않고 그대로 두니 관리자 화면에서 정리하세요.', v_orphan;
    END IF;
END $$;

-- 계정을 지워도 보고서가 사라지지 않도록 SET NULL 유지 (관리자가 재지정)
ALTER TABLE wr.reports DROP CONSTRAINT IF EXISTS reports_author_id_fkey;
ALTER TABLE wr.reports
    ADD CONSTRAINT reports_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES wr.users(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------
-- 3) 유니크 제약 교체 : (주차 × 기관) → (주차 × 작성자)
-- ---------------------------------------------------------------------
ALTER TABLE wr.reports DROP CONSTRAINT IF EXISTS reports_week_org_uk;

CREATE UNIQUE INDEX IF NOT EXISTS reports_week_author_uk
    ON wr.reports (week_id, author_id)
    WHERE author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_author ON wr.reports(author_id);

COMMENT ON COLUMN wr.reports.author_id IS '보고서 소유자. 주차당 1인 1건';
COMMENT ON COLUMN wr.reports.org_id    IS '작성 당시 소속 기관 스냅샷 (기관별 집계용)';


-- ---------------------------------------------------------------------
-- 4) 제출 현황 뷰를 "사용자 × 주차" 로 재정의
-- ---------------------------------------------------------------------
-- v_org_week_summary가 v_submission_status를 참조하므로 하위 뷰부터 제거한다.
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
  AND u.role <> 'ADMIN';        -- 전체 관리자는 작성 대상이 아니다

COMMENT ON VIEW wr.v_submission_status
    IS '관리자 현황: 사용자 × 주차 제출 상태 (NONE/DRAFT/SUBMITTED)';


-- ---------------------------------------------------------------------
-- 5) 기관별 집계 뷰 (주차별 제출 인원 / 전체 인원)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW wr.v_org_week_summary AS
SELECT
    week_id, week_label, start_date, is_open,
    org_id, org_name, sort_order,
    count(*)::INT                                            AS total_users,
    count(*) FILTER (WHERE status = 'SUBMITTED')::INT         AS submitted,
    count(*) FILTER (WHERE status = 'DRAFT')::INT             AS draft,
    count(*) FILTER (WHERE status = 'NONE')::INT              AS none_cnt
FROM wr.v_submission_status
GROUP BY week_id, week_label, start_date, is_open, org_id, org_name, sort_order;

COMMENT ON VIEW wr.v_org_week_summary IS '주차 × 기관별 제출 인원 집계';
