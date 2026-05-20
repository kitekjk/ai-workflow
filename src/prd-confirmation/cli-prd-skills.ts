import type { CliEngine } from "../runner-engines/cli-engine";
import { createJobPromptContractPayload } from "../document-core/prompt-contracts";
import type { AgentJob, Artifact, ExternalIssue, PrdConfirmationStore } from "./domain";
import type { PrdRepository, PrdSkillExecutor, WikiPublisher } from "./ports";

export interface CliPrdSkillsOptions {
  engine: CliEngine;
  prdRepository: PrdRepository;
  wikiPublisher: WikiPublisher;
  outputLanguage?: string;
}

export class CliPrdSkills implements PrdSkillExecutor {
  qualityPasses = true;
  private readonly engine: CliEngine;
  private readonly prdRepository: PrdRepository;
  private readonly wikiPublisher: WikiPublisher;
  private readonly outputLanguage: string;
  private readonly currentDocumentMarkdownBySourceKey = new Map<string, string>();

  constructor(options: CliPrdSkillsOptions) {
    this.engine = options.engine;
    this.prdRepository = options.prdRepository;
    this.wikiPublisher = options.wikiPublisher;
    this.outputLanguage = options.outputLanguage ?? "ko";
  }

  async execute(job: AgentJob, store: PrdConfirmationStore): Promise<{
    output: Record<string, unknown>;
    artifacts: Artifact[];
  }> {
    const output = await this.engine.runJson(this.buildCliInput(job, store));

    if (job.jobType === "prd.evaluate_quality" || job.jobType === "document.evaluate") {
      return {
        output,
        artifacts: []
      };
    }

    if (job.jobType === "prd.route_downstream" || job.jobType === "document.fan_out") {
      return {
        output,
        artifacts: []
      };
    }

    const markdown = requireString(output.markdown, "markdown");
    this.currentDocumentMarkdownBySourceKey.set(job.primaryJiraKey, markdown);
    const documentType = String(job.input.documentType ?? "prd");
    const gitArtifact = await this.prdRepository.commitPrd({
      jiraKey: job.primaryJiraKey,
      markdown,
      message:
        job.jobType === "prd.apply_feedback_revision"
          ? `docs: revise ${job.primaryJiraKey}`
          : `docs: update ${job.primaryJiraKey}`
    });
    const wikiPage = await this.wikiPublisher.publishMarkdownPage({
      documentType,
      sourceKey: job.primaryJiraKey,
      title: `${job.primaryJiraKey} Generated PRD`,
      markdown
    });
    const { markdown: _markdown, ...normalizedOutput } = output;

    return {
      output: normalizedOutput,
      artifacts: [
        { jobId: job.id, ...gitArtifact },
        {
          jobId: job.id,
          type: documentType === "prd" ? "prd_wiki_page" : "document_wiki_page",
          location: wikiPage.location,
          url: wikiPage.url
        }
      ]
    };
  }

  private buildCliInput(job: AgentJob, store: PrdConfirmationStore): Record<string, unknown> {
    const prd = store.externalIssues.get(job.primaryJiraKey);
    const sourceRequests = getSourceRequests(prd, store);
    const documentType = typeof job.input.documentType === "string" ? job.input.documentType : "prd";

    return {
      jobType: job.jobType,
      documentType,
      primaryJiraKey: job.primaryJiraKey,
      sourceKey: job.primaryJiraKey,
      prd,
      sourceRequests,
      currentDocumentMarkdown: this.currentDocumentMarkdownBySourceKey.get(job.primaryJiraKey),
      currentPrdMarkdown: this.currentDocumentMarkdownBySourceKey.get(job.primaryJiraKey),
      outputLanguage: this.outputLanguage,
      ...job.input,
      promptContract: createJobPromptContractPayload({
        jobType: job.jobType,
        documentType
      })
    };
  }
}

function getSourceRequests(
  prd: ExternalIssue | undefined,
  store: PrdConfirmationStore
): ExternalIssue[] {
  return (prd?.linkedSourceKeys ?? [])
    .map((key) => store.externalIssues.get(key))
    .filter((issue): issue is ExternalIssue => issue !== undefined);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CLI PRD skill output must include non-empty ${fieldName}`);
  }

  return value;
}
