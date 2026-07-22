import { z } from "zod";

export const webSearchQuerySchema = z.object({
  query: z.string().trim().min(3).max(200),
  topic: z.enum(["general", "news"]),
  timeRange: z.enum(["day", "week", "month", "year"]).optional()
});

export type WebSearchQuery = z.infer<typeof webSearchQuerySchema>;

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  search(query: WebSearchQuery): Promise<WebSearchResult[]>;
}

export type WebSearchErrorKind = "authentication" | "rate_limit" | "timeout" | "provider" | "invalid_response";

export class WebSearchError extends Error {
  constructor(
    public readonly kind: WebSearchErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

export interface TavilyWebSearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().optional(),
    url: z.string(),
    content: z.string().optional(),
    published_date: z.string().optional()
  }).passthrough()).default([])
}).passthrough();

export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: TavilyWebSearchOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(input: WebSearchQuery): Promise<WebSearchResult[]> {
    const query = webSearchQuerySchema.parse(input);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: query.query,
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
          include_raw_content: false,
          topic: query.topic,
          ...(query.timeRange ? { time_range: query.timeRange } : {})
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new WebSearchError("timeout", "联网搜索超时");
      }
      throw new WebSearchError("provider", "无法连接联网搜索服务");
    }

    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 429 || response.status === 432 || response.status === 433
          ? "rate_limit"
          : "provider";
      throw new WebSearchError(kind, `联网搜索请求失败 (${response.status})`, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WebSearchError("invalid_response", "联网搜索返回了无效 JSON");
    }
    const parsed = tavilyResponseSchema.safeParse(body);
    if (!parsed.success) throw new WebSearchError("invalid_response", "联网搜索返回结构不正确");

    return parsed.data.results.map((result) => ({
      title: result.title?.trim() || result.url,
      url: result.url,
      content: result.content?.trim() ?? "",
      ...(result.published_date ? { publishedAt: result.published_date } : {})
    }));
  }
}

export function prepareWebSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  const prepared: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  let remainingCharacters = 12_000;

  for (const result of results) {
    if (prepared.length >= 8 || remainingCharacters <= 0) break;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(result.url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
    parsedUrl.hash = "";
    const normalizedUrl = parsedUrl.toString();
    if (normalizedUrl.length > 2_000) continue;
    if (seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
    const content = clean(result.content).slice(0, Math.min(2_000, remainingCharacters));
    if (!content) continue;
    remainingCharacters -= content.length;
    prepared.push({
      title: clean(result.title).slice(0, 500) || parsedUrl.hostname,
      url: normalizedUrl,
      content,
      ...(result.publishedAt ? { publishedAt: clean(result.publishedAt).slice(0, 100) } : {})
    });
  }

  return prepared;
}
