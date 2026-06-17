import { registerComponent } from "../componentConfig.js";
import type { ComponentType } from "../componentConfig.js";
import { BaseTool, JSONSchema, ToolResult } from "./base.js";

export interface DomainFilterOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface WebSearchToolOptions extends DomainFilterOptions {
  apiKey?: string;
}

export interface GoogleSearchToolOptions extends DomainFilterOptions {
  apiKey?: string;
  cseId?: string;
}

export interface WebFetchToolOptions extends DomainFilterOptions {
  maxContentLength?: number;
  fetchImpl?: typeof fetch;
}

export interface ArxivSearchToolOptions {
  fetchImpl?: typeof fetch;
}

export interface YouTubeCaptionToolOptions {
  fetchImpl?: typeof fetch;
}

export class WebSearchTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.WebSearchTool";
  static componentVersion = 1;

  apiKey?: string;
  allowedDomains: string[];
  blockedDomains: string[];
  private fetchImpl: typeof fetch;

  constructor(options: WebSearchToolOptions = {}) {
    super({
      name: "web_search",
      description:
        "Search the web for information using Tavily. Returns titles, URLs, and snippets from search results."
    });
    this.apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
    this.allowedDomains = options.allowedDomains ?? [];
    this.blockedDomains = options.blockedDomains ?? [];
    this.fetchImpl = fetch;
  }

  static fromConfig(config: Record<string, unknown>): WebSearchTool {
    return new WebSearchTool(config as WebSearchToolOptions);
  }

  toConfig(): Record<string, unknown> {
    return {
      allowedDomains: this.allowedDomains,
      blockedDomains: this.blockedDomains
    };
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return (default: 5)"
        }
      },
      required: ["query"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const query = String(parameters.query ?? "");
    const maxResults = clampInteger(parameters.max_results, 1, 10, 5);

    if (!this.apiKey) {
      return new ToolResult({
        success: false,
        result: null,
        error: "Tavily API key not provided. Pass apiKey to WebSearchTool constructor or set TAVILY_API_KEY.",
        metadata: { query }
      });
    }

    try {
      const response = await this.fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: maxResults
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data = await response.json() as { results?: Array<Record<string, unknown>> };
      const rawResults = data.results ?? [];
      const results = rawResults
        .map((item) => ({
          title: String(item.title ?? ""),
          url: String(item.url ?? ""),
          snippet: String(item.content ?? "")
        }))
        .filter((item) => isDomainAllowed(item.url, this.allowedDomains, this.blockedDomains));

      return new ToolResult({
        success: true,
        result: results,
        metadata: {
          query,
          count: results.length,
          filtered: rawResults.length - results.length
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { query }
      });
    }
  }
}

export class GoogleSearchTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.GoogleSearchTool";
  static componentVersion = 1;

  apiKey?: string;
  cseId?: string;
  allowedDomains: string[];
  blockedDomains: string[];
  private fetchImpl: typeof fetch;

  constructor(options: GoogleSearchToolOptions = {}) {
    super({
      name: "google_search",
      description:
        "Search the web using Google Custom Search API. Returns titles, URLs, and snippets."
    });
    this.apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY;
    this.cseId = options.cseId ?? process.env.GOOGLE_CSE_ID;
    this.allowedDomains = options.allowedDomains ?? [];
    this.blockedDomains = options.blockedDomains ?? [];
    this.fetchImpl = fetch;
  }

  static fromConfig(config: Record<string, unknown>): GoogleSearchTool {
    return new GoogleSearchTool(config as GoogleSearchToolOptions);
  }

  toConfig(): Record<string, unknown> {
    return {
      allowedDomains: this.allowedDomains,
      blockedDomains: this.blockedDomains
    };
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        num_results: {
          type: "integer",
          description: "Maximum number of results to return (default: 5, max: 10)"
        },
        language: { type: "string", description: "Language code for search results" },
        country: { type: "string", description: "Country code for search results" },
        safe_search: { type: "boolean", description: "Enable safe search filtering" }
      },
      required: ["query"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const query = String(parameters.query ?? "");
    const numResults = clampInteger(parameters.num_results, 1, 10, 5);

    if (!this.apiKey || !this.cseId) {
      return new ToolResult({
        success: false,
        result: null,
        error: "Google API key and CSE ID not provided. Pass apiKey/cseId or set GOOGLE_API_KEY and GOOGLE_CSE_ID.",
        metadata: { query }
      });
    }

    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", this.apiKey);
      url.searchParams.set("cx", this.cseId);
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(numResults));
      url.searchParams.set("hl", String(parameters.language ?? "en"));
      url.searchParams.set("safe", parameters.safe_search === false ? "off" : "active");
      if (parameters.country) url.searchParams.set("gl", String(parameters.country));

      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data = await response.json() as { items?: Array<Record<string, unknown>> };
      const rawResults = data.items ?? [];
      const results = rawResults
        .map((item) => ({
          title: String(item.title ?? ""),
          url: String(item.link ?? ""),
          snippet: String(item.snippet ?? "")
        }))
        .filter((item) => isDomainAllowed(item.url, this.allowedDomains, this.blockedDomains));

      return new ToolResult({
        success: true,
        result: results,
        metadata: {
          query,
          count: results.length,
          filtered: rawResults.length - results.length
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Google search failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { query }
      });
    }
  }
}

export class WebFetchTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.WebFetchTool";
  static componentVersion = 1;

  allowedDomains: string[];
  blockedDomains: string[];
  maxContentLength: number;
  private fetchImpl: typeof fetch;

  constructor(options: WebFetchToolOptions = {}) {
    super({
      name: "web_fetch",
      description:
        "Fetch content from a URL as raw HTML, plain text, or simple markdown. URL access can be filtered by domain."
    });
    this.allowedDomains = options.allowedDomains ?? [];
    this.blockedDomains = options.blockedDomains ?? [];
    this.maxContentLength = options.maxContentLength ?? 100_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(config: Record<string, unknown>): WebFetchTool {
    return new WebFetchTool(config as WebFetchToolOptions);
  }

  toConfig(): Record<string, unknown> {
    return {
      allowedDomains: this.allowedDomains,
      blockedDomains: this.blockedDomains,
      maxContentLength: this.maxContentLength
    };
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        output_format: {
          type: "string",
          enum: ["html", "text", "markdown"],
          description: "Output format: html, text, or markdown. Default: html"
        },
        extract_text: {
          type: "boolean",
          description: "Legacy alias for output_format=text"
        }
      },
      required: ["url"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const url = String(parameters.url ?? "");
    let outputFormat = String(parameters.output_format ?? "html");
    if (parameters.extract_text) outputFormat = "text";

    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("URL must use http or https");
      }
      if (!isDomainAllowed(url, this.allowedDomains, this.blockedDomains)) {
        return new ToolResult({
          success: false,
          result: null,
          error: `URL domain is blocked or not in allowed list: ${parsed.host}`,
          metadata: { url, domain: parsed.host }
        });
      }

      const response = await this.fetchImpl(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);

      let content = await response.text();
      const originalLength = content.length;
      if (outputFormat === "text") {
        content = extractTextFromHtml(content);
      } else if (outputFormat === "markdown") {
        content = htmlToSimpleMarkdown(content);
      } else if (outputFormat !== "html") {
        throw new Error(`Unknown output_format: ${outputFormat}`);
      }

      const truncated = content.length > this.maxContentLength;
      if (truncated) content = content.slice(0, this.maxContentLength);

      return new ToolResult({
        success: true,
        result: content,
        metadata: {
          url,
          output_format: outputFormat,
          content_length: content.length,
          original_length: originalLength,
          status_code: response.status,
          truncated,
          max_length: this.maxContentLength
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { url }
      });
    }
  }
}

export class ExtractTextTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.ExtractTextTool";
  static componentVersion = 1;

  constructor() {
    super({
      name: "extract_text",
      description: "Extract clean text content from HTML, removing scripts, styles, and tags."
    });
  }

  static fromConfig(_config: Record<string, unknown>): ExtractTextTool {
    return new ExtractTextTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

    get parameters(): JSONSchema {
      return {
        type: "object",
        properties: {
          html: { type: "string", description: "HTML content to extract text from" },
          selector: {
            type: "string",
            description: "Optional simple CSS selector (tag, #id, .class, tag.class, or tag#id)"
          }
        },
        required: ["html"]
      };
    }

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const html = String(parameters.html ?? "");
      const selector = parameters.selector === undefined ? undefined : String(parameters.selector);
      let selectedHtml = html;
      if (selector) {
        try {
          selectedHtml = selectHtml(html, selector);
        } catch (error) {
          return new ToolResult({
            success: false,
            result: null,
            error: `CSS selector extraction failed: ${error instanceof Error ? error.message : String(error)}`,
            metadata: { selector }
          });
        }
        if (!selectedHtml) {
          return new ToolResult({
            success: true,
            result: "",
            metadata: { length: 0, selector, matches: 0 }
          });
        }
      }
      const text = extractTextFromHtml(selectedHtml);
      return new ToolResult({
        success: true,
        result: text,
        metadata: { length: text.length, ...(selector ? { selector } : {}) }
      });
    }
  }

function selectHtml(html: string, selector: string): string {
  const parsed = parseSimpleSelector(selector);
  const matches: string[] = [];
  const elementPattern = /<([A-Za-z][\w:-]*)(\s[^>]*)?>/gi;
  for (const match of html.matchAll(elementPattern)) {
    const tag = match[1] ?? "";
    const attrs = parseHtmlAttributes(match[2] ?? "");
    if (matchesSimpleSelector(tag, attrs, parsed)) {
      matches.push(extractElementHtml(html, tag, match.index ?? 0, (match.index ?? 0) + match[0].length));
    }
  }
  return matches.join("\n");
}

function extractElementHtml(html: string, tagName: string, startIndex: number, contentStart: number): string {
  const escaped = escapeRegExp(tagName);
  const tagPattern = new RegExp(`<\\/?${escaped}(?:\\s[^>]*)?>`, "gi");
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  for (;;) {
    const match = tagPattern.exec(html);
    if (!match) return html.slice(startIndex);
    if (match[0].startsWith("</")) {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(startIndex, tagPattern.lastIndex);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SimpleSelector {
  tag?: string;
  id?: string;
  className?: string;
}

function parseSimpleSelector(selector: string): SimpleSelector {
  const trimmed = selector.trim();
  if (!trimmed) throw new Error("selector cannot be empty");
  if (/[\s>+~,[\]]/.test(trimmed)) {
    throw new Error("only single tag, id, and class selectors are supported");
  }

  const match = trimmed.match(/^([A-Za-z][\w:-]*)?(?:#([\w:-]+)|\.([\w:-]+))?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error("unsupported selector");
  }
  return {
    tag: match[1]?.toLowerCase(),
    id: match[2],
    className: match[3]
  };
}

function parseHtmlAttributes(attrs: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of attrs.matchAll(attrPattern)) {
    result[(match[1] ?? "").toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function matchesSimpleSelector(tag: string, attrs: Record<string, string>, selector: SimpleSelector): boolean {
  if (selector.tag && tag.toLowerCase() !== selector.tag) return false;
  if (selector.id && attrs.id !== selector.id) return false;
  if (selector.className) {
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (!classes.includes(selector.className)) return false;
  }
  return true;
}

export class ArxivSearchTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.ArxivSearchTool";
  static componentVersion = 1;

  private fetchImpl: typeof fetch;

  constructor(options: ArxivSearchToolOptions = {}) {
    super({
      name: "arxiv_search",
      description: "Search arXiv for academic papers. Returns titles, authors, abstracts, and PDF URLs."
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(_config: Record<string, unknown>): ArxivSearchTool {
    return new ArxivSearchTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. arXiv query syntax is supported."
        },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return (default: 5, max: 20)"
        },
        sort_by: {
          type: "string",
          enum: ["relevance", "lastUpdatedDate", "submittedDate"],
          description: "Sort order for results (default: relevance)"
        }
      },
      required: ["query"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const query = String(parameters.query ?? "");
    const maxResults = clampInteger(parameters.max_results, 1, 20, 5);
    const sortBy = String(parameters.sort_by ?? "relevance");

    try {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", query);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", String(maxResults));
      url.searchParams.set("sortBy", ["relevance", "lastUpdatedDate", "submittedDate"].includes(sortBy) ? sortBy : "relevance");

      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const xml = await response.text();
      const results = parseArxivEntries(xml);

      return new ToolResult({
        success: true,
        result: results,
        metadata: { query, count: results.length }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `arXiv search failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { query }
      });
    }
  }
}

export class YouTubeCaptionTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.YouTubeCaptionTool";
  static componentVersion = 1;

  private fetchImpl: typeof fetch;

  constructor(options: YouTubeCaptionToolOptions = {}) {
    super({
      name: "youtube_caption",
      description:
        "Extract captions/transcripts from YouTube videos when public timed-text captions are available. " +
        "Supports standard YouTube URLs, youtu.be short links, and direct video IDs."
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(_config: Record<string, unknown>): YouTubeCaptionTool {
    return new YouTubeCaptionTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "YouTube video URL, such as https://www.youtube.com/watch?v=VIDEO_ID or https://youtu.be/VIDEO_ID"
        },
        video_id: {
          type: "string",
          description: "YouTube video ID. Used when url is not provided."
        },
        language: {
          type: "string",
          description: "Preferred caption language code. Defaults to en."
        }
      }
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const rawUrl = parameters.url === undefined ? "" : String(parameters.url);
    const videoId = String(parameters.video_id ?? "") || extractYouTubeVideoId(rawUrl);
    const language = String(parameters.language ?? "en");

    if (!videoId) {
      return new ToolResult({
        success: false,
        result: null,
        error: rawUrl ? `Could not extract video ID from URL: ${rawUrl}` : "Provide either url or video_id.",
        metadata: { url: rawUrl }
      });
    }

    try {
      const first = await fetchYouTubeTimedText(this.fetchImpl, videoId, language);
      const xml = first || (language === "en" ? "" : await fetchYouTubeTimedText(this.fetchImpl, videoId, "en"));
      const segments = parseYouTubeCaptionSegments(xml);
      if (!segments.length) {
        return new ToolResult({
          success: false,
          result: null,
          error:
            "No public captions were returned for this video. Captions may be disabled, private, region-restricted, or blocked by YouTube.",
          metadata: { video_id: videoId, url: rawUrl, language }
        });
      }

      const transcript = segments.join(" ").replace(/\s+/g, " ").trim();
      return new ToolResult({
        success: true,
        result: transcript,
        metadata: {
          video_id: videoId,
          url: rawUrl,
          language,
          length: transcript.length,
          segment_count: segments.length
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to extract captions: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { video_id: videoId, url: rawUrl }
      });
    }
  }
}

export function createResearchTools(options: {
  tavilyApiKey?: string;
  googleApiKey?: string;
  googleCseId?: string;
} = {}): BaseTool[] {
  const tools: BaseTool[] = [];
  if (options.googleApiKey && options.googleCseId) {
    tools.push(new GoogleSearchTool({ apiKey: options.googleApiKey, cseId: options.googleCseId }));
  }
  if (options.tavilyApiKey ?? process.env.TAVILY_API_KEY) {
    tools.push(new WebSearchTool({ apiKey: options.tavilyApiKey }));
  }
  tools.push(new WebFetchTool(), new ExtractTextTool(), new ArxivSearchTool(), new YouTubeCaptionTool());
  return tools;
}

registerComponent(WebSearchTool as any);
registerComponent(GoogleSearchTool as any);
registerComponent(WebFetchTool as any);
registerComponent(ExtractTextTool as any);
registerComponent(ArxivSearchTool as any);
registerComponent(YouTubeCaptionTool as any);

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isDomainAllowed(url: string, allowedDomains: string[], blockedDomains: string[]): boolean {
  try {
    const domain = new URL(url).hostname.toLowerCase();
    if (blockedDomains.some((blocked) => domainMatches(domain, blocked))) return false;
    if (allowedDomains.length) {
      return allowedDomains.some((allowed) => domainMatches(domain, allowed));
    }
    return true;
  } catch {
    return false;
  }
}

function domainMatches(domain: string, rule: string): boolean {
  const normalized = rule.toLowerCase();
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

function extractTextFromHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
  );
}

function htmlToSimpleMarkdown(html: string): string {
  return extractTextFromHtml(
    html
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseArxivEntries(xml: string): Array<Record<string, unknown>> {
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)];
  return entries.map((match) => {
    const entry = match[1] ?? "";
    const id = xmlText(entry, "id");
    const pdfUrl =
      matchAttribute(entry, /<link\b(?=[^>]*\btitle=["']pdf["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i) ??
      id.replace("/abs/", "/pdf/");
    return {
      title: xmlText(entry, "title"),
      authors: [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)].map((author) =>
        xmlText(author[1] ?? "", "name")
      ),
      abstract: xmlText(entry, "summary"),
      pdf_url: pdfUrl,
      published: xmlText(entry, "published"),
      arxiv_id: id.split("/").pop() ?? id
    };
  });
}

function xmlText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  if (!match) return "";
  return decodeHtmlEntities(match[1]!.replace(/\s+/g, " ").trim());
}

function matchAttribute(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function extractYouTubeVideoId(value: string): string {
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "youtu.be") return parsed.pathname.replace(/^\/+/, "").slice(0, 11);
    if (["www.youtube.com", "youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v") ?? "";
      if (parsed.pathname.startsWith("/embed/") || parsed.pathname.startsWith("/v/")) {
        return parsed.pathname.split("/")[2] ?? "";
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function fetchYouTubeTimedText(fetchImpl: typeof fetch, videoId: string, language: string): Promise<string> {
  const url = new URL("https://video.google.com/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("lang", language);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.text();
}

function parseYouTubeCaptionSegments(xml: string): string[] {
  if (!xml.trim()) return [];
  return [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => decodeHtmlEntities(match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
