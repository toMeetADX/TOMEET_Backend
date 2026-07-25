#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const SESSION_TOKEN_HEADER = "x-wechat-session-token";
const SENSITIVE_FIELDS = [
  "sessionToken",
  "qrCodeContent",
  "botToken",
  "bot_token",
  "sessionTokenHash",
  "qrTokenCiphertext"
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("SMOKE_WEB_API_URL must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("SMOKE_FRONTEND_ORIGIN must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SMOKE_FRONTEND_ORIGIN must be a pure origin without credentials, path, query, or hash");
  }
  return url.origin;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requireStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned ${response.status}; expected ${expected}`);
  }
}

function requireCors(response, origin, label) {
  if (response.headers.get("access-control-allow-origin") !== origin) {
    throw new Error(`${label} did not allow the configured frontend origin`);
  }
}

function requireNoSensitiveFields(value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const field of SENSITIVE_FIELDS) {
    if (serialized.includes(`"${field}"`)) {
      throw new Error(`${label} leaked sensitive field ${field}`);
    }
  }
}

function requirePublicSession(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} did not return a JSON object`);
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length < 8) {
    throw new Error(`${label} did not return a valid sessionId`);
  }
  const statuses = new Set([
    "pending",
    "scanned",
    "verification_required",
    "active",
    "expired",
    "failed"
  ]);
  if (!statuses.has(value.status)) {
    throw new Error(`${label} returned an unsupported status`);
  }
}

async function readFirstSseEvent(response, timeoutMs) {
  if (!response.body) throw new Error("SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";
  try {
    while (!buffered.includes("\n\n")) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Timed out waiting for the first SSE event");
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the first SSE event")),
          remainingMs
        );
        timer.unref?.();
      });
      try {
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done || !result.value) {
          throw new Error("SSE stream ended before the first event");
        }
        buffered += decoder.decode(result.value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
    return buffered.slice(0, buffered.indexOf("\n\n") + 2);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function runWechatQrSmoke({
  apiBaseUrl,
  frontendOrigin,
  fetchImpl = fetch,
  sseTimeoutMs = 10_000
}) {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const origin = normalizeOrigin(frontendOrigin);
  const requestUrl = (path) => new URL(path, `${baseUrl}/`).toString();

  const ready = await fetchImpl(requestUrl("/ready"), {
    headers: { origin }
  });
  requireStatus(ready, 200, "GET /ready");

  const preflight = await fetchImpl(
    requestUrl("/wechat/connect/sessions/00000000-0000-4000-8000-000000000000"),
    {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": SESSION_TOKEN_HEADER
      }
    }
  );
  requireStatus(preflight, 204, "QR CORS preflight");
  requireCors(preflight, origin, "QR CORS preflight");
  const allowedHeaders = preflight.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  if (!allowedHeaders.includes(SESSION_TOKEN_HEADER)) {
    throw new Error("QR CORS preflight did not allow X-WeChat-Session-Token");
  }

  const createdResponse = await fetchImpl(requestUrl("/wechat/connect/sessions"), {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json"
    },
    body: "{}"
  });
  requireStatus(createdResponse, 201, "POST /wechat/connect/sessions");
  requireCors(createdResponse, origin, "POST /wechat/connect/sessions");
  if (!createdResponse.headers.get("cache-control")?.toLowerCase().includes("no-store")) {
    throw new Error("QR creation response must use Cache-Control: no-store");
  }
  const created = await responseBody(createdResponse);
  requirePublicSession(created, "QR creation");
  if (typeof created.sessionToken !== "string" || created.sessionToken.length < 16) {
    throw new Error("QR creation did not return a one-time sessionToken");
  }
  if (typeof created.qrCodeContent !== "string" || created.qrCodeContent.length < 1) {
    throw new Error("QR creation did not return qrCodeContent");
  }

  const sessionUrl = requestUrl(`/wechat/connect/sessions/${encodeURIComponent(created.sessionId)}`);
  const unauthorized = await fetchImpl(sessionUrl, {
    headers: {
      origin,
      [SESSION_TOKEN_HEADER]: "invalid-smoke-token"
    }
  });
  requireStatus(unauthorized, 401, "QR invalid-token check");

  const statusResponse = await fetchImpl(sessionUrl, {
    headers: {
      origin,
      [SESSION_TOKEN_HEADER]: created.sessionToken
    }
  });
  requireStatus(statusResponse, 200, "QR status");
  requireCors(statusResponse, origin, "QR status");
  const status = await responseBody(statusResponse);
  requirePublicSession(status, "QR status");
  requireNoSensitiveFields(status, "QR status");

  const eventsResponse = await fetchImpl(`${sessionUrl}/events`, {
    headers: {
      accept: "text/event-stream",
      origin,
      [SESSION_TOKEN_HEADER]: created.sessionToken
    }
  });
  requireStatus(eventsResponse, 200, "QR SSE");
  requireCors(eventsResponse, origin, "QR SSE");
  if (!eventsResponse.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("QR SSE did not return text/event-stream");
  }
  const firstEvent = await readFirstSseEvent(eventsResponse, sseTimeoutMs);
  if (!firstEvent.includes("event: session") || !firstEvent.includes('"status"')) {
    throw new Error("QR SSE first chunk did not include the current session event");
  }
  requireNoSensitiveFields(firstEvent, "QR SSE");
  if (firstEvent.includes(created.sessionToken) || firstEvent.includes(created.qrCodeContent)) {
    throw new Error("QR SSE leaked creation-only values");
  }

  return {
    apiBaseUrl: baseUrl,
    frontendOrigin: origin,
    status: status.status
  };
}

async function main() {
  const result = await runWechatQrSmoke({
    apiBaseUrl: requiredEnvironment("SMOKE_WEB_API_URL"),
    frontendOrigin: requiredEnvironment("SMOKE_FRONTEND_ORIGIN")
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    apiBaseUrl: result.apiBaseUrl,
    frontendOrigin: result.frontendOrigin,
    status: result.status
  })}\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
