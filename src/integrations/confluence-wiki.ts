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

interface ConfluenceCreateResponse {
  id: string;
  _links?: {
    webui?: string;
  };
}

export class ConfluenceWikiPublisher {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(private readonly options: ConfluenceWikiPublisherOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
  }

  async publishPrd(input: PublishPrdInput): Promise<PublishPrdResult> {
    const response = await fetch(`${this.baseUrl}/wiki/rest/api/content`, {
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

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Confluence page publish failed for ${input.jiraKey}: HTTP ${response.status} ${errorBody}`
      );
    }

    const body = (await response.json()) as ConfluenceCreateResponse;

    return {
      type: "prd_wiki_page",
      location: "wiki",
      url: `${this.baseUrl}${body._links?.webui ?? `/wiki/pages/${body.id}`}`
    };
  }
}

function markdownToConfluenceStorage(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("# ")) {
        return `<h1>${escapeHtml(block.slice(2))}</h1>`;
      }

      return `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`;
    })
    .join("");
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
