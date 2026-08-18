-- =====================================================================
--  마이그레이션 002 : 업무명을 서식 있는 본문(HTML)으로 저장
--
--  업무명 칸도 계획/실적과 동일한 편집기를 쓰도록 바뀌면서
--  VARCHAR(300) 으로는 길이·서식을 담을 수 없어 TEXT 로 넓힌다.
--  (멱등: 이미 TEXT 면 아무 일도 하지 않음)
-- =====================================================================

SET client_encoding = 'UTF8';
SET search_path TO wr, public;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'wr' AND table_name = 'report_items'
           AND column_name = 'task_title' AND data_type <> 'text'
    ) THEN
        ALTER TABLE wr.report_items ALTER COLUMN task_title TYPE TEXT;
        RAISE NOTICE 'wr.report_items.task_title → TEXT 로 변경';
    END IF;
END $$;

COMMENT ON COLUMN wr.report_items.task_title IS '업무명 (정제된 HTML)';
