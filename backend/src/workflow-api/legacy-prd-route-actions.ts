import type { FeedbackItem, FeedbackSource } from "../document-core/domain";
import type { WikiCollectedFeedback } from "../integrations/workflow-ports";
import type { LegacyPrdFixture } from "./legacy-prd-compatibility";
import { requireLegacyPrdDocumentForFixture } from "./legacy-prd-read-projection";

export function intakeLegacyPrdTicket(
  fixture: LegacyPrdFixture,
  prdJiraKey: string
): Promise<{ status: "accepted" }> {
  return fixture.workflow.intakePrdTicket(prdJiraKey);
}

export function requestLegacyPrdFeedbackRevision(
  fixture: LegacyPrdFixture,
  prdJiraKey: string,
  request: { requestedBy: string; feedback: string; now?: Date }
): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }> {
  return fixture.workflow.requestFeedbackRevision(prdJiraKey, request);
}

export function recordLegacyPrdDocumentFeedback(
  fixture: LegacyPrdFixture,
  documentId: string,
  request: {
    source?: FeedbackSource;
    author?: string;
    body: string;
    now: Date;
  }
): FeedbackItem {
  const { document } = requireLegacyPrdDocumentForFixture(fixture, documentId);

  return fixture.workflow.recordFeedback(document.sourceKey, request);
}

export function recordLegacyPrdWikiFeedback(
  fixture: LegacyPrdFixture,
  documentId: string,
  comments: WikiCollectedFeedback[],
  fallbackNow: Date,
  confluencePageId: string
): { importedCount: number; duplicateCount: number; feedbackItems: FeedbackItem[] } {
  const { document } = requireLegacyPrdDocumentForFixture(fixture, documentId);
  const knownFeedbackIds = new Set(fixture.store.feedbackItems.map((feedback) => feedback.id));
  const feedbackItems: FeedbackItem[] = [];
  let importedCount = 0;
  let duplicateCount = 0;

  for (const comment of comments) {
    const feedback = fixture.workflow.recordFeedback(document.sourceKey, {
      source: "wiki",
      author: comment.author,
      body: comment.body,
      now: dateFromIso(comment.createdAt) ?? fallbackNow,
      externalId: comment.externalId,
      externalUrl: comment.url,
      metadata: {
        ...(comment.metadata ?? {}),
        confluencePageId
      }
    });

    if (knownFeedbackIds.has(feedback.id)) {
      duplicateCount += 1;
    } else {
      importedCount += 1;
      knownFeedbackIds.add(feedback.id);
    }

    feedbackItems.push(feedback);
  }

  return {
    importedCount,
    duplicateCount,
    feedbackItems
  };
}

export function requestLegacyPrdDocumentRevision(
  fixture: LegacyPrdFixture,
  documentId: string,
  request: {
    requestedBy: string;
    feedbackItemIds?: string[];
    now: Date;
  }
): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }> {
  const { document } = requireLegacyPrdDocumentForFixture(fixture, documentId);

  return fixture.workflow.requestDocumentRevision(document.sourceKey, request);
}

export function requestLegacyPrdDocumentFanOut(
  fixture: LegacyPrdFixture,
  documentId: string,
  request: {
    requestedBy?: string;
    includeAdr?: boolean;
    adrTitle?: string;
    now: Date;
  }
): { status: "accepted" | "already_scheduled"; jobId: string } {
  const { document } = requireLegacyPrdDocumentForFixture(fixture, documentId);

  return fixture.workflow.requestDocumentFanOut(document.sourceKey, request);
}

function dateFromIso(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}
