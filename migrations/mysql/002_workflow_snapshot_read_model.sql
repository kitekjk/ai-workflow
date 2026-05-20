ALTER TABLE document_version
  ADD COLUMN revision_summary TEXT NULL,
  ADD COLUMN revision_job_id VARCHAR(64) NULL;

ALTER TABLE document_version
  ADD CONSTRAINT fk_document_version_revision_job FOREIGN KEY (revision_job_id) REFERENCES workflow_job (id);

ALTER TABLE quality_gate_result
  ADD COLUMN document_id VARCHAR(64) NULL,
  ADD COLUMN quality_failure_action VARCHAR(64) NULL,
  ADD COLUMN auto_revision_scheduled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE quality_gate_result
  MODIFY document_version_id VARCHAR(64) NULL;

ALTER TABLE quality_gate_result
  ADD CONSTRAINT fk_quality_gate_document FOREIGN KEY (document_id) REFERENCES document (id);

CREATE TABLE IF NOT EXISTS feedback_item (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL,
  work_item_id VARCHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL,
  author VARCHAR(256) NULL,
  body TEXT NOT NULL,
  external_id VARCHAR(256) NULL,
  external_url TEXT NULL,
  metadata_json JSON NOT NULL,
  revision_job_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_feedback_item_document FOREIGN KEY (document_id) REFERENCES document (id),
  CONSTRAINT fk_feedback_item_revision_job FOREIGN KEY (revision_job_id) REFERENCES workflow_job (id),
  UNIQUE KEY uq_feedback_external (document_id, source, external_id),
  KEY idx_feedback_document (document_id, created_at),
  KEY idx_feedback_revision_job (revision_job_id)
);
