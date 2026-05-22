import type { DocumentType } from "./domain";

export type DocumentWorkflowJobType =
  | "prd.generate_draft"
  | "prd.evaluate_quality"
  | "prd.apply_feedback_revision"
  | "prd.route_downstream"
  | "document.generate"
  | "document.evaluate"
  | "document.revise"
  | "document.fan_out"
  | "implementation.open_pr"
  | "implementation.update_pr";

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface DocumentPromptContract {
  version: "document-contract-v1";
  documentType: DocumentType;
  displayName: string;
  generationGoal: string;
  requiredMarkdownSections: string[];
  evaluationRubric: string[];
  downstreamTarget?: Exclude<DocumentType, "prd" | "adr">;
}

export interface JobPromptContractPayload {
  version: "document-contract-v1";
  documentType: DocumentType;
  jobType: DocumentWorkflowJobType;
  displayName: string;
  generationGoal: string;
  requiredMarkdownSections: string[];
  evaluationRubric: string[];
  downstreamTarget?: Exclude<DocumentType, "prd" | "adr">;
  outputSchema: JsonSchema;
}

export const documentPromptContracts: Record<DocumentType, DocumentPromptContract> = {
  prd: {
    version: "document-contract-v1",
    documentType: "prd",
    displayName: "Product Requirements Document",
    generationGoal: "Convert linked source requests into a planner-reviewable product requirements document.",
    requiredMarkdownSections: [
      "Overview",
      "Problem Statement",
      "Goals and Non-Goals",
      "Users and Use Cases",
      "Functional Requirements",
      "Success Metrics",
      "Acceptance Criteria",
      "Open Questions"
    ],
    evaluationRubric: [
      "The problem and target users are explicit.",
      "Functional requirements are testable.",
      "Success metrics are measurable.",
      "Acceptance criteria are specific enough for downstream design."
    ],
    downstreamTarget: "hld"
  },
  hld: {
    version: "document-contract-v1",
    documentType: "hld",
    displayName: "High-Level Design",
    generationGoal: "Translate an approved PRD into architecture boundaries and downstream LLD candidates.",
    requiredMarkdownSections: [
      "Architecture Context",
      "System Boundaries",
      "Major Components",
      "Data Flow",
      "External Integrations",
      "Operational Risks",
      "LLD Fan-out Recommendation"
    ],
    evaluationRubric: [
      "Boundaries and ownership are clear.",
      "Component responsibilities are separated.",
      "Data flow and integration points are traceable to PRD requirements.",
      "LLD fan-out units are small enough for detailed design."
    ],
    downstreamTarget: "lld"
  },
  lld: {
    version: "document-contract-v1",
    documentType: "lld",
    displayName: "Low-Level Design",
    generationGoal: "Turn an HLD area into implementation-ready design detail and Spec candidates.",
    requiredMarkdownSections: [
      "Scope",
      "Use Cases",
      "API Contract",
      "Data Model",
      "Failure Handling",
      "Security and Permissions",
      "Test Strategy",
      "Rollout and Rollback",
      "Spec Fan-out Recommendation"
    ],
    evaluationRubric: [
      "APIs, data changes, and failure behavior are explicit.",
      "Security and permission impacts are covered.",
      "Test strategy maps to acceptance criteria.",
      "Spec fan-out units are PR-sized and independently verifiable."
    ],
    downstreamTarget: "spec"
  },
  adr: {
    version: "document-contract-v1",
    documentType: "adr",
    displayName: "Architecture Decision Record",
    generationGoal: "Record a significant technical decision with context, alternatives, and consequences.",
    requiredMarkdownSections: ["Status", "Context", "Decision", "Alternatives Considered", "Consequences"],
    evaluationRubric: [
      "The decision is stated unambiguously.",
      "Alternatives and tradeoffs are documented.",
      "Consequences are actionable for future maintainers."
    ]
  },
  spec: {
    version: "document-contract-v1",
    documentType: "spec",
    displayName: "Implementation Spec",
    generationGoal: "Create a PR-sized implementation specification ready for code or human execution.",
    requiredMarkdownSections: [
      "Task Scope",
      "Implementation Plan",
      "Interfaces and Files",
      "Test Plan",
      "Acceptance Criteria",
      "Rollback Plan"
    ],
    evaluationRubric: [
      "The task can be implemented in one focused PR.",
      "Files, interfaces, and tests are concrete.",
      "Acceptance criteria are directly verifiable.",
      "Rollback or failure handling is documented."
    ]
  }
};

export function createJobPromptContractPayload(input: {
  jobType: string;
  documentType?: string;
}): JobPromptContractPayload {
  const documentType = normalizeDocumentType(input.documentType ?? inferDocumentType(input.jobType));
  const jobType = normalizeJobType(input.jobType);
  const contract = documentPromptContracts[documentType];

  return {
    version: contract.version,
    documentType,
    jobType,
    displayName: contract.displayName,
    generationGoal: contract.generationGoal,
    requiredMarkdownSections: [...contract.requiredMarkdownSections],
    evaluationRubric: [...contract.evaluationRubric],
    downstreamTarget: contract.downstreamTarget,
    outputSchema: outputSchemaForJob(jobType, documentType)
  };
}

export function outputSchemaForJob(jobType: DocumentWorkflowJobType, documentType: DocumentType): JsonSchema {
  if (isEvaluationJob(jobType)) {
    return evaluationOutputSchema(documentType);
  }

  if (jobType === "prd.route_downstream") {
    return routeOutputSchema();
  }

  if (jobType === "document.fan_out") {
    return fanOutOutputSchema(documentType);
  }

  if (jobType === "implementation.open_pr") {
    return implementationOpenPrOutputSchema();
  }

  if (jobType === "implementation.update_pr") {
    return implementationUpdateOutputSchema();
  }

  return draftOutputSchema(jobType);
}

export function inferDocumentType(jobType: string): DocumentType {
  if (jobType.startsWith("prd.")) {
    return "prd";
  }

  return "prd";
}

export function normalizeDocumentType(value: string): DocumentType {
  if (value === "prd" || value === "hld" || value === "lld" || value === "adr" || value === "spec") {
    return value;
  }

  return "prd";
}

function normalizeJobType(jobType: string): DocumentWorkflowJobType {
  if (
    jobType === "prd.generate_draft" ||
    jobType === "prd.evaluate_quality" ||
    jobType === "prd.apply_feedback_revision" ||
    jobType === "prd.route_downstream" ||
    jobType === "document.generate" ||
    jobType === "document.evaluate" ||
    jobType === "document.revise" ||
    jobType === "document.fan_out" ||
    jobType === "implementation.open_pr" ||
    jobType === "implementation.update_pr"
  ) {
    return jobType;
  }

  return "document.generate";
}

function draftOutputSchema(jobType: DocumentWorkflowJobType): JsonSchema {
  return {
    type: "object",
    required: jobType === "document.revise" || jobType === "prd.apply_feedback_revision"
      ? ["status", "markdown", "summary", "revisionSummary"]
      : ["status", "markdown", "summary"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["succeeded"] },
      markdown: { type: "string", description: "Full markdown document content." },
      summary: { type: "string" },
      revisionSummary: { type: "string" },
      artifacts: { type: "array", items: { type: "object", additionalProperties: true } },
      generatedFiles: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  };
}

function evaluationOutputSchema(documentType: DocumentType): JsonSchema {
  return {
    type: "object",
    required: ["status", "score", "summary", "missingInformation", "clarificationQuestions", "riskItems"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["passed", "needs_revision"] },
      score: { type: "number", minimum: 0, maximum: 100 },
      summary: { type: "string" },
      missingInformation: { type: "array", items: { type: "string" } },
      clarificationQuestions: { type: "array", items: { type: "string" } },
      riskItems: { type: "array", items: { type: "string" } },
      documentType: { type: "string", enum: [documentType] }
    }
  };
}

function routeOutputSchema(): JsonSchema {
  return {
    type: "object",
    required: ["status", "route", "rationale", "downstreamDocuments"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["routed", "needs_scope_confirmation"] },
      route: { type: "string", enum: ["hld", "lld", "spec"] },
      rationale: { type: "string" },
      downstreamDocuments: { type: "array", items: downstreamDocumentSchema(["hld", "lld", "spec"]) }
    }
  };
}

function fanOutOutputSchema(documentType: DocumentType): JsonSchema {
  const targetTypes = documentType === "hld" ? ["lld"] : documentType === "lld" ? ["spec"] : ["hld", "lld", "spec"];
  const downstreamTypes =
    documentType === "hld" ? ["lld", "adr"] : documentType === "lld" ? ["spec", "adr"] : ["hld", "lld", "spec", "adr"];

  return {
    type: "object",
    required: ["status", "targetDocumentType", "rationale", "downstreamDocuments"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["fanout_ready", "needs_scope_confirmation"] },
      targetDocumentType: { type: "string", enum: targetTypes },
      rationale: { type: "string" },
      downstreamDocuments: { type: "array", items: downstreamDocumentSchema(downstreamTypes) }
    }
  };
}

function implementationOpenPrOutputSchema(): JsonSchema {
  return {
    type: "object",
    required: ["status", "summary", "pullRequestTitle", "pullRequestBody"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["implemented", "succeeded"] },
      latestCommitSha: { type: "string" },
      summary: { type: "string" },
      pullRequestTitle: { type: "string" },
      pullRequestBody: { type: "string" },
      artifacts: { type: "array", items: { type: "object", additionalProperties: true } },
      generatedFiles: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  };
}

function implementationUpdateOutputSchema(): JsonSchema {
  return {
    type: "object",
    required: ["status", "pullRequestNumber", "pullRequestUrl", "summary"],
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["succeeded"] },
      pullRequestNumber: { type: "integer", minimum: 1 },
      pullRequestUrl: { type: "string" },
      latestCommitSha: { type: "string" },
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "object", additionalProperties: true } },
      generatedFiles: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  };
}

function downstreamDocumentSchema(types: string[]): JsonSchema {
  return {
    type: "object",
    required: ["type", "title"],
    additionalProperties: true,
    properties: {
      type: { type: "string", enum: types },
      title: { type: "string" },
      summary: { type: "string" }
    }
  };
}

function isEvaluationJob(jobType: DocumentWorkflowJobType): boolean {
  return jobType === "prd.evaluate_quality" || jobType === "document.evaluate";
}
