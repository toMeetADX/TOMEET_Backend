import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareWebSearchResults,
  TavilyWebSearchProvider,
  WebSearchError,
  type WebSearchResult
} from "./web-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tavily web search", () => {
  it("sends the bounded search request and maps results", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        results: [{
          title: "AdventureX 2026",
          url: "https://adventure-x.org/zh",
          content: "杭州，7 月 22 日至 26 日",
          published_date: "2026-05-12"
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const provider = new TavilyWebSearchProvider({
      apiKey: "tvly-test",
      baseUrl: "https://search.example.test"
    });

    const results = await provider.search({
      query: "AdventureX 2026",
      topic: "news",
      timeRange: "year"
    });

    expect(JSON.parse(requestBody)).toMatchObject({
      query: "AdventureX 2026",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      topic: "news",
      time_range: "year"
    });
    expect(results).toEqual([{
      title: "AdventureX 2026",
      url: "https://adventure-x.org/zh",
      content: "杭州，7 月 22 日至 26 日",
      publishedAt: "2026-05-12"
    }]);
  });

  it("classifies provider rate limits without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret provider detail", { status: 429 })));
    const provider = new TavilyWebSearchProvider({ apiKey: "tvly-test" });

    await expect(provider.search({ query: "latest event", topic: "news" }))
      .rejects.toMatchObject({ kind: "rate_limit", status: 429 } satisfies Partial<WebSearchError>);
  });
});

describe("web search evidence preparation", () => {
  it("filters unsafe URLs, deduplicates, caps results and strips control characters", () => {
    const results: WebSearchResult[] = [
      { title: "Unsafe", url: "javascript:alert(1)", content: "bad" },
      { title: "First\u0000 title", url: "https://example.test/page#one", content: "first" },
      { title: "Duplicate", url: "https://example.test/page", content: "duplicate" },
      ...Array.from({ length: 10 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example-${index}.test/path`,
        content: "x".repeat(100)
      }))
    ];

    const prepared = prepareWebSearchResults(results);

    expect(prepared).toHaveLength(8);
    expect(prepared[0]).toMatchObject({
      title: "First  title",
      url: "https://example.test/page",
      content: "first"
    });
    expect(new Set(prepared.map((result) => result.url)).size).toBe(prepared.length);
  });

  it("limits each excerpt and the total evidence size", () => {
    const prepared = prepareWebSearchResults(Array.from({ length: 8 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://long-${index}.test/`,
      content: "x".repeat(4_000)
    })));

    expect(prepared.every((result) => result.content.length <= 2_000)).toBe(true);
    expect(prepared.reduce((sum, result) => sum + result.content.length, 0)).toBeLessThanOrEqual(12_000);
  });
});
