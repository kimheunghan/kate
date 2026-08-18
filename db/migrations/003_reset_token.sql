-- =====================================================================
--  마이그레이션 003 : 비밀번호 재설정 링크(토큰) 지원
--
--  SMTP 가 설정되면 재설정 링크를 메일로 보내고, 사용자가 직접 새 비밀번호를
--  정한다. 토큰은 평문으로 저장하지 않고 SHA-256 해시만 보관한다.
--  (SMTP 미설정 시에는 기존처럼 관리자가 처리 — 두 방식 모두 이 테이블을 쓴다)
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

ALTER TABLE wr.password_reset_requests ADD COLUMN IF NOT EXISTS token_hash  CHAR(64);
ALTER TABLE wr.password_reset_requests ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;
ALTER TABLE wr.password_reset_requests ADD COLUMN IF NOT EXISTS used_at     TIMESTAMPTZ;
ALTER TABLE wr.password_reset_requests ADD COLUMN IF NOT EXISTS delivery    VARCHAR(20) NOT NULL DEFAULT 'ADMIN';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prr_delivery_chk') THEN
        ALTER TABLE wr.password_reset_requests
            ADD CONSTRAINT prr_delivery_chk CHECK (delivery IN ('ADMIN', 'EMAIL'));
    END IF;
END $$;

COMMENT ON COLUMN wr.password_reset_requests.token_hash IS '재설정 토큰의 SHA-256 해시 (평문 미보관)';
COMMENT ON COLUMN wr.password_reset_requests.expires_at IS '토큰 만료 시각';
COMMENT ON COLUMN wr.password_reset_requests.delivery   IS 'EMAIL=메일로 링크 발송, ADMIN=관리자가 직접 처리';

CREATE INDEX IF NOT EXISTS idx_prr_token ON wr.password_reset_requests(token_hash)
    WHERE token_hash IS NOT NULL;
