-- ---------------------------------------------------------------------
-- 015. 사용자 정보에 마지막 접속 IP 를 직접 남긴다.
--   지금까지는 활동 로그에서 찾아 썼는데, 로그는 1년 뒤 지워지므로
--   오래된 사람은 접속 IP 가 사라진다. 로그인할 때마다 여기에 남긴다.
--   기존 값은 활동 로그에 남아 있는 마지막 접속 주소로 채운다.
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

ALTER TABLE wr.users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45);
COMMENT ON COLUMN wr.users.last_login_ip IS '마지막으로 로그인한 접속 IP';

UPDATE wr.users u
   SET last_login_ip = a.ip
  FROM (
    SELECT DISTINCT ON (user_id) user_id, ip
      FROM wr.audit_logs
     WHERE user_id IS NOT NULL AND ip IS NOT NULL
     ORDER BY user_id, created_at DESC
  ) a
 WHERE a.user_id = u.id AND u.last_login_ip IS NULL;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM wr.users WHERE last_login_ip IS NOT NULL;
  RAISE NOTICE '015 완료: 접속 IP 가 채워진 사용자 %건', n;
END $$;
