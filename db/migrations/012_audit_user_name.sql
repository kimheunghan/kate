-- =====================================================================
--  마이그레이션 012 : 활동 로그에 사용자 이름을 함께 남긴다
--
--  계정이 지워지면 이름을 되찾을 수 없어 화면에 '(삭제된 계정)' 으로
--  나왔다. 기록할 때 이름을 같이 적어 두면 나중에도 그대로 보인다.
--  멱등하므로 여러 번 실행해도 안전.
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

ALTER TABLE wr.audit_logs ADD COLUMN IF NOT EXISTS user_name VARCHAR(100);

COMMENT ON COLUMN wr.audit_logs.user_name IS '기록 당시의 사용자 이름 (계정이 지워져도 남는다)';

-- 남아 있는 계정의 이름을 채운다
UPDATE wr.audit_logs a
   SET user_name = u.name
  FROM wr.users u
 WHERE a.user_name IS NULL AND a.user_id = u.id;

-- 아이디만 남은 기록도 같은 아이디의 계정에서 이름을 찾아 채운다
UPDATE wr.audit_logs a
   SET user_name = u.name
  FROM wr.users u
 WHERE a.user_name IS NULL AND a.user_id IS NULL
   AND lower(a.username) = lower(u.username);

DO $$
BEGIN
  RAISE NOTICE '012 완료: 이름이 채워진 기록 %건 / 아직 빈 기록 %건',
    (SELECT count(*) FROM wr.audit_logs WHERE user_name IS NOT NULL),
    (SELECT count(*) FROM wr.audit_logs WHERE user_name IS NULL);
END $$;
