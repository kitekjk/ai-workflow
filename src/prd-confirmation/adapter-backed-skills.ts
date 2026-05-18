import type { AgentJob, Artifact, PrdConfirmationStore } from "./domain";
import type { PrdRepository, PrdSkillExecutor, WikiPublisher } from "./ports";

export interface AdapterBackedPrdSkillsOptions {
  qualityPasses: boolean;
  prdRepository: PrdRepository;
  wikiPublisher: WikiPublisher;
}

export class AdapterBackedPrdSkills implements PrdSkillExecutor {
  qualityPasses: boolean;
  private readonly prdRepository: PrdRepository;
  private readonly wikiPublisher: WikiPublisher;

  constructor(options: AdapterBackedPrdSkillsOptions) {
    this.qualityPasses = options.qualityPasses;
    this.prdRepository = options.prdRepository;
    this.wikiPublisher = options.wikiPublisher;
  }

  async execute(job: AgentJob, store: PrdConfirmationStore): Promise<{
    output: Record<string, unknown>;
    artifacts: Artifact[];
  }> {
    if (job.jobType === "prd.generate_draft") {
      const markdown = buildPrdMarkdown(job.primaryJiraKey, store);
      const gitArtifact = await this.prdRepository.commitPrd({
        jiraKey: job.primaryJiraKey,
        markdown,
        message: `docs: update ${job.primaryJiraKey}`
      });
      const wikiArtifact = await this.wikiPublisher.publishPrd({
        jiraKey: job.primaryJiraKey,
        title: `${job.primaryJiraKey} Generated PRD`,
        markdown
      });

      return {
        output: {
          status: "succeeded",
          summary: `Generated PRD draft for ${job.primaryJiraKey}`
        },
        artifacts: [
          { jobId: job.id, ...gitArtifact },
          { jobId: job.id, ...wikiArtifact }
        ]
      };
    }

    if (job.jobType === "prd.evaluate_quality") {
      if (this.qualityPasses) {
        return {
          output: {
            status: "passed",
            score: 91,
            summary: "PRD quality gate passed"
          },
          artifacts: []
        };
      }

      return {
        output: {
          status: "needs_revision",
          score: 72,
          missingInformation: ["Success metric is missing"],
          clarificationQuestions: ["What measurable outcome should this PRD target?"],
          riskItems: ["Downstream scope may be unclear without a measurable target"]
        },
        artifacts: []
      };
    }

    const markdown = `${buildPrdMarkdown(job.primaryJiraKey, store)}\n\n## Planner Feedback Applied\n\n${String(
      job.input.feedback ?? ""
    )}\n`;
    const gitArtifact = await this.prdRepository.commitPrd({
      jiraKey: job.primaryJiraKey,
      markdown,
      message: `docs: revise ${job.primaryJiraKey}`
    });
    const wikiArtifact = await this.wikiPublisher.publishPrd({
      jiraKey: job.primaryJiraKey,
      title: `${job.primaryJiraKey} Generated PRD`,
      markdown
    });

    return {
      output: {
        status: "succeeded",
        summary: "Applied planner feedback to PRD",
        revisionSummary: job.input.feedback
      },
      artifacts: [
        { jobId: job.id, ...gitArtifact },
        { jobId: job.id, ...wikiArtifact }
      ]
    };
  }
}

function buildPrdMarkdown(prdJiraKey: string, store: PrdConfirmationStore): string {
  const prd = store.externalIssues.get(prdJiraKey);
  const sourceKeys = prd?.linkedSourceKeys ?? [];
  const sourceSections = sourceKeys
    .map((key) => store.externalIssues.get(key))
    .filter((issue) => issue !== undefined)
    .map((issue) => `### ${issue.key}: ${issue.summary}\n\n${issue.description ?? ""}`)
    .join("\n\n");

  return `# ${prdJiraKey} ${prd?.summary ?? "PRD"}\n\n## Source Requests\n\n${sourceSections}\n`;
}
