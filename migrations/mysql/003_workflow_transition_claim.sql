CREATE TABLE IF NOT EXISTS workflow_transition_claim (
  workflow_job_result_id VARCHAR(64) PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  claimed_by_worker_id VARCHAR(128) NOT NULL,
  claimed_at DATETIME(3) NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_workflow_transition_claim_result FOREIGN KEY (workflow_job_result_id) REFERENCES workflow_job_result (id),
  CONSTRAINT fk_workflow_transition_claim_job FOREIGN KEY (job_id) REFERENCES workflow_job (id),
  CONSTRAINT fk_workflow_transition_claim_run FOREIGN KEY (run_id) REFERENCES workflow_run (id),
  KEY idx_workflow_transition_claim_status (status, lease_expires_at),
  KEY idx_workflow_transition_claim_worker (claimed_by_worker_id, lease_expires_at)
);
