-- Rename stage_attempt_counts -> stage_attempt_counts_json to match _json column convention
-- Migration 006 originally added the column without the _json suffix; this fixes it.
SET @rename_col = (
  SELECT IF(COUNT(*) > 0,
    'ALTER TABLE workflow_task RENAME COLUMN stage_attempt_counts TO stage_attempt_counts_json',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'stage_attempt_counts'
);
PREPARE rename_col FROM @rename_col;
EXECUTE rename_col;
DEALLOCATE PREPARE rename_col;
