export interface ExternalIssue {
  key: string;
  issueType: "operational_request" | "prd";
  status: string;
  summary: string;
  description?: string;
  linkedSourceKeys?: string[];
}
