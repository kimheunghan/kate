-- =====================================================================
--  마이그레이션 004 : 즉시 재설정(DIRECT) 방식 구분값 추가
--
--  delivery 값
--    EMAIL  = 재설정 링크를 메일로 발송
--    DIRECT = 본인 확인 후 화면에 임시 비밀번호를 표시
--    ADMIN  = 관리자가 임시 비밀번호 발급
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

ALTER TABLE wr.password_reset_requests DROP CONSTRAINT IF EXISTS prr_delivery_chk;
ALTER TABLE wr.password_reset_requests
    ADD CONSTRAINT prr_delivery_chk CHECK (delivery IN ('ADMIN', 'EMAIL', 'DIRECT'));

COMMENT ON COLUMN wr.password_reset_requests.delivery
    IS 'EMAIL=메일 링크 발송, DIRECT=화면에 임시 비밀번호 표시, ADMIN=관리자 발급';
