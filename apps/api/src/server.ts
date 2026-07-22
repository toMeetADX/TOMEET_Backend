import { resolve } from "node:path";
import { MemoryStore, SupabaseStore, type DataStore } from "@tomeet/data";
import { HostedLlmIntelligence, JobProcessor, TavilyWebSearchProvider } from "@tomeet/intelligence";
import { buildApp } from "./app.js";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const demoMode = process.env.DEMO_MODE === "true";
let store: DataStore;

if (demoMode) {
  store = new MemoryStore({ seedDemoData: true });
} else {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY；仅本地预览可设置 DEMO_MODE=true");
  store = new SupabaseStore(url, key);
}

let inlineProcessor: JobProcessor | undefined;
if (demoMode) {
  const apiKey = process.env.LLM_API_KEY;
  const textModel = process.env.LLM_TEXT_MODEL;
  if (!apiKey || !textModel) throw new Error("本地预览也必须配置 LLM_API_KEY 和 LLM_TEXT_MODEL，运行时不提供 Mock 模型");
  const webSearchProvider = process.env.TAVILY_API_KEY
    ? new TavilyWebSearchProvider({
        apiKey: process.env.TAVILY_API_KEY,
        baseUrl: process.env.TAVILY_API_BASE_URL
      })
    : undefined;
  const hosted = new HostedLlmIntelligence({
    apiKey,
    baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.siliconflow.cn/v1",
    textModel,
    visionModel: process.env.LLM_VISION_MODEL ?? textModel,
    audioModel: process.env.LLM_AUDIO_MODEL ?? "whisper-1",
    webSearchProvider,
    onWebSearchEvent: (event) => console.info(JSON.stringify({ level: "info", event: "web_search", ...event }))
  });
  inlineProcessor = new JobProcessor(store, hosted, hosted);
}

const app = buildApp({
  store,
  inlineProcessor,
  frontendOrigin: process.env.FRONTEND_ORIGIN,
  logger: true
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
