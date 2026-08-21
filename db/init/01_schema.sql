-- =====================================================================
--  주간보고 시스템 (Weekly Report System) - 스키마
--  PostgreSQL 16+
--  이 파일은 컨테이너 최초 기동 시 /docker-entrypoint-initdb.d 에서 자동 실행됩니다.
--  기존 DB에 수동 적용 시:  psql -U wruser -d weekly_report -f 01_schema.sql
-- =====================================================================

SET client_encoding = 'UTF8';

CREATE SCHEMA IF NOT EXISTS wr;
SET search_path TO wr, public;

-- ---------------------------------------------------------------------
-- 공통: updated_at 자동 갱신 트리거 함수
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wr.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
-- 기관 (참여기관 / 수행사)
-- ---------------------------------------------------------------------
CREATE TABLE wr.organizations (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE  wr.organizations      IS '기관명 (주간보고 작성 단위)';
COMMENT ON COLUMN wr.organizations.sort_order IS '보고서 출력 시 정렬 순서';

CREATE TRIGGER trg_organizations_updated
    BEFORE UPDATE ON wr.organizations
    FOR EACH ROW EXECUTE FUNCTION wr.set_updated_at();


-- ---------------------------------------------------------------------
-- 사용자
-- ---------------------------------------------------------------------
CREATE TABLE wr.users (
    id             SERIAL      PRIMARY KEY,
    username       VARCHAR(50) NOT NULL UNIQUE,
    password_hash  TEXT        NOT NULL,          -- scrypt: scrypt$N$r$p$salt$hash
    name           VARCHAR(50) NOT NULL,
    email          VARCHAR(120),
    org_id         INTEGER     REFERENCES wr.organizations(id) ON DELETE SET NULL,
    phone          VARCHAR(30),
    role           VARCHAR(20) NOT NULL DEFAULT 'USER',
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    must_change_pw BOOLEAN     NOT NULL DEFAULT FALSE,
    -- 가입 승인제: 사용자가 직접 가입 신청하면 PENDING 으로 생성되고
    -- 관리자가 승인해야 APPROVED 가 되어 로그인할 수 있다.
    approval_status VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
    signup_note    TEXT,
    -- 담당 역할: LEAD=총괄책임자, MANAGER=실무책임자, RESEARCHER=참여연구원
    duty           VARCHAR(20),
    approved_at    TIMESTAMPTZ,
    approved_by    INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_role_chk CHECK (role IN ('USER', 'ORG_ADMIN', 'ADMIN')),
    CONSTRAINT users_approval_status_chk CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT users_duty_chk CHECK (duty IS NULL OR duty IN ('LEAD', 'MANAGER', 'RESEARCHER'))
);
COMMENT ON TABLE  wr.users                 IS '로그인 사용자';
COMMENT ON COLUMN wr.users.role            IS 'USER=작성자, ORG_ADMIN=기관 관리자, ADMIN=전체 관리자';
COMMENT ON COLUMN wr.users.approval_status IS 'PENDING=가입 승인 대기, APPROVED=사용 가능, REJECTED=반려';
COMMENT ON COLUMN wr.users.signup_note     IS '가입 신청 시 사용자가 남긴 메모(담당 업무 등)';

CREATE INDEX idx_users_org        ON wr.users(org_id);
CREATE INDEX idx_users_approval   ON wr.users(approval_status);
CREATE INDEX idx_users_email_lower ON wr.users(lower(email));

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON wr.users
    FOR EACH ROW EXECUTE FUNCTION wr.set_updated_at();


-- ---------------------------------------------------------------------
-- 주차 마스터 (목요일 ~ 수요일 기준)
--   예) 2026-08-13(목)~08-19(수) 처럼 임의 구간도 쓸 수 있도록
--       start_date / end_date 를 직접 보관한다.
-- ---------------------------------------------------------------------
CREATE TABLE wr.report_weeks (
    id          SERIAL      PRIMARY KEY,
    year        INTEGER     NOT NULL,
    week_no     INTEGER     NOT NULL,
    start_date  DATE        NOT NULL UNIQUE,
    end_date    DATE        NOT NULL,
    label       VARCHAR(80) NOT NULL,             -- '17주차 (2026/08/13목~08/19수)'
    is_open     BOOLEAN     NOT NULL DEFAULT TRUE,-- 사용하지 않음 (마감 기능 제거)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT report_weeks_range_chk CHECK (end_date >= start_date)
);
COMMENT ON TABLE  wr.report_weeks         IS '주차 마스터';

CREATE INDEX idx_report_weeks_start ON wr.report_weeks(start_date DESC);


-- ---------------------------------------------------------------------
-- 주간보고 (작성자 × 주차 = 1건)
-- ---------------------------------------------------------------------
CREATE TABLE wr.reports (
    id            SERIAL      PRIMARY KEY,
    week_id       INTEGER     NOT NULL REFERENCES wr.report_weeks(id)  ON DELETE CASCADE,
    org_id        INTEGER     NOT NULL REFERENCES wr.organizations(id) ON DELETE CASCADE,
    author_id     INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    submitted_at  TIMESTAMPTZ,
    note          TEXT,                            -- 특이사항 / 비고
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reports_status_chk CHECK (status IN ('DRAFT', 'SUBMITTED'))
);
COMMENT ON TABLE  wr.reports        IS '주간보고 헤더. 작성자 1명 × 주차 1개 = 1건';
COMMENT ON COLUMN wr.reports.status IS 'DRAFT=임시저장, SUBMITTED=제출완료';
COMMENT ON COLUMN wr.reports.author_id IS '보고서 소유자. 주차당 1인 1건';
COMMENT ON COLUMN wr.reports.org_id IS '작성 당시 소속 기관 스냅샷';

CREATE INDEX idx_reports_week ON wr.reports(week_id);
CREATE INDEX idx_reports_org  ON wr.reports(org_id);
CREATE UNIQUE INDEX reports_week_author_uk ON wr.reports (week_id, author_id)
    WHERE author_id IS NOT NULL;
CREATE INDEX idx_reports_author ON wr.reports(author_id);

CREATE TRIGGER trg_reports_updated
    BEFORE UPDATE ON wr.reports
    FOR EACH ROW EXECUTE FUNCTION wr.set_updated_at();


-- ---------------------------------------------------------------------
-- 주간보고 상세 항목 (업무 단위 = 보고서의 한 행)
--   plan_html   : ① 당초 계획
--   result_html : ② 추진 실적
--   progress_rate / next_plan_html 은 현재 화면에서 사용하지 않으나,
--   향후 확장(진도율·향후계획) 시 마이그레이션 없이 쓰도록 미리 열어 둠.
-- ---------------------------------------------------------------------
CREATE TABLE wr.report_items (
    id              SERIAL       PRIMARY KEY,
    report_id       INTEGER      NOT NULL REFERENCES wr.reports(id) ON DELETE CASCADE,
    sort_order      INTEGER      NOT NULL DEFAULT 0,
    task_title      TEXT         NOT NULL DEFAULT '',   -- (미사용) 구 버전 업무명
    plan_html       TEXT         NOT NULL DEFAULT '',   -- ① 당초 계획
    result_html     TEXT         NOT NULL DEFAULT '',   -- ② 추진 실적
    progress_rate   NUMERIC(5,1),                       -- (미사용) 진도율 %
    next_plan_html  TEXT,                               -- ③ 향후 계획
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT report_items_rate_chk
        CHECK (progress_rate IS NULL OR (progress_rate >= 0 AND progress_rate <= 100))
);
COMMENT ON TABLE  wr.report_items                IS '주간보고 상세(업무별 계획/실적)';
COMMENT ON COLUMN wr.report_items.progress_rate  IS '(향후확장) 진도율 - 현재 UI 미노출';
COMMENT ON COLUMN wr.report_items.next_plan_html IS '③ 향후 계획';

CREATE INDEX idx_report_items_report ON wr.report_items(report_id, sort_order);

CREATE TRIGGER trg_report_items_updated
    BEFORE UPDATE ON wr.report_items
    FOR EACH ROW EXECUTE FUNCTION wr.set_updated_at();


-- ---------------------------------------------------------------------
-- 첨부파일 (증적자료: 문서 / 소스파일 등)
--   item_id 가 NULL 이면 보고서 전체 귀속, 값이 있으면 해당 업무 귀속
-- ---------------------------------------------------------------------
CREATE TABLE wr.attachments (
    id             SERIAL      PRIMARY KEY,
    report_id      INTEGER     NOT NULL REFERENCES wr.reports(id)      ON DELETE CASCADE,
    item_id        INTEGER     REFERENCES wr.report_items(id)          ON DELETE CASCADE,
    original_name  TEXT        NOT NULL,
    stored_path    TEXT        NOT NULL,          -- uploads 하위 상대경로
    content_type   VARCHAR(150),
    byte_size      BIGINT      NOT NULL DEFAULT 0,
    checksum_sha256 CHAR(64),
    uploaded_by    INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE wr.attachments IS '증적자료 첨부파일';

CREATE INDEX idx_attachments_report ON wr.attachments(report_id);
CREATE INDEX idx_attachments_item   ON wr.attachments(item_id);


-- ---------------------------------------------------------------------
-- 감사 로그 (등록/수정/삭제 이력)
-- ---------------------------------------------------------------------
CREATE TABLE wr.audit_logs (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    username    VARCHAR(50),
    action      VARCHAR(40) NOT NULL,             -- LOGIN / REPORT_SAVE / REPORT_DELETE ...
    target_type VARCHAR(40),
    target_id   INTEGER,
    detail      TEXT,
    ip          VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_created ON wr.audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_user    ON wr.audit_logs(user_id);


-- ---------------------------------------------------------------------
-- 관리자 현황판 뷰: 작성자 × 주차 등록 여부를 한눈에
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW wr.v_submission_status AS
SELECT
    w.id                                   AS week_id,
    w.label                                AS week_label,
    w.start_date,
    w.end_date,
    w.is_open,
    u.id                                   AS user_id,
    u.username,
    u.name                                 AS user_name,
    u.email,
    o.id                                   AS org_id,
    o.name                                 AS org_name,
    o.sort_order,
    r.id                                   AS report_id,
    COALESCE(r.status, 'NONE')             AS status,
    r.submitted_at,
    r.updated_at,
    COALESCE(i.item_count, 0)              AS item_count,
    COALESCE(a.file_count, 0)              AS file_count
FROM wr.report_weeks w
CROSS JOIN wr.users u
LEFT JOIN wr.organizations o ON o.id = u.org_id
LEFT JOIN wr.reports r ON r.week_id = w.id AND r.author_id = u.id
LEFT JOIN LATERAL (
    SELECT count(*) AS item_count FROM wr.report_items ri WHERE ri.report_id = r.id
) i ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*) AS file_count FROM wr.attachments at WHERE at.report_id = r.id
) a ON TRUE
WHERE u.is_active = TRUE
  AND u.approval_status = 'APPROVED'
  AND u.role <> 'ADMIN';

COMMENT ON VIEW wr.v_submission_status IS '관리자 현황: 사용자 × 주차 제출 상태';

CREATE OR REPLACE VIEW wr.v_org_week_summary AS
SELECT
    week_id, week_label, start_date, is_open,
    org_id, org_name, sort_order,
    count(*)::INT AS total_users,
    count(*) FILTER (WHERE status = 'SUBMITTED')::INT AS submitted,
    count(*) FILTER (WHERE status = 'DRAFT')::INT AS draft,
    count(*) FILTER (WHERE status = 'NONE')::INT AS none_cnt
FROM wr.v_submission_status
GROUP BY week_id, week_label, start_date, is_open, org_id, org_name, sort_order;

COMMENT ON VIEW wr.v_org_week_summary IS '주차 × 기관별 제출 인원 집계';


-- ---------------------------------------------------------------------
-- 비밀번호 재설정 요청
--   메일 서버가 없는 환경이므로, 사용자가 요청을 남기면
--   관리자가 확인 후 임시 비밀번호를 발급하는 방식으로 처리한다.
--   (SMTP 도입 시 토큰/만료 컬럼을 추가해 확장)
-- ---------------------------------------------------------------------
CREATE TABLE wr.password_reset_requests (
    id           SERIAL      PRIMARY KEY,
    user_id      INTEGER     NOT NULL REFERENCES wr.users(id) ON DELETE CASCADE,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    requested_ip VARCHAR(64),
    -- 메일 발송 방식에서 사용. 토큰은 해시만 보관한다.
    token_hash   CHAR(64),
    expires_at   TIMESTAMPTZ,
    used_at      TIMESTAMPTZ,
    delivery     VARCHAR(20) NOT NULL DEFAULT 'ADMIN',
    handled_at   TIMESTAMPTZ,
    handled_by   INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT prr_status_chk   CHECK (status IN ('PENDING', 'DONE', 'REJECTED')),
    CONSTRAINT prr_delivery_chk CHECK (delivery IN ('ADMIN', 'EMAIL', 'DIRECT'))
);
COMMENT ON TABLE wr.password_reset_requests IS '비밀번호 재설정 요청. 관리자가 확인 후 임시 비밀번호 발급';

CREATE INDEX idx_prr_status ON wr.password_reset_requests(status, created_at DESC);
CREATE INDEX idx_prr_token  ON wr.password_reset_requests(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX idx_prr_user   ON wr.password_reset_requests(user_id);
