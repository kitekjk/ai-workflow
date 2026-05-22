CREATE TABLE IF NOT EXISTS workflow_task (
  id VARCHAR(64) PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  parent_task_id VARCHAR(64) NULL,
  task_type VARCHAR(64) NOT NULL,
  source_key VARCHAR(128) NOT NULL,
  title VARCHAR(512) NOT NULL,
  status VARCHAR(64) NOT NULL,
  current_document_id VARCHAR(64) NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_workflow_task_run FOREIGN KEY (run_id) REFERENCES workflow_run (id),
  CONSTRAINT fk_workflow_task_parent FOREIGN KEY (parent_task_id) REFERENCES workflow_task (id),
  KEY idx_workflow_task_run_parent (run_id, parent_task_id),
  KEY idx_workflow_task_run_type (run_id, task_type),
  KEY idx_workflow_task_status (status)
);

SET @add_document_workflow_task_id = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE document ADD COLUMN workflow_task_id VARCHAR(64) NULL AFTER workflow_run_id',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'document'
    AND COLUMN_NAME = 'workflow_task_id'
);

PREPARE add_document_workflow_task_id FROM @add_document_workflow_task_id;
EXECUTE add_document_workflow_task_id;
DEALLOCATE PREPARE add_document_workflow_task_id;

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', document.id),
  document.workflow_run_id,
  NULL,
  document.type,
  document.source_key,
  document.title,
  document.status,
  document.id,
  JSON_OBJECT('backfilledFromDocumentId', document.id),
  document.created_at,
  document.updated_at
FROM document
WHERE document.parent_document_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_task existing
    WHERE existing.id = CONCAT('task_', document.id)
  );

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', child.id),
  child.workflow_run_id,
  parent_task.id,
  child.type,
  child.source_key,
  child.title,
  child.status,
  child.id,
  JSON_OBJECT('backfilledFromDocumentId', child.id),
  child.created_at,
  child.updated_at
FROM document child
INNER JOIN document parent_document
  ON parent_document.id = child.parent_document_id
INNER JOIN workflow_task parent_task
  ON parent_task.current_document_id = parent_document.id
WHERE child.parent_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_task existing
    WHERE existing.id = CONCAT('task_', child.id)
  );

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', child.id),
  child.workflow_run_id,
  parent_task.id,
  child.type,
  child.source_key,
  child.title,
  child.status,
  child.id,
  JSON_OBJECT('backfilledFromDocumentId', child.id),
  child.created_at,
  child.updated_at
FROM document child
INNER JOIN document parent_document
  ON parent_document.id = child.parent_document_id
INNER JOIN workflow_task parent_task
  ON parent_task.current_document_id = parent_document.id
WHERE child.parent_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_task existing
    WHERE existing.id = CONCAT('task_', child.id)
  );

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', child.id),
  child.workflow_run_id,
  parent_task.id,
  child.type,
  child.source_key,
  child.title,
  child.status,
  child.id,
  JSON_OBJECT('backfilledFromDocumentId', child.id),
  child.created_at,
  child.updated_at
FROM document child
INNER JOIN document parent_document
  ON parent_document.id = child.parent_document_id
INNER JOIN workflow_task parent_task
  ON parent_task.current_document_id = parent_document.id
WHERE child.parent_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_task existing
    WHERE existing.id = CONCAT('task_', child.id)
  );

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', child.id),
  child.workflow_run_id,
  parent_task.id,
  child.type,
  child.source_key,
  child.title,
  child.status,
  child.id,
  JSON_OBJECT('backfilledFromDocumentId', child.id),
  child.created_at,
  child.updated_at
FROM document child
INNER JOIN document parent_document
  ON parent_document.id = child.parent_document_id
INNER JOIN workflow_task parent_task
  ON parent_task.current_document_id = parent_document.id
WHERE child.parent_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_task existing
    WHERE existing.id = CONCAT('task_', child.id)
  );

UPDATE document
INNER JOIN workflow_task
  ON workflow_task.current_document_id = document.id
 AND workflow_task.task_type = document.type
SET document.workflow_task_id = workflow_task.id
WHERE document.workflow_task_id IS NULL;

INSERT INTO workflow_task (
  id, run_id, parent_task_id, task_type, source_key, title, status,
  current_document_id, metadata_json, created_at, updated_at
)
SELECT
  CONCAT('task_', document.id, '_code'),
  document.workflow_run_id,
  document.workflow_task_id,
  'code',
  document.source_key,
  CONCAT('Code Implementation for ', document.source_key),
  'in_progress',
  document.id,
  JSON_OBJECT('backfilledFromImplementationDocumentId', document.id),
  MIN(job.created_at),
  MAX(job.updated_at)
FROM workflow_job job
INNER JOIN document
  ON document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.sourceDocumentId'))
  OR document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.documentId'))
WHERE job.job_type LIKE 'implementation.%'
  AND document.workflow_task_id IS NOT NULL
GROUP BY document.id, document.workflow_run_id, document.workflow_task_id, document.source_key
HAVING NOT EXISTS (
  SELECT 1
  FROM workflow_task existing
  WHERE existing.id = CONCAT('task_', document.id, '_code')
);

SET @add_workflow_job_task_id = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE workflow_job ADD COLUMN task_id VARCHAR(64) NULL AFTER run_id',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workflow_job'
    AND COLUMN_NAME = 'task_id'
);

PREPARE add_workflow_job_task_id FROM @add_workflow_job_task_id;
EXECUTE add_workflow_job_task_id;
DEALLOCATE PREPARE add_workflow_job_task_id;

UPDATE workflow_job job
INNER JOIN document
  ON document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.sourceDocumentId'))
SET job.task_id = document.workflow_task_id
WHERE job.task_id IS NULL
  AND job.job_type NOT LIKE 'implementation.%';

UPDATE workflow_job job
INNER JOIN document
  ON document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.documentId'))
SET job.task_id = document.workflow_task_id
WHERE job.task_id IS NULL
  AND job.job_type NOT LIKE 'implementation.%';

UPDATE workflow_job job
INNER JOIN document
  ON document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.parentDocumentId'))
SET job.task_id = document.workflow_task_id
WHERE job.task_id IS NULL
  AND job.job_type NOT LIKE 'implementation.%';

UPDATE workflow_job job
INNER JOIN document
  ON document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.sourceDocumentId'))
  OR document.id = JSON_UNQUOTE(JSON_EXTRACT(job.input_json, '$.documentId'))
SET job.task_id = CONCAT('task_', document.id, '_code')
WHERE job.task_id IS NULL
  AND job.job_type LIKE 'implementation.%';

UPDATE workflow_job job
INNER JOIN document
  ON document.workflow_run_id = job.run_id
 AND document.parent_document_id IS NULL
SET job.task_id = document.workflow_task_id
WHERE job.task_id IS NULL;

SET @add_document_workflow_task_key = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE document ADD KEY idx_document_workflow_task (workflow_task_id)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'document'
    AND INDEX_NAME = 'idx_document_workflow_task'
);

PREPARE add_document_workflow_task_key FROM @add_document_workflow_task_key;
EXECUTE add_document_workflow_task_key;
DEALLOCATE PREPARE add_document_workflow_task_key;

SET @add_document_workflow_task_fk = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE document ADD CONSTRAINT fk_document_workflow_task FOREIGN KEY (workflow_task_id) REFERENCES workflow_task (id)',
    'SELECT 1'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'document'
    AND CONSTRAINT_NAME = 'fk_document_workflow_task'
);

PREPARE add_document_workflow_task_fk FROM @add_document_workflow_task_fk;
EXECUTE add_document_workflow_task_fk;
DEALLOCATE PREPARE add_document_workflow_task_fk;

SET @add_workflow_job_task_key = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE workflow_job ADD KEY idx_workflow_job_task (task_id, status, created_at)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workflow_job'
    AND INDEX_NAME = 'idx_workflow_job_task'
);

PREPARE add_workflow_job_task_key FROM @add_workflow_job_task_key;
EXECUTE add_workflow_job_task_key;
DEALLOCATE PREPARE add_workflow_job_task_key;

SET @add_workflow_job_task_fk = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE workflow_job ADD CONSTRAINT fk_workflow_job_task FOREIGN KEY (task_id) REFERENCES workflow_task (id)',
    'SELECT 1'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workflow_job'
    AND CONSTRAINT_NAME = 'fk_workflow_job_task'
);

PREPARE add_workflow_job_task_fk FROM @add_workflow_job_task_fk;
EXECUTE add_workflow_job_task_fk;
DEALLOCATE PREPARE add_workflow_job_task_fk;
