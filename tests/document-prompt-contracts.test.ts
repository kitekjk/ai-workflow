import { describe, expect, it } from "vitest";
import {
  createJobPromptContractPayload,
  documentPromptContracts,
  outputSchemaForJob
} from "../src/document-core/prompt-contracts";

describe("document prompt contracts", () => {
  it("defines required sections for every document type used in the pipeline", () => {
    expect(Object.keys(documentPromptContracts).sort()).toEqual(["adr", "hld", "lld", "prd", "spec"]);
    expect(documentPromptContracts.prd.requiredMarkdownSections).toEqual(
      expect.arrayContaining(["Success Metrics", "Acceptance Criteria"])
    );
    expect(documentPromptContracts.hld.downstreamTarget).toBe("lld");
    expect(documentPromptContracts.lld.downstreamTarget).toBe("spec");
    expect(documentPromptContracts.spec.requiredMarkdownSections).toEqual(
      expect.arrayContaining(["Implementation Plan", "Test Plan"])
    );
  });

  it("builds a generation contract with markdown output requirements", () => {
    const contract = createJobPromptContractPayload({
      jobType: "document.generate",
      documentType: "hld"
    });

    expect(contract).toMatchObject({
      version: "document-contract-v1",
      documentType: "hld",
      jobType: "document.generate",
      downstreamTarget: "lld",
      outputSchema: {
        required: ["status", "markdown", "summary"]
      }
    });
    expect(contract.requiredMarkdownSections).toContain("LLD Fan-out Recommendation");
  });

  it("builds evaluation and fan-out schemas for the target document type", () => {
    expect(outputSchemaForJob("document.evaluate", "lld")).toMatchObject({
      required: ["status", "score", "summary", "missingInformation", "clarificationQuestions", "riskItems"],
      properties: {
        status: { enum: ["passed", "needs_revision"] },
        score: { minimum: 0, maximum: 100 }
      }
    });
    expect(outputSchemaForJob("document.fan_out", "hld")).toMatchObject({
      required: ["status", "targetDocumentType", "rationale", "downstreamDocuments"],
      properties: {
        targetDocumentType: { enum: ["lld"] },
        downstreamDocuments: {
          items: {
            properties: {
              type: { enum: ["lld", "adr"] }
            }
          }
        }
      }
    });
  });
});
