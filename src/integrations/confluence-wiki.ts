export interface ConfluenceWikiPublisherOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  parentPageId: string;
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
        ancestors: [{ id: normalizePageId(this.options.parentPageId) }],
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

    const updateResponse = await fetch(`${this.baseUrl}/wiki/rest/api/content/${existingPage.id}`, {
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
        ancestors: [{ id: normalizePageId(this.options.parentPageId) }],
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

    if (!updateResponse.ok) {
      const updateErrorBody = await updateResponse.text();
      throw new Error(
        `Confluence page update failed for ${input.sourceKey}: HTTP ${updateResponse.status} ${updateErrorBody}`
      );
    }

    const updatedBody = (await updateResponse.json()) as ConfluenceCreateResponse;
    return toPublishResult(this.baseUrl, input.documentType, updatedBody);
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
