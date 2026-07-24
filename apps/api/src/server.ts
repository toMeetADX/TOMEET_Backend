import { resolve } from "node:path";
import {
  MemoryStore,
  MemoryWechatStore,
  SupabaseStore,
  SupabaseWechatStore,
  type DataStore
} from "@tomeet/data";
import { HostedLlmIntelligence, JobProcessor, TavilyWebSearchProvider } from "@tomeet/intelligence";
import { CredentialCipher, WechatILinkClient } from "@tomeet/wechat-ilink";
import { buildApp } from "./app.js";
import { createSupabaseAccessTokenVerifier, type AccessTokenVerifier } from "./auth.js";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const demoMode = process.env.DEMO_MODE === "true";
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
if (isProduction && demoMode) throw new Error("生产环境禁止 DEMO_MODE=true");

const frontendOrigin = process.env.FRONTEND_ORIGIN;
if (!demoMode && !frontendOrigin) throw new Error("生产 API 必须配置 FRONTEND_ORIGIN");
for (const rawOrigin of (frontendOrigin ?? "http://localhost:3000").split(",")) {
  const origin = rawOrigin.trim();
  if (!origin) continue;
  const parsed = new URL(origin);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`FRONTEND_ORIGIN 必须是纯 Origin，不能包含路径：${origin}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`FRONTEND_ORIGIN 仅允许 HTTPS 或本机地址：${origin}`);
  }
}

let store: DataStore;
let verifyAccessToken: AccessTokenVerifier | undefined;
let supabaseStore: SupabaseStore | undefined;

if (demoMode) {
  store = new MemoryStore({ seedDemoData: true });
} else {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY；仅本地预览可设置 DEMO_MODE=true");
  supabaseStore = new SupabaseStore(url, key);
  store = supabaseStore;
  verifyAccessToken = createSupabaseAccessTokenVerifier(url, key);
}

const wechatEncryptionKey = process.env.WECHAT_CREDENTIAL_ENCRYPTION_KEY;
const wechat = wechatEncryptionKey
  ? {
      store: demoMode
        ? new MemoryWechatStore(store)
        : new SupabaseWechatStore(supabaseStore!.client),
      client: new WechatILinkClient({
        qrBaseUrl: process.env.WECHAT_ILINK_QR_BASE_URL
      }),
      cipher: new CredentialCipher(wechatEncryptionKey)
    }
  : undefined;

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

const app = await buildApp({
  store,
  inlineProcessor,
  frontendOrigin,
  internalApiToken: process.env.TOMEET_INTERNAL_API_TOKEN,
  autoProvisionChannelUsers:
    demoMode && process.env.WECHAT_AUTO_PROVISION === "true",
  wechat,
  logger: true,
  verifyAccessToken,
  trustProxy: isProduction,
  rateLimitMax: parsePositiveInteger(process.env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
  wechatQrRateLimitMax: parsePositiveInteger(
    process.env.WECHAT_PUBLIC_QR_RATE_LIMIT_MAX,
    30,
    "WECHAT_PUBLIC_QR_RATE_LIMIT_MAX"
  ),
  exposeInternalErrors: !isProduction
});

console.info(JSON.stringify({
  level: "info",
  event: "wechat_connect_runtime",
  enabled: Boolean(wechat)
}));

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

const port = parsePositiveInteger(process.env.PORT, 4000, "PORT");
await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
