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
          description: "CSS selector support is not available in the dependency-free TS implementation"
        }
      },
      required: ["html"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const html = String(parameters.html ?? "");
    if (parameters.selector) {
      return new ToolResult({
        success: false,
        result: null,
        error: "CSS selector extraction is not available in the dependency-free TypeScript implementation.",
        metadata: { selector: parameters.selector }
      });
    }
    const text = extractTextFromHtml(html);
    return new ToolResult({
      success: true,
      result: text,
      metadata: { length: text.length }
    });
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
  tools.push(new WebFetchTool(), new ExtractTextTool());
  return tools;
}

registerComponent(WebSearchTool as any);
registerComponent(GoogleSearchTool as any);
registerComponent(WebFetchTool as any);
registerComponent(ExtractTextTool as any);

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
