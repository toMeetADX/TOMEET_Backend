import { resolve } from "node:path";
import { buildAgentContext, HostedLlmIntelligence, type LlmRequestEvent } from "@tomeet/intelligence";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const apiKey = process.env.LLM_API_KEY;
const textModel = process.env.LLM_TEXT_MODEL;
if (!apiKey || !textModel) throw new Error("缺少 LLM_API_KEY 或 LLM_TEXT_MODEL");

const llmEvents: LlmRequestEvent[] = [];
const intelligence = new HostedLlmIntelligence({
  apiKey,
  baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.siliconflow.cn/v1",
  textModel,
  visionModel: process.env.LLM_VISION_MODEL ?? textModel,
  audioModel: process.env.LLM_AUDIO_MODEL ?? "whisper-1",
  simpleReplyFastPath: process.env.LLM_SIMPLE_REPLY_FAST_PATH === "true",
  singlePassEvidenceFinalizer: process.env.LLM_SINGLE_PASS_EVIDENCE_FINALIZER === "true",
  onLlmRequestEvent: (event) => llmEvents.push(event)
});

const userId = "00000000-0000-4000-8000-000000000001";
const context = buildAgentContext([], {
  userId,
  vibeNarrative: "",
  longTermProfile: {},
  currentIntent: {},
  socialHistory: [],
  feedbackMemory: [],
  multimodalUnderstanding: {},
  version: 0,
  updatedAt: new Date().toISOString()
});

const startedAt = Date.now();
const result = await intelligence.reply(
  context,
  "我最近在做一个机器人项目，主要负责交互设计",
  undefined,
  "00000000-0000-4000-8000-000000000002"
);
const modelPipelineMs = Date.now() - startedAt;

const batchWindowMs = positiveInteger(process.env.WECHAT_TURN_BATCH_WINDOW_MS, 400);
const workerPollMs = positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 200);
const clientPollMs = 200;
const estimatedSchedulingAverageMs = batchWindowMs + Math.round(workerPollMs / 2)
  + Math.round(clientPollMs / 2);

console.log(JSON.stringify({
  model: textModel,
  simpleReplyFastPath: process.env.LLM_SIMPLE_REPLY_FAST_PATH === "true",
  singlePassEvidenceFinalizer: process.env.LLM_SINGLE_PASS_EVIDENCE_FINALIZER === "true",
  modelPipelineMs,
  llmRequests: llmEvents,
  scheduling: {
    batchWindowMs,
    workerPollMaxMs: workerPollMs,
    workerPollAverageMs: Math.round(workerPollMs / 2),
    clientPollMaxMs: clientPollMs,
    clientPollAverageMs: Math.round(clientPollMs / 2),
    estimatedAverageMs: estimatedSchedulingAverageMs
  },
  estimatedBeforeNetworkAndDatabaseMs: modelPipelineMs + estimatedSchedulingAverageMs,
  replyChars: Array.from(result.reply).length,
  actionCount: result.actions.length,
  webSearchStatus: result.webSearch?.status
}, null, 2));
