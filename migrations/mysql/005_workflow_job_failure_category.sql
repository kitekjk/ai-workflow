ALTER TABLE workflow_job_result
  ADD COLUMN error_category VARCHAR(64) NULL AFTER output_json,
  ADD KEY idx_workflow_job_result_error_category (error_category);
