-- =====================================================================
--  활동 로그의 빈 '사용자ID / 사용자' 칸을 채운다
--
--  로그인 전에 일어나는 동작(로그인 실패·회원가입·비밀번호 재설정 등)은
--  req.user 가 없어 누가 했는지 비어 있었다. 기록에 남은 대상 번호와
--  내용으로 되짚어 채운다. 여러 번 실행해도 안전하다.
-- =====================================================================
SET client_encoding = 'UTF8';

-- 1) 대상이 사용자면 그 번호를 행위자로 본다
--    이미 지워진 계정은 넣을 수 없으므로(외래키) 남아 있는 계정만 채운다
UPDATE wr.audit_logs a
   SET user_id = a.target_id
 WHERE a.user_id IS NULL AND a.target_type = 'user' AND a.target_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM wr.users u WHERE u.id = a.target_id);

-- 2) 사용자 번호가 있으면 아이디를 채운다
UPDATE wr.audit_logs a
   SET username = u.username
  FROM wr.users u
 WHERE a.username IS NULL AND a.user_id = u.id;

-- 3) 내용에 아이디만 적힌 기록(로그인 실패·재설정 등)을 되짚는다
UPDATE wr.audit_logs a
   SET username = u.username, user_id = COALESCE(a.user_id, u.id)
  FROM wr.users u
 WHERE a.username IS NULL
   AND a.detail IS NOT NULL
   AND lower(btrim(a.detail)) = lower(u.username);

-- 4) 회원가입은 '아이디 (자동승인)' 형태로 남아 있다
UPDATE wr.audit_logs a
   SET username = u.username, user_id = COALESCE(a.user_id, u.id)
  FROM wr.users u
 WHERE a.username IS NULL
   AND a.action = 'SIGNUP'
   AND lower(split_part(btrim(a.detail), ' ', 1)) = lower(u.username);

-- 5) 로그인 실패는 이미 없는 계정일 수도 있다. 그때는 시도한 아이디를 남긴다.
UPDATE wr.audit_logs
   SET username = btrim(detail)
 WHERE username IS NULL
   AND action = 'LOGIN_FAIL'
   AND detail IS NOT NULL AND btrim(detail) <> '';

-- 6) 이미 지워진 계정이라 되짚을 수 없는 기록도 내용에 남은 아이디를 쓴다
UPDATE wr.audit_logs
   SET username = split_part(btrim(detail), ' ', 1)
 WHERE username IS NULL
   AND action IN ('SIGNUP', 'RESET_DIRECT', 'RESET_COMPLETE', 'RESET_REQUEST',
                  'RESET_MAIL_SENT', 'RESET_MAIL_FAIL')
   AND detail IS NOT NULL AND btrim(detail) <> '';
