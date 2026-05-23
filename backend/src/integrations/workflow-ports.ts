import type { ExternalIssue } from "./external-issue";

export interface JiraIssueReader {
  loadPrdWithSources(prdJiraKey: string): Promise<{
    prd: ExternalIssue;
    sources: ExternalIssue[];
  }>;
}

export interface WikiCollectedFeedback {
  externalId: string;
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface WikiFeedbackCollector {
  collectPageFeedback(input: {
    pageId?: string;
    pageUrl?: string;
    limit?: number;
    includeResolved?: boolean;
  }): Promise<{
    pageId: string;
    comments: WikiCollectedFeedback[];
  }>;
}
