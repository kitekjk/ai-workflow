CREATE TABLE IF NOT EXISTS workflow_run (
  id CHAR(36) PRIMARY KEY,
  definition_version VARCHAR(64) NOT NULL,
  source_request_ref VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  completed_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task (
  id CHAR(36) PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  parent_task_id CHAR(36) NULL,
  type VARCHAR(32) NOT NULL,
  jira_key VARCHAR(64) NOT NULL,
  assignee_email VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL,
  refs LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  terminated_at DATETIME NULL,
  INDEX idx_task_jira_key (jira_key),
  INDEX idx_task_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  job_type VARCHAR(32) NOT NULL,
  inline_inputs LONGTEXT NOT NULL,
  input_refs LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  envelope LONGTEXT NULL,
  runner_id VARCHAR(64) NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  INDEX idx_job_status (status),
  INDEX idx_job_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
