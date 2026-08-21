-- ---------------------------------------------------------------------
-- 017. 감독관리자(SUPERVISOR) 권한을 추가한다.
--   세 기관의 등록 내역과 등록 현황을 모두 볼 수 있지만,
--   사용자·기관 관리와 활동 로그에는 들어가지 못한다.
--   보고서를 고치는 것도 총괄관리자와 마찬가지로 본인 것만 가능하다.
--   여러 번 돌려도 결과가 같다.
-- ---------------------------------------------------------------------

ALTER TABLE wr.users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE wr.users ADD CONSTRAINT users_role_chk
  CHECK (role IN ('USER', 'ORG_ADMIN', 'SUPERVISOR', 'ADMIN'));

COMMENT ON COLUMN wr.users.role IS
  'USER=작성자, ORG_ADMIN=기관관리자, SUPERVISOR=감독관리자(전체 조회), ADMIN=총괄관리자';
