import type { Artifact, Document, DocumentVersion } from "./domain";
import type { DocumentRepository } from "./repository";

export interface DocumentCurrentView {
  documentId: string;
  type: Document["type"];
  sourceKey: string;
  title: string;
  status: Document["status"];
  currentVersion: Pick<DocumentVersion, "id" | "version" | "summary" | "contentHash" | "createdAt"> | null;
  currentArtifacts: Array<Pick<Artifact, "id" | "type" | "location" | "uri" | "externalVersion" | "contentHash">>;
}

export interface DocumentHistoryView {
  documentId: string;
  versions: Array<Pick<DocumentVersion, "id" | "version" | "summary" | "contentHash" | "createdAt">>;
  artifacts: Array<Pick<Artifact, "id" | "type" | "location" | "uri" | "externalVersion" | "contentHash" | "createdAt">>;
}

export async function getDocumentCurrentView(
  repository: DocumentRepository,
  documentId: string
): Promise<DocumentCurrentView> {
  const current = await repository.getCurrentDocument(documentId);

  return {
    documentId: current.document.id,
    type: current.document.type,
    sourceKey: current.document.sourceKey,
    title: current.document.title,
    status: current.document.status,
    currentVersion: current.currentVersion ? toVersionView(current.currentVersion) : null,
    currentArtifacts: current.currentArtifacts.map(toCurrentArtifactView)
  };
}

export async function getDocumentHistoryView(
  repository: DocumentRepository,
  documentId: string
): Promise<DocumentHistoryView> {
  return {
    documentId,
    versions: (await repository.listDocumentVersions(documentId)).map(toVersionView),
    artifacts: (await repository.listArtifactHistory(documentId)).map(toHistoryArtifactView)
  };
}

function toVersionView(
  version: DocumentVersion
): Pick<DocumentVersion, "id" | "version" | "summary" | "contentHash" | "createdAt"> {
  return {
    id: version.id,
    version: version.version,
    summary: version.summary,
    contentHash: version.contentHash,
    createdAt: version.createdAt
  };
}

function toCurrentArtifactView(
  artifact: Artifact
): Pick<Artifact, "id" | "type" | "location" | "uri" | "externalVersion" | "contentHash"> {
  return {
    id: artifact.id,
    type: artifact.type,
    location: artifact.location,
    uri: artifact.uri,
    externalVersion: artifact.externalVersion,
    contentHash: artifact.contentHash
  };
}

function toHistoryArtifactView(
  artifact: Artifact
): Pick<Artifact, "id" | "type" | "location" | "uri" | "externalVersion" | "contentHash" | "createdAt"> {
  return {
    ...toCurrentArtifactView(artifact),
    createdAt: artifact.createdAt
  };
}
