import type { ExternalIssue } from "./domain";

export interface JiraIssueReader {
  loadPrdWithSources(prdJiraKey: string): Promise<{
    prd: ExternalIssue;
    sources: ExternalIssue[];
  }>;
}

export interface PrdRepository {
  commitPrd(input: {
    jiraKey: string;
    markdown: string;
    message: string;
  }): Promise<{
    type: "prd_markdown";
    location: "git";
    path?: string;
    url: string;
    commit?: string;
  }>;
}

export interface WikiPublisher {
  publishMarkdownPage(input: {
    documentType: string;
    sourceKey: string;
    title: string;
    markdown: string;
  }): Promise<{
    type: "wiki_page";
    documentType: string;
    location: "wiki";
    url: string;
  }>;

  publishPrd(input: {
    jiraKey: string;
    title: string;
    markdown: string;
  }): Promise<{
    type: "prd_wiki_page";
    location: "wiki";
    url: string;
  }>;
}

export interface PrdSkillExecutor {
  qualityPasses: boolean;
  execute(job: import("./domain").AgentJob, store: import("./domain").PrdConfirmationStore): Promise<{
    output: Record<string, unknown>;
    artifacts: import("./domain").Artifact[];
  }>;
}
