import { resolve } from "node:path";
import { config } from "dotenv";
import {
  buildAgentContext,
  HostedLlmIntelligence,
  TavilyWebSearchProvider
} from "@tomeet/intelligence";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const apiKey = process.env.LLM_API_KEY;
const textModel = process.env.LLM_TEXT_MODEL;
const tavilyApiKey = process.env.TAVILY_API_KEY;
if (!apiKey || !textModel || !tavilyApiKey) {
  throw new Error("真实联网 smoke 需要 LLM_API_KEY、LLM_TEXT_MODEL 和 TAVILY_API_KEY");
}

const intelligence = new HostedLlmIntelligence({
  apiKey,
  baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.siliconflow.cn/v1",
  textModel,
  visionModel: process.env.LLM_VISION_MODEL ?? textModel,
  audioModel: process.env.LLM_AUDIO_MODEL ?? "whisper-1",
  webSearchProvider: new TavilyWebSearchProvider({
    apiKey: tavilyApiKey,
    baseUrl: process.env.TAVILY_API_BASE_URL
  }),
  timeZone: "Asia/Shanghai"
});

const insight = await intelligence.reply(
  buildAgentContext([], {
    userId: "00000000-0000-4000-8000-000000000001",
    vibeNarrative: "",
    longTermProfile: {},
    currentIntent: {},
    socialHistory: [],
    feedbackMemory: [],
    multimodalUnderstanding: {},
    version: 0,
    updatedAt: new Date().toISOString()
  }),
  "AdventureX 2026 是什么，日期和地点是什么？请联网核实并给出来源。"
);

if (insight.webSearch?.status !== "completed") {
  throw new Error(`联网搜索未完成：${insight.webSearch?.status ?? "missing"}`);
}
if (!/7\s*月\s*22[^\n]*26/u.test(insight.reply) || !insight.reply.includes("杭州")) {
  throw new Error("联网回答未包含 AdventureX 2026 的日期或杭州地点");
}
const hasOfficialSource = insight.webSearch.sources.some((source) => {
  const hostname = new URL(source.url).hostname;
  return hostname === "adventure-x.org" || hostname === "faq.adventure-x.org";
});
if (!hasOfficialSource) throw new Error("联网回答没有引用 AdventureX 官方来源");

console.log(JSON.stringify({
  model: textModel,
  valid: true,
  webSearch: insight.webSearch,
  reply: insight.reply
}, null, 2));
