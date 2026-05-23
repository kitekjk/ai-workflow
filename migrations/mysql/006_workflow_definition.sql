CREATE TABLE IF NOT EXISTS workflow_definition (
  id              VARCHAR(64)  NOT NULL,
  version         INT          NOT NULL,
  name            VARCHAR(255) NOT NULL,
  document_types  JSON         NOT NULL,
  entry_stage     VARCHAR(128) NOT NULL,
  body_json       JSON         NOT NULL,
  source_path     VARCHAR(512) NOT NULL,
  source_hash     VARCHAR(64)  NOT NULL,
  status          VARCHAR(32)  NOT NULL DEFAULT 'active',
  imported_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (id, version),
  KEY idx_workflow_definition_status (status, id)
);

-- Idempotent column adds to workflow_task (pattern from migration 004)
SET @add_definition_id = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN definition_id VARCHAR(64) NULL AFTER source_key',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'definition_id'
);
PREPARE add_definition_id FROM @add_definition_id;
EXECUTE add_definition_id;
DEALLOCATE PREPARE add_definition_id;

SET @add_definition_version = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN definition_version INT NULL AFTER definition_id',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'definition_version'
);
PREPARE add_definition_version FROM @add_definition_version;
EXECUTE add_definition_version;
DEALLOCATE PREPARE add_definition_version;

SET @add_current_stage_id = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN current_stage_id VARCHAR(128) NULL AFTER status',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'current_stage_id'
);
PREPARE add_current_stage_id FROM @add_current_stage_id;
EXECUTE add_current_stage_id;
DEALLOCATE PREPARE add_current_stage_id;

SET @add_stage_attempt_counts = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN stage_attempt_counts JSON NULL AFTER current_stage_id',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'stage_attempt_counts'
);
PREPARE add_stage_attempt_counts FROM @add_stage_attempt_counts;
EXECUTE add_stage_attempt_counts;
DEALLOCATE PREPARE add_stage_attempt_counts;
