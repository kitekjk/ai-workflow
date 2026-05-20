import type { Artifact, ArtifactLocation, ArtifactType, Document, DocumentType, DocumentVersion } from "./domain";

export type Awaitable<T> = T | Promise<T>;

export interface CreateDocumentInput {
  workflowRunId: string;
  parentDocumentId?: string;
  type: DocumentType;
  sourceKey: string;
  title: string;
  now?: Date;
}

export interface CreateDocumentVersionInput {
  documentId: string;
  producerJobId: string;
  summary?: string;
  revisionSummary?: string;
  revisionJobId?: string;
  contentHash?: string;
  now?: Date;
}

export interface RegisterArtifactInput {
  documentId?: string;
  documentVersionId?: string;
  producerJobId: string;
  type: ArtifactType;
  location: ArtifactLocation;
  uri: string;
  externalId?: string;
  externalVersion?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface DocumentCurrentRecord {
  document: Document;
  currentVersion?: DocumentVersion;
  currentArtifacts: Artifact[];
}

export interface DocumentRepository {
  createDocument(input: CreateDocumentInput): Awaitable<Document>;
  createDocumentVersion(input: CreateDocumentVersionInput): Awaitable<DocumentVersion>;
  registerArtifact(input: RegisterArtifactInput): Awaitable<Artifact>;
  getCurrentDocument(documentId: string): Awaitable<DocumentCurrentRecord>;
  listDocumentVersions(documentId: string): Awaitable<DocumentVersion[]>;
  listArtifactHistory(documentId: string, type?: ArtifactType): Awaitable<Artifact[]>;
}
