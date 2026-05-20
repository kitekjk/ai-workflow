export interface ConfluenceWikiPublisherOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  parentPageId: string;
  parentPageIdByDocumentType?: Record<string, string | undefined>;
}

export interface PublishPrdInput {
  jiraKey: string;
  title: string;
  markdown: string;
}

export interface PublishPrdResult {
  type: "prd_wiki_page";
  location: "wiki";
  url: string;
}

export interface PublishMarkdownPageInput {
  documentType: string;
  sourceKey: string;
  title: string;
  markdown: string;
}

export interface PublishMarkdownPageResult {
  type: "wiki_page";
  documentType: string;
  location: "wiki";
  url: string;
}

export interface CollectConfluencePageFeedbackInput {
  pageId?: string;
  pageUrl?: string;
  limit?: number;
  includeResolved?: boolean;
}

export interface ConfluenceCollectedFeedback {
  externalId: string;
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface CollectConfluencePageFeedbackResult {
  pageId: string;
  comments: ConfluenceCollectedFeedback[];
}

interface ConfluenceCreateResponse {
  id: string;
  title?: string;
  version?: {
    number: number;
  };
  _links?: {
    webui?: string;
  };
}

interface ConfluenceSearchResponse {
  results?: ConfluenceCreateResponse[];
}

interface ConfluenceCommentResponse {
  results?: ConfluenceCommentModel[];
  _links?: {
    next?: string;
    base?: string;
  };
}

interface ConfluenceCommentModel {
  id: string;
  status?: string;
  title?: string;
  pageId?: string;
  parentCommentId?: string;
  version?: {
    createdAt?: string;
    authorId?: string;
  };
  author?: {
    accountId?: string;
    displayName?: string;
  };
  createdBy?: {
    accountId?: string;
    displayName?: string;
  };
  body?: {
    storage?: {
      value?: string;
    };
    view?: {
      value?: string;
    };
    atlas_doc_format?: {
      value?: unknown;
    };
  };
  resolutionStatus?: string;
  properties?: {
    inlineOriginalSelection?: string;
  };
  _links?: {
    webui?: string;
  };
}

type ConfluenceUpdateAttempt =
  | {
      ok: true;
      body: ConfluenceCreateResponse;
    }
  | {
      ok: false;
      status: number;
      errorBody: string;
    };

export class ConfluenceWikiPublisher {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(private readonly options: ConfluenceWikiPublisherOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
  }

  async publishPrd(input: PublishPrdInput): Promise<PublishPrdResult> {
    const result = await this.publishMarkdownPage({
      documentType: "prd",
      sourceKey: input.jiraKey,
      title: input.title,
      markdown: input.markdown
    });

    return {
      type: "prd_wiki_page",
      location: result.location,
      url: result.url
    };
  }

  async publishMarkdownPage(input: PublishMarkdownPageInput): Promise<PublishMarkdownPageResult> {
    const parentPageId = this.parentPageIdFor(input.documentType);
    const createResponse = await fetch(`${this.baseUrl}/wiki/rest/api/content`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: this.authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "page",
        title: input.title,
        space: { key: this.options.spaceKey },
        ancestors: [{ id: parentPageId }],
        body: {
          storage: {
            value: markdownToConfluenceStorage(input.markdown),
            representation: "storage"
          }
        }
      })
    });

    if (createResponse.ok) {
      const body = (await createResponse.json()) as ConfluenceCreateResponse;
      return toPublishResult(this.baseUrl, input.documentType, body);
    }

    const errorBody = await createResponse.text();
    if (!isDuplicateTitleError(createResponse.status, errorBody)) {
      throw new Error(
        `Confluence page publish failed for ${input.sourceKey}: HTTP ${createResponse.status} ${errorBody}`
      );
    }

    const existingPage = await this.findExistingPage(input.title);
    if (!existingPage) {
      throw new Error(
        `Confluence page publish failed for ${input.sourceKey}: HTTP ${createResponse.status} ${errorBody}`
      );
    }

    let updateAttempt = await this.updateExistingPage(input, existingPage, parentPageId);
    if (!updateAttempt.ok && isVersionConflictError(updateAttempt.status, updateAttempt.errorBody)) {
      const latestExistingPage = await this.findExistingPage(input.title);
      if (latestExistingPage) {
        updateAttempt = await this.updateExistingPage(input, latestExistingPage, parentPageId);
      }
    }

    if (!updateAttempt.ok) {
      throw new Error(
        `Confluence page update failed for ${input.sourceKey}: HTTP ${updateAttempt.status} ${updateAttempt.errorBody}`
      );
    }

    return toPublishResult(this.baseUrl, input.documentType, updateAttempt.body);
  }

  async collectPageFeedback(
    input: CollectConfluencePageFeedbackInput
  ): Promise<CollectConfluencePageFeedbackResult> {
    const pageId = normalizePageId(requirePageIdInput(input));
    const limit = input.limit ?? 50;
    const footerComments = await this.fetchComments(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/footer-comments`,
      {
        "body-format": "storage",
        status: "current",
        limit: String(limit)
      }
    );
    const inlineComments = await this.fetchComments(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/inline-comments`,
      {
        "body-format": "storage",
        status: "current",
        ...(input.includeResolved ? {} : { "resolution-status": "open" }),
        limit: String(limit)
      }
    );

    return {
      pageId,
      comments: [...footerComments, ...inlineComments]
        .map((comment) => toCollectedFeedback(this.baseUrl, comment))
        .filter((comment) => comment.body.length > 0)
    };
  }

  private async fetchComments(path: string, params: Record<string, string>): Promise<ConfluenceCommentModel[]> {
    const comments: ConfluenceCommentModel[] = [];
    let nextUrl: string | undefined = withQuery(`${this.baseUrl}${path}`, params);

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: this.authorization
        }
      });

      if (!response.ok) {
        throw new Error(`Confluence comments fetch failed: HTTP ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as ConfluenceCommentResponse;
      comments.push(...(body.results ?? []));
      nextUrl = nextConfluencePageUrl(this.baseUrl, body._links?.next, response.headers.get("link"));
    }

    return comments;
  }

  private async updateExistingPage(
    input: PublishMarkdownPageInput,
    existingPage: ConfluenceCreateResponse,
    parentPageId: string
  ): Promise<ConfluenceUpdateAttempt> {
    const response = await fetch(`${this.baseUrl}/wiki/rest/api/content/${existingPage.id}`, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: this.authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: existingPage.id,
        type: "page",
        title: input.title,
        space: { key: this.options.spaceKey },
        ancestors: [{ id: parentPageId }],
        version: {
          number: (existingPage.version?.number ?? 1) + 1
        },
        body: {
          storage: {
            value: markdownToConfluenceStorage(input.markdown),
            representation: "storage"
          }
        }
      })
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorBody: await response.text()
      };
    }

    return {
      ok: true,
      body: (await response.json()) as ConfluenceCreateResponse
    };
  }

  private async findExistingPage(title: string): Promise<ConfluenceCreateResponse | undefined> {
    const params = new URLSearchParams({
      spaceKey: this.options.spaceKey,
      title,
      expand: "version,_links"
    });
    const response = await fetch(`${this.baseUrl}/wiki/rest/api/content?${params}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: this.authorization
      }
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as ConfluenceSearchResponse;
    return body.results?.[0];
  }

  private parentPageIdFor(documentType: string): string {
    const key = documentType.trim().toLowerCase();
    const routedParentPageId = this.options.parentPageIdByDocumentType?.[key];

    return normalizePageId(routedParentPageId || this.options.parentPageId);
  }
}

function toPublishResult(
  baseUrl: string,
  documentType: string,
  body: ConfluenceCreateResponse
): PublishMarkdownPageResult {
  return {
    type: "wiki_page",
    documentType,
    location: "wiki",
    url: `${baseUrl}${body._links?.webui ?? `/wiki/pages/${body.id}`}`
  };
}

function isDuplicateTitleError(status: number, body: string): boolean {
  const normalized = body.toLowerCase();
  return status === 400 && (normalized.includes("same title") || normalized.includes("title already exists"));
}

function isVersionConflictError(status: number, body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    status === 409 ||
    normalized.includes("version conflict") ||
    normalized.includes("stale") ||
    normalized.includes("current version") ||
    normalized.includes("latest version")
  );
}

function markdownToConfluenceStorage(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map(renderMarkdownBlock)
    .join("");
}

function renderMarkdownBlock(block: string): string {
  const html: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    html.push(`<p>${paragraphLines.map(escapeHtml).join("<br />")}</p>`);
    paragraphLines = [];
  };

  for (const line of block.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return html.join("");
}

function normalizePageId(value: string): string {
  const match = value.match(/\/pages\/(\d+)(?:\/|$)/);

  if (match) {
    return match[1];
  }

  return value;
}

function requirePageIdInput(input: CollectConfluencePageFeedbackInput): string {
  const value = input.pageId ?? input.pageUrl;

  if (!value?.trim()) {
    throw new Error("Confluence pageId or pageUrl is required to collect feedback");
  }

  return value.trim();
}

function toCollectedFeedback(baseUrl: string, comment: ConfluenceCommentModel): ConfluenceCollectedFeedback {
  const inlineSelection = comment.properties?.inlineOriginalSelection;
  const body = textFromConfluenceBody(comment.body);
  const withSelection =
    inlineSelection && body ? `Selection: ${inlineSelection}\nComment: ${body}` : body || inlineSelection || "";

  return {
    externalId: `confluence-comment:${comment.id}`,
    author: comment.author?.displayName ?? comment.createdBy?.displayName ?? comment.version?.authorId,
    body: withSelection.trim(),
    createdAt: comment.version?.createdAt,
    url: comment._links?.webui ? `${baseUrl}${comment._links.webui}` : undefined,
    metadata: {
      confluenceCommentId: comment.id,
      pageId: comment.pageId,
      parentCommentId: comment.parentCommentId,
      status: comment.status,
      resolutionStatus: comment.resolutionStatus,
      title: comment.title
    }
  };
}

function textFromConfluenceBody(body: ConfluenceCommentModel["body"]): string {
  const storageValue = body?.storage?.value;
  if (storageValue) {
    return htmlToText(storageValue);
  }

  const viewValue = body?.view?.value;
  if (viewValue) {
    return htmlToText(viewValue);
  }

  const adfValue = body?.atlas_doc_format?.value;
  if (typeof adfValue === "string") {
    return adfValue.trim().startsWith("{") ? textFromAdf(safeJsonParse(adfValue)) : adfValue;
  }

  return textFromAdf(adfValue);
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textFromAdf(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(textFromAdf).filter(Boolean).join(" ");
  }

  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const childText = textFromAdf(record.content);

  return [text, childText].filter(Boolean).join(" ").trim();
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function withQuery(url: string, params: Record<string, string>): string {
  const nextUrl = new URL(url);

  for (const [key, value] of Object.entries(params)) {
    nextUrl.searchParams.set(key, value);
  }

  return nextUrl.toString();
}

function nextConfluencePageUrl(baseUrl: string, bodyNext: string | undefined, linkHeader: string | null): string | undefined {
  const nextFromBody = bodyNext ? absoluteConfluenceUrl(baseUrl, bodyNext) : undefined;

  if (nextFromBody) {
    return nextFromBody;
  }

  const nextLink = linkHeader
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => /rel="?next"?/.test(part));
  const match = nextLink?.match(/<([^>]+)>/);

  return match ? absoluteConfluenceUrl(baseUrl, match[1]) : undefined;
}

function absoluteConfluenceUrl(baseUrl: string, value: string): string {
  return new URL(value, baseUrl).toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
