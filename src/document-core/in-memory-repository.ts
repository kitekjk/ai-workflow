import type { Artifact, ArtifactType, Document, DocumentVersion } from "./domain";
import type {
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentCurrentRecord,
  DocumentRepository,
  RegisterArtifactInput
} from "./repository";

export type { CreateDocumentInput, CreateDocumentVersionInput, RegisterArtifactInput } from "./repository";

export class InMemoryDocumentRepository implements DocumentRepository {
  readonly documents: Document[] = [];
  readonly documentVersions: DocumentVersion[] = [];
  readonly artifacts: Artifact[] = [];

  private documentSequence = 1;
  private versionSequence = 1;
  private artifactSequence = 1;

  createDocument(input: CreateDocumentInput): Document {
    const now = toIso(input.now);
    const document: Document = {
      id: `doc_${this.documentSequence++}`,
      workflowRunId: input.workflowRunId,
      workflowTaskId: input.workflowTaskId,
      parentDocumentId: input.parentDocumentId,
      type: input.type,
      sourceKey: input.sourceKey,
      title: input.title,
      status: "draft",
      createdAt: now,
      updatedAt: now
    };

    this.documents.push(document);
    return document;
  }

  createDocumentVersion(input: CreateDocumentVersionInput): DocumentVersion {
    const document = this.requireDocument(input.documentId);
    const currentVersionCount = this.documentVersions.filter((version) => version.documentId === input.documentId).length;
    const version: DocumentVersion = {
      id: `docv_${this.versionSequence++}`,
      documentId: input.documentId,
      version: currentVersionCount + 1,
      producerJobId: input.producerJobId,
      summary: input.summary,
      revisionSummary: input.revisionSummary,
      revisionJobId: input.revisionJobId,
      contentHash: input.contentHash,
      createdAt: toIso(input.now)
    };

    this.documentVersions.push(version);
    document.currentVersionId = version.id;
    document.updatedAt = version.createdAt;
    return version;
  }

  registerArtifact(input: RegisterArtifactInput): Artifact {
    const artifact: Artifact = {
      id: `art_${this.artifactSequence++}`,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      producerJobId: input.producerJobId,
      type: input.type,
      location: input.location,
      uri: input.uri,
      externalId: input.externalId,
      externalVersion: input.externalVersion,
      contentHash: input.contentHash,
      metadata: input.metadata ?? {},
      createdAt: toIso(input.now)
    };

    this.artifacts.push(artifact);
    this.updateCurrentArtifactPointer(artifact);
    return artifact;
  }

  getCurrentDocument(documentId: string): DocumentCurrentRecord {
    const document = this.requireDocument(documentId);
    const currentVersion = document.currentVersionId
      ? this.documentVersions.find((version) => version.id === document.currentVersionId)
      : undefined;
    const currentArtifactIds = [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter(
      (id): id is string => Boolean(id)
    );

    return {
      document,
      currentVersion,
      currentArtifacts: currentArtifactIds
        .map((artifactId) => this.artifacts.find((artifact) => artifact.id === artifactId))
        .filter((artifact): artifact is Artifact => Boolean(artifact))
    };
  }

  listDocumentVersions(documentId: string): DocumentVersion[] {
    return this.documentVersions
      .filter((version) => version.documentId === documentId)
      .sort((left, right) => left.version - right.version);
  }

  listArtifactHistory(documentId: string, type?: ArtifactType): Artifact[] {
    return this.artifacts
      .filter((artifact) => artifact.documentId === documentId && (!type || artifact.type === type))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private updateCurrentArtifactPointer(artifact: Artifact): void {
    if (!artifact.documentId) {
      return;
    }

    const document = this.requireDocument(artifact.documentId);

    if (artifact.type === "document_markdown") {
      document.currentMarkdownArtifactId = artifact.id;
    }

    if (artifact.type === "wiki_page") {
      document.currentWikiArtifactId = artifact.id;
    }

    document.updatedAt = artifact.createdAt;
  }

  private requireDocument(documentId: string): Document {
    const document = this.documents.find((candidate) => candidate.id === documentId);

    if (!document) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return document;
  }
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
