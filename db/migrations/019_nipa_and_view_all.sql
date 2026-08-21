-- ---------------------------------------------------------------------
-- 019. 감독 기관(NIPA) 과 '전체 조회' 겸직 권한
--
--   1) NIPA기관 : 3사 어디에도 속하지 않는 감독 인력을 담는 기관.
--      회원가입 화면에는 나오지 않는다. 총괄관리자가 사용자 관리에서
--      직접 추가하고 아이디·비밀번호만 알려 주면 된다.
--      이 기관 소속은 권한이 감독관리자(SUPERVISOR)가 되어 참여 인력에서 빠진다.
--
--   2) can_view_all : 3사 소속 사용자에게 주는 겸직 조회 권한.
--      권한(role)과 소속은 그대로라 참여 인력·대상 인원에 한 명으로 남고,
--      등록 내역과 주차별 현황판만 전체 범위로 볼 수 있게 된다.
--
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

-- 회원가입 화면에 보일 기관인지
ALTER TABLE wr.organizations
  ADD COLUMN IF NOT EXISTS is_signup_visible BOOLEAN NOT NULL DEFAULT TRUE;
COMMENT ON COLUMN wr.organizations.is_signup_visible
  IS '회원가입 기관 목록에 보일지 여부 (감독 기관은 FALSE)';

-- 전체 조회 겸직 권한
ALTER TABLE wr.users
  ADD COLUMN IF NOT EXISTS can_view_all BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN wr.users.can_view_all
  IS '전체 조회 겸직 권한. 참여 인력 자격은 그대로 두고 등록 내역·주차별 현황판만 전체로 본다';

-- 감독 기관 등록 (이름이 같은 기관이 이미 있으면 표시 여부만 맞춘다)
INSERT INTO wr.organizations (name, sort_order, is_active, is_signup_visible)
SELECT 'NIPA기관', COALESCE((SELECT max(sort_order) FROM wr.organizations), 0) + 10, TRUE, FALSE
 WHERE NOT EXISTS (SELECT 1 FROM wr.organizations WHERE name = 'NIPA기관');

UPDATE wr.organizations SET is_signup_visible = FALSE WHERE name = 'NIPA기관';

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM wr.organizations WHERE is_signup_visible = FALSE;
  RAISE NOTICE '019 완료: 가입 목록에서 숨긴 기관 %건', n;
END $$;
