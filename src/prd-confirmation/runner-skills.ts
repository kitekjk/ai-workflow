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

    if (job.jobType === "prd.apply_feedback_revision") {
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

    if (job.jobType === "prd.route_downstream") {
      return {
        output: {
          status: "routed",
          route: "hld",
          rationale: "PRD touches multiple product and service boundaries.",
          downstreamDocuments: [
            {
              type: "hld",
              title: `HLD for ${job.primaryJiraKey}`
            }
          ]
        },
        artifacts: []
      };
    }

    if (job.jobType === "document.fan_out") {
      const targetDocumentType = String(job.input.targetDocumentType ?? "lld");
      const adrTitle = typeof job.input.adrTitle === "string" ? job.input.adrTitle : undefined;

      return {
        output: {
          status: "fanout_ready",
          targetDocumentType,
          rationale: `${String(job.input.parentDocumentType ?? "document").toUpperCase()} is approved for downstream decomposition.`,
          downstreamDocuments: fanOutDocumentsFor(job.primaryJiraKey, targetDocumentType, {
            adrOnly: job.input.adrOnly === true,
            includeAdr: job.input.includeAdr === true,
            adrTitle
          })
        },
        artifacts: []
      };
    }

    if (job.jobType === "document.generate") {
      const documentType = String(job.input.documentType ?? "document");

      return {
        output: {
          status: "succeeded",
          summary: `Generated ${documentType.toUpperCase()} draft for ${job.primaryJiraKey}`
        },
        artifacts: [
          {
            jobId: job.id,
            type: "document_markdown",
            location: "git",
            url: `https://git.example.com/docs/${documentType}/${job.primaryJiraKey}.md`
          },
          {
            jobId: job.id,
            type: "document_wiki_page",
            location: "wiki",
            url: `https://wiki.example.com/${documentType}/${job.primaryJiraKey}`
          }
        ]
      };
    }

    if (job.jobType === "document.evaluate") {
      return {
        output: {
          status: "passed",
          score: 88,
          summary: `${String(job.input.documentType ?? "document").toUpperCase()} quality gate passed`
        },
        artifacts: []
      };
    }

    if (job.jobType === "document.revise") {
      return {
        output: {
          status: "succeeded",
          summary: "Applied feedback to downstream document",
          revisionSummary: job.input.feedback
        },
        artifacts: [
          {
            jobId: job.id,
            type: "document_markdown",
            location: "git",
            url: `https://git.example.com/docs/${String(job.input.documentType ?? "document")}/${job.primaryJiraKey}.md`
          },
          {
            jobId: job.id,
            type: "document_wiki_page",
            location: "wiki",
            url: `https://wiki.example.com/${String(job.input.documentType ?? "document")}/${job.primaryJiraKey}`
          }
        ]
      };
    }

    if (job.jobType === "implementation.open_pr") {
      const pullRequestNumber = 42;
      const pullRequestUrl = `https://github.example.com/acme/workflow-app/pull/${pullRequestNumber}`;

      return {
        output: {
          status: "pull_request_opened",
          provider: "github",
          repository: "acme/workflow-app",
          branchName: job.input.branchName,
          baseBranch: job.input.baseBranch,
          documentVersionId: job.input.documentVersionId,
          pullRequestNumber,
          pullRequestUrl,
          pullRequestState: "open",
          draft: job.input.draft ?? true
        },
        artifacts: [
          {
            jobId: job.id,
            type: "pull_request",
            location: "external",
            url: pullRequestUrl,
            externalId: String(pullRequestNumber),
            externalVersion: "stub-pr-head-sha",
            metadata: {
              provider: "github",
              repository: "acme/workflow-app",
              branchName: job.input.branchName,
              baseBranch: job.input.baseBranch,
              reviewStatus: "pending",
              ciStatus: "pending"
            }
          }
        ]
      };
    }

    if (job.jobType === "implementation.collect_pr_status") {
      const pullRequestNumber = Number(job.input.pullNumber ?? 42);
      const pullRequestUrl =
        typeof job.input.pullRequestUrl === "string"
          ? job.input.pullRequestUrl
          : `https://github.example.com/acme/workflow-app/pull/${pullRequestNumber}`;

      return {
        output: {
          status: "pull_request_status_collected",
          provider: "github",
          repository: "acme/workflow-app",
          documentVersionId: job.input.documentVersionId,
          pullRequestNumber,
          pullRequestUrl,
          pullRequestState: "open",
          draft: false,
          merged: false,
          latestCommitSha: "stub-pr-head-sha",
          reviewStatus: "approved",
          ciStatus: "success",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "success",
              url: "https://github.example.com/acme/workflow-app/actions/runs/1"
            }
          ]
        },
        artifacts: [
          {
            jobId: job.id,
            type: "pull_request",
            location: "external",
            url: pullRequestUrl,
            externalId: String(pullRequestNumber),
            externalVersion: "stub-pr-head-sha",
            metadata: {
              provider: "github",
              repository: "acme/workflow-app",
              reviewStatus: "approved",
              ciStatus: "success",
              checkRuns: [
                {
                  name: "unit",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.example.com/acme/workflow-app/actions/runs/1"
                }
              ]
            }
          }
        ]
      };
    }

    throw new Error(`Unsupported job type: ${job.jobType}`);
  }
}

export function createJobResult(job: AgentJob, output: Record<string, unknown>): AgentJobResult {
  return {
    jobId: job.id,
    jobType: job.jobType,
    primaryJiraKey: job.primaryJiraKey,
    output: {
      ...output
    },
    processed: false
  };
}

function fanOutDocumentsFor(
  primaryJiraKey: string,
  targetDocumentType: string,
  options: { adrOnly?: boolean; includeAdr?: boolean; adrTitle?: string } = {}
): Array<{ type: string; title: string }> {
  if (options.adrOnly) {
    return [
      {
        type: "adr",
        title: options.adrTitle ?? `ADR for ${primaryJiraKey}`
      }
    ];
  }

  const documents =
    targetDocumentType === "spec"
      ? [
          {
            type: "spec",
            title: `API Spec for ${primaryJiraKey}`
          },
          {
            type: "spec",
            title: `UI Spec for ${primaryJiraKey}`
          }
        ]
      : [
          {
            type: "lld",
            title: `Backend LLD for ${primaryJiraKey}`
          },
          {
            type: "lld",
            title: `Frontend LLD for ${primaryJiraKey}`
          }
        ];

  if (options.includeAdr) {
    documents.push({
      type: "adr",
      title: options.adrTitle ?? `ADR for ${primaryJiraKey}`
    });
  }

  return documents;
}
