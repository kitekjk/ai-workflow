import type { AgentJob, AgentJobResult, Artifact, PrdConfirmationStore } from "./domain";

export class StubPrdSkills {
  constructor(public qualityPasses = true) {}

  async execute(job: AgentJob, store: PrdConfirmationStore): Promise<{
    output: Record<string, unknown>;
    artifacts: Artifact[];
  }> {
    if (job.jobType === "prd.generate_draft") {
      return {
        output: {
          status: "succeeded",
          summary: `Generated PRD draft for ${job.primaryJiraKey}`
        },
        artifacts: [
          {
            jobId: job.id,
            type: "prd_markdown",
            location: "git",
            url: `https://git.example.com/prd/prds/${job.primaryJiraKey}.md`
          },
          {
            jobId: job.id,
            type: "prd_wiki_page",
            location: "wiki",
            url: `https://wiki.example.com/prd/${job.primaryJiraKey}`
          }
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

    return {
      output: {
        status: "succeeded",
        summary: "Applied planner feedback to PRD",
        revisionSummary: job.input.feedback
      },
      artifacts: [
        {
          jobId: job.id,
          type: "prd_markdown",
          location: "git",
          url: `https://git.example.com/prd/prds/${job.primaryJiraKey}.md`
        },
        {
          jobId: job.id,
          type: "prd_wiki_page",
          location: "wiki",
          url: `https://wiki.example.com/prd/${job.primaryJiraKey}`
        }
      ]
    };
  }
}

export function createJobResult(job: AgentJob, output: Record<string, unknown>): AgentJobResult {
  return {
    jobId: job.id,
    jobType: job.jobType,
    primaryJiraKey: job.primaryJiraKey,
    output,
    processed: false
  };
}
