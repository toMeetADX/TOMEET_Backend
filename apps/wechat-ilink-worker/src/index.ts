import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { SupabaseStore, SupabaseWechatStore } from "@tomeet/data";
import {
  CredentialCipher,
  WechatILinkClient,
  type WechatConnection
} from "@tomeet/wechat-ilink";
import { config as loadDotEnv } from "dotenv";
import { TomeetClient } from "./tomeet-client.js";
import { fingerprint, monitorWechatConnection } from "./runtime.js";

loadDotEnv({ path: resolve(process.cwd(), ".env") });
loadDotEnv({ path: resolve(process.cwd(), "../../.env"), override: false });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`WeChat worker 缺少 ${name}`);
  return value;
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}–${maximum} 之间的整数`);
  }
  return value;
}

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
const encryptionKey = requiredEnvironment("WECHAT_CREDENTIAL_ENCRYPTION_KEY");
const tomeetApiUrl = requiredEnvironment("TOMEET_API_URL");
const internalApiToken = requiredEnvironment("TOMEET_INTERNAL_API_TOKEN");
const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${randomUUID().slice(0, 8)}`;
const concurrency = integerEnvironment("WECHAT_WORKER_CONCURRENCY", 8, 1, 32);
const claimIntervalMs = integerEnvironment(
  "WECHAT_WORKER_CLAIM_INTERVAL_MS",
  1000,
  250,
  60_000
);
const healthPort = integerEnvironment("PORT", 8080, 1, 65_535);
const leaseSeconds = 300;
const abortController = new AbortController();
const coreStore = new SupabaseStore(supabaseUrl, serviceRoleKey);
const store = new SupabaseWechatStore(coreStore.client);
const cipher = new CredentialCipher(encryptionKey);
const ilink = new WechatILinkClient();
const tomeet = new TomeetClient({
  baseUrl: tomeetApiUrl,
  internalApiToken
});
const active = new Map<string, Promise<void>>();
let ready = false;

async function monitorConnection(connection: WechatConnection): Promise<void> {
  await monitorWechatConnection({
    connection,
    workerId,
    leaseSeconds,
    signal: abortController.signal,
    store,
    cipher,
    ilink,
    tomeet
  });
}

const healthServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "wechat-ilink-worker" }));
    return;
  }
  if (request.url === "/ready") {
    response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
    return;
  }
  response.writeHead(404).end();
});
healthServer.listen(healthPort, "0.0.0.0");

async function run(): Promise<void> {
  await coreStore.ping();
  ready = true;
  console.info(JSON.stringify({
    level: "info",
    event: "wechat_ilink_worker_started",
    worker: fingerprint(workerId),
    concurrency
  }));
  while (!abortController.signal.aborted) {
    const capacity = concurrency - active.size;
    if (capacity > 0) {
      const claimed = await store.claimWechatConnections({
        workerId,
        limit: capacity,
        leaseSeconds
      });
      for (const connection of claimed) {
        if (active.has(connection.id)) continue;
        const task = monitorConnection(connection).finally(() => active.delete(connection.id));
        active.set(connection.id, task);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, claimIntervalMs));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort());
}

try {
  await run();
} finally {
  ready = false;
  await Promise.allSettled(active.values());
  await new Promise<void>((resolveClose) => healthServer.close(() => resolveClose()));
}
