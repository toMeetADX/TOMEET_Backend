#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function apiUrl(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url} returned ${response.status}: ${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body)}`
    );
  }
  return body;
}

async function createAnonymousSession(supabaseUrl, publishableKey) {
  const client = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user || !data.session?.access_token) {
    throw new Error("Supabase anonymous sign-in did not return a user and session");
  }
  return {
    userId: data.user.id,
    accessToken: data.session.access_token
  };
}

async function waitForJob({ apiBaseUrl, jobId, headers, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await requestJson(apiUrl(apiBaseUrl, `/internal/jobs/${jobId}`), {
      headers
    });
    const job = response?.job;
    if (job?.status === "completed") return job;
    if (job?.status === "failed") {
      throw new Error(`Agent job ${jobId} failed: ${job.error ?? "unknown error"}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
  }
  throw new Error(`Timed out waiting for Agent job ${jobId}`);
}

async function deleteSmokeUsers(adminClient, userIds) {
  const failures = [];
  for (const userId of userIds) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`Failed to clean up smoke users: ${failures.join("; ")}`);
  }
}

async function main() {
  const supabaseUrl = requiredEnvironment("SMOKE_SUPABASE_URL");
  const publishableKey = requiredEnvironment("SMOKE_SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = requiredEnvironment("SMOKE_SUPABASE_SERVICE_ROLE_KEY");
  const webApiUrl = requiredEnvironment("SMOKE_WEB_API_URL");
  const wechatApiUrl = requiredEnvironment("SMOKE_WECHAT_API_URL");
  const internalApiToken = requiredEnvironment("SMOKE_INTERNAL_API_TOKEN");
  const timeoutSeconds = Number(process.env.SMOKE_JOB_TIMEOUT_SECONDS ?? "240");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30) {
    throw new Error("SMOKE_JOB_TIMEOUT_SECONDS must be an integer of at least 30");
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
  const createdUserIds = [];
  let completed = false;

  try {
    const [webSession, wechatSession] = await Promise.all([
      createAnonymousSession(supabaseUrl, publishableKey),
      createAnonymousSession(supabaseUrl, publishableKey)
    ]);
    createdUserIds.push(webSession.userId, wechatSession.userId);
    if (webSession.userId === wechatSession.userId) {
      throw new Error("Web and WeChat smoke users unexpectedly share one user_id");
    }

    const runId = process.env.SMOKE_RUN_ID ?? randomUUID();
    const externalUserId = `smoke-wechat-${runId}`.slice(0, 255);
    const internalHeaders = {
      "x-tomeet-internal-token": internalApiToken
    };

    const linked = await requestJson(
      apiUrl(wechatApiUrl, "/internal/channel-identities"),
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          provider: "wechat",
          externalUserId,
          userId: wechatSession.userId,
          displayName: "Release smoke WeChat"
        })
      }
    );
    if (linked?.identity?.userId !== wechatSession.userId) {
      throw new Error("WeChat identity was not linked to the expected user_id");
    }

    const resolvedThroughWeb = await requestJson(
      apiUrl(webApiUrl, "/internal/channel-identities/resolve"),
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ provider: "wechat", externalUserId })
      }
    );
    if (resolvedThroughWeb?.identity?.userId !== wechatSession.userId) {
      throw new Error("Web API and WeChat API are not reading the same identity data");
    }

    const webSubmission = await requestJson(apiUrl(webApiUrl, "/agent/messages"), {
      method: "POST",
      headers: { authorization: `Bearer ${webSession.accessToken}` },
      body: JSON.stringify({
        userId: webSession.userId,
        displayName: "Release smoke Web",
        content: "发布健康检查：请简短回复“web smoke ok”。",
        idempotencyKey: `release-web-${runId}`.slice(0, 128)
      })
    });
    const wechatPayload = {
      userId: wechatSession.userId,
      displayName: "Release smoke WeChat",
      content: "发布健康检查：请简短回复“wechat smoke ok”。",
      idempotencyKey: `release-wechat-${runId}`.slice(0, 128)
    };
    const wechatSubmission = await requestJson(
      apiUrl(wechatApiUrl, "/internal/agent/messages"),
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify(wechatPayload)
      }
    );

    const webJobId = webSubmission?.job?.id;
    const wechatJobId = wechatSubmission?.job?.id;
    if (!webJobId || !wechatJobId) {
      throw new Error("Agent message submission did not return both job IDs");
    }

    await Promise.all([
      waitForJob({
        apiBaseUrl: webApiUrl,
        jobId: webJobId,
        headers: internalHeaders,
        timeoutSeconds
      }),
      waitForJob({
        apiBaseUrl: wechatApiUrl,
        jobId: wechatJobId,
        headers: internalHeaders,
        timeoutSeconds
      })
    ]);

    const repeatedWechat = await requestJson(
      apiUrl(wechatApiUrl, "/internal/agent/messages"),
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify(wechatPayload)
      }
    );
    if (
      repeatedWechat?.userMessage?.id !== wechatSubmission?.userMessage?.id ||
      repeatedWechat?.job?.id !== wechatSubmission?.job?.id
    ) {
      throw new Error("WeChat Agent message idempotency check failed");
    }

    const [webHistory, wechatHistoryViaWeb, webModel, wechatModel] =
      await Promise.all([
        requestJson(apiUrl(webApiUrl, `/agent/messages/${webSession.userId}`), {
          headers: { authorization: `Bearer ${webSession.accessToken}` }
        }),
        requestJson(
          apiUrl(webApiUrl, `/internal/agent/messages/${wechatSession.userId}`),
          { headers: internalHeaders }
        ),
        requestJson(apiUrl(webApiUrl, `/users/${webSession.userId}/model`), {
          headers: { authorization: `Bearer ${webSession.accessToken}` }
        }),
        requestJson(apiUrl(wechatApiUrl, `/users/${wechatSession.userId}/model`), {
          headers: { authorization: `Bearer ${wechatSession.accessToken}` }
        })
      ]);

    if (
      !webHistory?.messages?.some((message) => message.role === "assistant") ||
      !wechatHistoryViaWeb?.messages?.some(
        (message) => message.role === "assistant"
      )
    ) {
      throw new Error("Cross-channel assistant messages were not persisted");
    }
    if (
      webModel?.userModel?.userId !== webSession.userId ||
      wechatModel?.userModel?.userId !== wechatSession.userId
    ) {
      throw new Error("Cross-channel user models are missing or incorrectly matched");
    }

    completed = true;
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        webUserId: webSession.userId,
        wechatUserId: wechatSession.userId,
        webJobId,
        wechatJobId,
        sharedDatabaseVerified: true,
        identitiesRemainDistinct: true,
        idempotencyVerified: true
      })}\n`
    );
  } finally {
    try {
      await deleteSmokeUsers(adminClient, createdUserIds);
    } catch (error) {
      if (completed) throw error;
      console.error(
        `Smoke cleanup warning: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
