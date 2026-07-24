import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

async function loadLocalEnvironment() {
  try {
    const source = await readFile(resolve(process.cwd(), ".env"), "utf8");
    for (const line of source.split(/\r?\n/u)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      if (!match || process.env[match[1]]) continue;
      const raw = match[2].trim();
      process.env[match[1]] = raw.replace(/^(['"])(.*)\1$/u, "$2");
    }
  } catch {
    // Environment variables may be supplied directly by Railway or the shell.
  }
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function requireResult(label, operation) {
  const result = await operation;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result;
}

await loadLocalEnvironment();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY；未修改任何数据");
}

const ownerEmail = (argument("owner-email")
  ?? process.env.ADVENTUREX_TEST_POOL_EMAIL
  ?? process.env.WECHAT_RAPID_QR_EMAIL
  ?? "andy4fe0119@gmail.com").trim().toLowerCase();
const desiredUserCount = Number(argument("desired-users") ?? "5");
if (!Number.isInteger(desiredUserCount) || desiredUserCount < 3 || desiredUserCount > 12) {
  throw new Error("--desired-users 必须是 3–12 的整数；未修改任何数据");
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
let ownerUserId = null;
for (let page = 1; page <= 100 && !ownerUserId; page += 1) {
  const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw new Error(`读取 Auth 用户失败: ${error.message}`);
  ownerUserId = data.users.find((user) => user.email?.trim().toLowerCase() === ownerEmail)?.id ?? null;
  if (data.users.length < 1000) break;
}
if (!ownerUserId) throw new Error(`没有找到测试池所有者邮箱 ${ownerEmail}；未修改任何数据`);

const countTable = async (table, configure = (query) => query) => {
  const result = await configure(client.from(table).select("*", { count: "exact", head: true }));
  if (result.error) throw new Error(`统计 ${table} 失败: ${result.error.message}`);
  return result.count ?? 0;
};

const before = {
  messages: await countTable("messages"),
  socialHooks: await countTable("user_social_hooks"),
  messageMemories: await countTable("user_memories", (query) => query.eq("source_type", "message")),
  virtualUsers: await countTable("adventurex_test_pool_users")
};

if (!process.argv.includes("--execute")) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    ownerEmail,
    ownerUserId,
    desiredUserCount,
    before,
    next: "确认范围后追加 --execute 才会删除聊天派生数据并重建隔离测试用户"
  }, null, 2)}\n`);
  process.exit(0);
}

const virtualMappings = await requireResult(
  "读取旧虚拟测试用户",
  client.from("adventurex_test_pool_users").select("user_id")
);
const virtualUserIds = (virtualMappings.data ?? []).map((row) => row.user_id);

await requireResult("删除聊天派生社交钩子", client.from("user_social_hooks").delete().neq("id", ZERO_UUID));
await requireResult(
  "删除消息来源记忆",
  client.from("user_memories").delete().eq("source_type", "message").neq("id", ZERO_UUID)
);
await requireResult("删除聊天消息", client.from("messages").delete().neq("id", ZERO_UUID));
await requireResult(
  "删除对话回复任务历史",
  client.from("llm_jobs").delete().in("job_type", ["agent_reply", "agent_event_reply"])
);
await requireResult(
  "删除消息来源记忆任务",
  client.from("llm_jobs").delete().eq("job_type", "memory_extract").contains("payload", { sourceType: "message" })
);
await requireResult(
  "重置对话摘要",
  client.from("conversations").update({
    rolling_summary: "",
    summarized_message_count: 0,
    updated_at: new Date().toISOString()
  }).neq("id", ZERO_UUID)
);
await requireResult(
  "重置记忆画像缓存",
  client.from("user_memory_profiles").update({
    profile_narrative: "",
    matching_narrative: "",
    source_memory_ids: [],
    source_watermark: null,
    stale: true,
    updated_at: new Date().toISOString()
  }).neq("user_id", ZERO_UUID)
);
await requireResult(
  "重置聊天派生的当前意图与旧 vibe",
  client.from("user_models").update({
    current_intent: {},
    vibe_narrative: "",
    updated_at: new Date().toISOString()
  }).neq("user_id", ZERO_UUID)
);
await requireResult(
  "结束旧的活动匹配请求",
  client.from("match_requests").update({
    status: "cancelled",
    phase: "waiting",
    proactive_push_enabled: false,
    active_round_id: null,
    options_expires_at: null,
    updated_at: new Date().toISOString()
  }).eq("status", "matching")
);
await requireResult(
  "重置 AdventureX 首次引导",
  client.from("adventurex_onboarding_states").update({
    stage: "new",
    image_declined: false,
    welcome_sent_at: null,
    updated_at: new Date().toISOString()
  }).neq("user_id", ZERO_UUID)
);
if (virtualUserIds.length > 0) {
  await requireResult("删除旧隔离虚拟用户", client.from("users").delete().in("id", virtualUserIds));
}
await requireResult(
  "重建所有者隔离测试池",
  client.rpc("configure_adventurex_test_pool", {
    p_owner_user_id: ownerUserId,
    p_enabled: true,
    p_desired_user_count: desiredUserCount
  })
);

const after = {
  messages: await countTable("messages"),
  socialHooks: await countTable("user_social_hooks"),
  messageMemories: await countTable("user_memories", (query) => query.eq("source_type", "message")),
  virtualUsers: await countTable("adventurex_test_pool_users", (query) => query.eq("owner_user_id", ownerUserId))
};
process.stdout.write(`${JSON.stringify({
  mode: "executed",
  ownerEmail,
  ownerUserId,
  desiredUserCount,
  before,
  after
}, null, 2)}\n`);
