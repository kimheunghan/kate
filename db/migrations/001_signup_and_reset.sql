-- =====================================================================
--  마이그레이션 001 : 회원가입(승인제) + 아이디찾기 + 비밀번호 재설정 요청
--
--  이미 운영 중인 DB 에 적용:  bash scripts/migrate.sh
--  신규 설치는 01_schema.sql 에 이미 반영되어 있으므로 이 파일은 no-op 이 된다.
--  (모든 구문이 멱등(idempotent)하게 작성되어 여러 번 실행해도 안전)
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

-- ---------------------------------------------------------------------
-- users : 가입 승인 상태 / 연락처
-- ---------------------------------------------------------------------
ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'APPROVED';
ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS phone           VARCHAR(30);
ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS signup_note     TEXT;
ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ;
ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS approved_by     INTEGER REFERENCES wr.users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_approval_status_chk') THEN
        ALTER TABLE wr.users
            ADD CONSTRAINT users_approval_status_chk
            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
    END IF;
END $$;

COMMENT ON COLUMN wr.users.approval_status IS 'PENDING=가입 승인 대기, APPROVED=사용 가능, REJECTED=반려';
COMMENT ON COLUMN wr.users.signup_note     IS '가입 신청 시 사용자가 남긴 메모(담당 업무 등)';

CREATE INDEX IF NOT EXISTS idx_users_approval ON wr.users(approval_status);

-- 아이디찾기에 쓰이므로 이메일 조회를 빠르게
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON wr.users(lower(email));


-- ---------------------------------------------------------------------
-- 비밀번호 재설정 요청
--   메일 서버가 없으므로 사용자가 요청을 남기고 관리자가 처리하는 방식.
--   (SMTP 도입 시 이 테이블에 토큰/만료 컬럼을 추가해 확장)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wr.password_reset_requests (
    id           SERIAL      PRIMARY KEY,
    user_id      INTEGER     NOT NULL REFERENCES wr.users(id) ON DELETE CASCADE,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    requested_ip VARCHAR(64),
    handled_at   TIMESTAMPTZ,
    handled_by   INTEGER     REFERENCES wr.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT prr_status_chk CHECK (status IN ('PENDING', 'DONE', 'REJECTED'))
);
COMMENT ON TABLE wr.password_reset_requests IS '비밀번호 재설정 요청. 관리자가 확인 후 임시 비밀번호 발급';

CREATE INDEX IF NOT EXISTS idx_prr_status ON wr.password_reset_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prr_user   ON wr.password_reset_requests(user_id);


-- ---------------------------------------------------------------------
-- 기존 계정은 모두 승인 상태로 유지
-- ---------------------------------------------------------------------
UPDATE wr.users SET approval_status = 'APPROVED' WHERE approval_status IS NULL;
