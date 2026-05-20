CREATE TABLE IF NOT EXISTS schema_migration (
  version VARCHAR(128) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS workflow_run (
  id VARCHAR(64) PRIMARY KEY,
  workflow_definition_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_key VARCHAR(128) NOT NULL,
  output_language VARCHAR(16) NOT NULL DEFAULT 'ko',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_workflow_run_source (workflow_definition_id, source_type, source_key),
  KEY idx_workflow_run_status (status)
);

CREATE TABLE IF NOT EXISTS runner (
  id VARCHAR(128) PRIMARY KEY,
  owner_user_id VARCHAR(128) NULL,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  team_ids_json JSON NOT NULL,
  allowed_project_ids_json JSON NOT NULL,
  allowed_repository_ids_json JSON NOT NULL,
  capabilities_json JSON NOT NULL,
  engines_json JSON NOT NULL,
  default_engine VARCHAR(64) NULL,
  concurrency INT NOT NULL DEFAULT 1,
  last_heartbeat_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_runner_owner (owner_user_id),
  KEY idx_runner_status (status, mode)
);

CREATE TABLE IF NOT EXISTS workflow_job (
  id VARCHAR(64) PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  job_type VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  input_json JSON NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  project_id VARCHAR(128) NULL,
  repository_id VARCHAR(256) NULL,
  assigned_user_id VARCHAR(128) NULL,
  assigned_team_id VARCHAR(128) NULL,
  required_role VARCHAR(64) NULL,
  required_capabilities_json JSON NOT NULL,
  preferred_engine VARCHAR(64) NULL,
  required_engine VARCHAR(64) NULL,
  execution_policy VARCHAR(64) NOT NULL,
  assigned_runner_id VARCHAR(128) NULL,
  claimed_by_runner_id VARCHAR(128) NULL,
  claimed_at DATETIME(3) NULL,
  lease_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_workflow_job_run FOREIGN KEY (run_id) REFERENCES workflow_run (id),
  CONSTRAINT fk_workflow_job_assigned_runner FOREIGN KEY (assigned_runner_id) REFERENCES runner (id),
  CONSTRAINT fk_workflow_job_claimed_runner FOREIGN KEY (claimed_by_runner_id) REFERENCES runner (id),
  KEY idx_workflow_job_claim (status, priority, lease_expires_at, created_at),
  KEY idx_workflow_job_assignment (assigned_user_id, assigned_team_id),
  KEY idx_workflow_job_scope (project_id, repository_id),
  KEY idx_workflow_job_run (run_id)
);

CREATE TABLE IF NOT EXISTS workflow_job_result (
  id VARCHAR(64) PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL,
  runner_id VARCHAR(128) NULL,
  attempt_no INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  output_json JSON NOT NULL,
  error_code VARCHAR(128) NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_workflow_job_result_job FOREIGN KEY (job_id) REFERENCES workflow_job (id),
  CONSTRAINT fk_workflow_job_result_runner FOREIGN KEY (runner_id) REFERENCES runner (id),
  UNIQUE KEY uq_workflow_job_result_attempt (job_id, attempt_no),
  KEY idx_workflow_job_result_job (job_id)
);

CREATE TABLE IF NOT EXISTS workflow_event (
  id VARCHAR(64) PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  job_id VARCHAR(64) NULL,
  type VARCHAR(128) NOT NULL,
  message TEXT NOT NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_workflow_event_run FOREIGN KEY (run_id) REFERENCES workflow_run (id),
  CONSTRAINT fk_workflow_event_job FOREIGN KEY (job_id) REFERENCES workflow_job (id),
  KEY idx_workflow_event_run_created (run_id, created_at),
  KEY idx_workflow_event_job_created (job_id, created_at)
);

CREATE TABLE IF NOT EXISTS document (
  id VARCHAR(64) PRIMARY KEY,
  workflow_run_id VARCHAR(64) NOT NULL,
  parent_document_id VARCHAR(64) NULL,
  type VARCHAR(32) NOT NULL,
  source_key VARCHAR(128) NOT NULL,
  title VARCHAR(512) NOT NULL,
  status VARCHAR(64) NOT NULL,
  current_version_id VARCHAR(64) NULL,
  current_markdown_artifact_id VARCHAR(64) NULL,
  current_wiki_artifact_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_document_run FOREIGN KEY (workflow_run_id) REFERENCES workflow_run (id),
  CONSTRAINT fk_document_parent FOREIGN KEY (parent_document_id) REFERENCES document (id),
  KEY idx_document_run_type (workflow_run_id, type),
  KEY idx_document_source (type, source_key)
);

CREATE TABLE IF NOT EXISTS document_version (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  producer_job_id VARCHAR(64) NOT NULL,
  summary TEXT NULL,
  content_hash VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_document_version_document FOREIGN KEY (document_id) REFERENCES document (id),
  CONSTRAINT fk_document_version_job FOREIGN KEY (producer_job_id) REFERENCES workflow_job (id),
  UNIQUE KEY uq_document_version (document_id, version),
  KEY idx_document_version_document (document_id, created_at)
);

CREATE TABLE IF NOT EXISTS artifact (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NULL,
  document_version_id VARCHAR(64) NULL,
  producer_job_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  location VARCHAR(64) NOT NULL,
  uri TEXT NOT NULL,
  external_id VARCHAR(256) NULL,
  external_version VARCHAR(128) NULL,
  content_hash VARCHAR(128) NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_artifact_document FOREIGN KEY (document_id) REFERENCES document (id),
  CONSTRAINT fk_artifact_document_version FOREIGN KEY (document_version_id) REFERENCES document_version (id),
  CONSTRAINT fk_artifact_job FOREIGN KEY (producer_job_id) REFERENCES workflow_job (id),
  KEY idx_artifact_document_type (document_id, type, created_at),
  KEY idx_artifact_version (document_version_id),
  KEY idx_artifact_dedupe (document_id, type, location, content_hash)
);

CREATE TABLE IF NOT EXISTS quality_gate_result (
  id VARCHAR(64) PRIMARY KEY,
  document_version_id VARCHAR(64) NOT NULL,
  workflow_job_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  score INT NULL,
  summary TEXT NULL,
  missing_information_json JSON NOT NULL,
  clarification_questions_json JSON NOT NULL,
  risk_items_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_quality_gate_document_version FOREIGN KEY (document_version_id) REFERENCES document_version (id),
  CONSTRAINT fk_quality_gate_job FOREIGN KEY (workflow_job_id) REFERENCES workflow_job (id),
  KEY idx_quality_gate_document_version (document_version_id)
);

ALTER TABLE document
  ADD CONSTRAINT fk_document_current_version FOREIGN KEY (current_version_id) REFERENCES document_version (id),
  ADD CONSTRAINT fk_document_current_markdown FOREIGN KEY (current_markdown_artifact_id) REFERENCES artifact (id),
  ADD CONSTRAINT fk_document_current_wiki FOREIGN KEY (current_wiki_artifact_id) REFERENCES artifact (id);
