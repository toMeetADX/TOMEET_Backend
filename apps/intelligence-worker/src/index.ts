import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SupabaseStore } from "@tomeet/data";
import {
  HostedLlmIntelligence,
  JobProcessor,
  StructuredOutputValidationError,
  TavilyWebSearchProvider
} from "@tomeet/intelligence";
import { config } from "dotenv";
import { createWorkerHealthServer } from "./health-server.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error("Worker 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");

const apiKey = process.env.LLM_API_KEY;
const textModel = process.env.LLM_TEXT_MODEL;
if (!apiKey || !textModel) throw new Error("Worker 必须配置 LLM_API_KEY 和 LLM_TEXT_MODEL，运行时不提供 Mock 模型");
const tavilyApiKey = process.env.TAVILY_API_KEY;
const webSearchProvider = tavilyApiKey
  ? new TavilyWebSearchProvider({
      apiKey: tavilyApiKey,
      baseUrl: process.env.TAVILY_API_BASE_URL
    })
  : undefined;
const adventurexMatchingV1 = process.env.ADVENTUREX_MATCHING_V1 === "true";
const hosted = new HostedLlmIntelligence({
  apiKey,
  baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.siliconflow.cn/v1",
  textModel,
  visionModel: process.env.LLM_VISION_MODEL ?? textModel,
  audioModel: process.env.LLM_AUDIO_MODEL ?? "whisper-1",
  webSearchProvider,
  adventurexMatchingV1,
  simpleReplyFastPath: process.env.LLM_SIMPLE_REPLY_FAST_PATH === "true",
  singlePassEvidenceFinalizer: process.env.LLM_SINGLE_PASS_EVIDENCE_FINALIZER === "true",
  onWebSearchEvent: (event) => console.info(JSON.stringify({ level: "info", event: "web_search", ...event })),
  onLlmRequestEvent: (event) => console.info(JSON.stringify({ level: "info", event: "llm_request", ...event })),
  onReplyFallbackEvent: (event) => console.warn(JSON.stringify({
    level: "warn",
    event: "agent_reply_fallback",
    ...event
  }))
});

const store = new SupabaseStore(supabaseUrl, serviceRoleKey);
const processor = new JobProcessor(store, hosted, hosted, {
  adventurexMatchingV1
});
const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${randomUUID().slice(0, 8)}`;

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

const concurrency = parseIntegerInRange(process.env.WORKER_CONCURRENCY, 8, 1, 32, "WORKER_CONCURRENCY");
const pollInterval = parseIntegerInRange(
  process.env.WORKER_POLL_INTERVAL_MS,
  200,
  100,
  60_000,
  "WORKER_POLL_INTERVAL_MS"
);
const healthPort = parseIntegerInRange(process.env.PORT, 8080, 1, 65_535, "PORT");
const abortController = new AbortController();
const healthServer = createWorkerHealthServer({
  service: "tomeet-intelligence-worker",
  port: healthPort,
  ping: () => store.ping()
});

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function emitJobMetrics(type: string, result: Record<string, unknown>): void {
  if (type === "agent_reply" && result.contextBudget && typeof result.contextBudget === "object") {
    const budget = result.contextBudget as Record<string, unknown>;
    console.info(JSON.stringify({
      level: "info",
      event: "agent_context_assembled",
      totalEstimatedTokens: budget.totalEstimatedTokens,
      recentMessageTokens: budget.recentMessageTokens,
      checkpointTokens: budget.checkpointTokens,
      profileTokens: budget.profileTokens,
      memoryTokens: budget.memoryTokens,
      runtimeTokens: budget.runtimeTokens,
      truncatedSections: budget.truncatedSections,
      usedMemoryCount: result.usedMemoryCount
    }));
  } else if (type === "memory_extract") {
    console.info(JSON.stringify({
      level: "info",
      event: "memory_extraction",
      noOutput: result.noOutput,
      createdOrUpdatedCount: result.createdOrUpdatedCount,
      forgottenCount: result.forgottenCount,
      rejectedSensitiveCount: result.rejectedSensitiveCount
    }));
  } else if (type === "memory_consolidate") {
    console.info(JSON.stringify({
      level: "info",
      event: "memory_consolidation",
      profileVersion: result.profileVersion,
      sourceMemoryCount: result.sourceMemoryCount
    }));
  }
}

async function runSlot(slot: number): Promise<void> {
  const slotId = `${workerId}:${slot}`;
  while (!abortController.signal.aborted) {
    try {
      const job = await store.claimJob(slotId);
      if (!job) {
        await delay(pollInterval);
        continue;
      }
      const claimedAt = Date.now();
      const queueMs = Math.max(0, claimedAt - Date.parse(job.createdAt));
      try {
        const processingStartedAt = Date.now();
        const result = await processor.process(job, { workerId: slotId });
        const processingMs = Date.now() - processingStartedAt;
        const completionStartedAt = Date.now();
        await store.completeJob(job.id, result, slotId);
        const completionMs = Date.now() - completionStartedAt;
        emitJobMetrics(job.type, result);
        console.info(JSON.stringify({
          level: "info",
          event: "job_completed",
          worker: slotId,
          jobId: job.id,
          type: job.type,
          queueMs,
          processingMs,
          completionMs,
          totalMs: Date.now() - Date.parse(job.createdAt)
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.failJob(job.id, message, slotId);
        console.error(JSON.stringify({
          level: "error",
          event: "job_failed",
          worker: slotId,
          jobId: job.id,
          type: job.type,
          error: message,
          ...(error instanceof StructuredOutputValidationError
            ? { errorStage: error.stage, validationIssues: error.issues }
            : {})
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "worker_loop_error", worker: slotId, error: error instanceof Error ? error.message : String(error) }));
      await delay(Math.min(pollInterval * 2, 5000));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    healthServer.setReady(false);
    abortController.abort();
  });
}

await healthServer.listen();
try {
  await store.ping();
  healthServer.setReady(true);
  console.info(JSON.stringify({
    level: "info",
    event: "worker_started",
    workerId,
    concurrency,
    pollInterval,
    model: textModel,
    webSearchEnabled: Boolean(webSearchProvider),
    simpleReplyFastPath: process.env.LLM_SIMPLE_REPLY_FAST_PATH === "true",
    singlePassEvidenceFinalizer: process.env.LLM_SINGLE_PASS_EVIDENCE_FINALIZER === "true"
  }));
  const slots = Array.from(
    { length: concurrency },
    (_, index) => runSlot(index + 1)
  );
  await Promise.all(slots);
} finally {
  healthServer.setReady(false);
  await healthServer.close();
}
