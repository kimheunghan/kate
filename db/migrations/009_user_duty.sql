-- =====================================================================
--  마이그레이션 009 : 사용자 담당 역할 추가
--
--  회원가입의 '담당 업무'(자유 입력) 를 '담당 역할'(선택) 로 바꾼다.
--    LEAD       총괄책임자
--    MANAGER    실무책임자
--    RESEARCHER 참여연구원
--
--  코드로 저장해 화면 표기를 바꾸기 쉽고, duty_order 로 정렬할 수 있다.
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS duty VARCHAR(20);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_duty_chk') THEN
        ALTER TABLE wr.users
            ADD CONSTRAINT users_duty_chk
            CHECK (duty IS NULL OR duty IN ('LEAD', 'MANAGER', 'RESEARCHER'));
    END IF;
END $$;

COMMENT ON COLUMN wr.users.duty IS '담당 역할: LEAD=총괄책임자, MANAGER=실무책임자, RESEARCHER=참여연구원';

-- 정렬용 순번 (총괄책임자 → 실무책임자 → 참여연구원 → 미지정)
CREATE OR REPLACE FUNCTION wr.duty_order(d TEXT)
RETURNS INT AS $$
    SELECT CASE d WHEN 'LEAD' THEN 1 WHEN 'MANAGER' THEN 2 WHEN 'RESEARCHER' THEN 3 ELSE 9 END;
$$ LANGUAGE sql IMMUTABLE;

CREATE INDEX IF NOT EXISTS idx_users_duty ON wr.users(duty);
