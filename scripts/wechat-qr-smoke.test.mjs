import assert from "node:assert/strict";
import test from "node:test";
import { runWechatQrSmoke } from "./wechat-qr-smoke.mjs";

const origin = "https://app.example.com";
const sessionId = "26000000-0000-4000-8000-000000000001";
const sessionToken = "one-time-session-token-for-tests";

function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin,
      ...headers
    }
  });
}

function successfulFetch() {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/ready") {
      return jsonResponse({ status: "ready" }, 200);
    }
    if (init.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": "content-type, x-wechat-session-token"
        }
      });
    }
    if (url.pathname === "/wechat/connect/sessions" && init.method === "POST") {
      return jsonResponse({
        sessionId,
        status: "pending",
        expiresAt: "2026-07-25T10:00:00.000Z",
        confirmedAt: null,
        errorCode: null,
        errorMessage: null,
        sessionToken,
        qrCodeContent: "weixin://connect/smoke"
      }, 201, { "cache-control": "no-store" });
    }
    if (url.pathname.endsWith("/events")) {
      return new Response(
        `event: session\ndata: ${JSON.stringify({
          sessionId,
          status: "pending",
          expiresAt: "2026-07-25T10:00:00.000Z",
          confirmedAt: null,
          errorCode: null,
          errorMessage: null
        })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "access-control-allow-origin": origin
          }
        }
      );
    }
    const token = init.headers?.["x-wechat-session-token"];
    if (token === "invalid-smoke-token") {
      return jsonResponse({ error: "wechat_session_unauthorized" }, 401);
    }
    return jsonResponse({
      sessionId,
      status: "pending",
      expiresAt: "2026-07-25T10:00:00.000Z",
      confirmedAt: null,
      errorCode: null,
      errorMessage: null
    }, 200);
  };
}

function splitSseFetch() {
  const fetchImpl = successfulFetch();
  return async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/events")) {
      return fetchImpl(input, init);
    }
    const event = `event: session\ndata: ${JSON.stringify({
      sessionId,
      status: "pending",
      expiresAt: "2026-07-25T10:00:00.000Z",
      confirmedAt: null,
      errorCode: null,
      errorMessage: null
    })}\n\n`;
    const chunks = [event.slice(0, 12), event.slice(12)];
    return new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      }
    }), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "access-control-allow-origin": origin
      }
    });
  };
}

test("validates the browser QR contract without logging creation secrets", async () => {
  const result = await runWechatQrSmoke({
    apiBaseUrl: "https://api.example.com/",
    frontendOrigin: origin,
    fetchImpl: successfulFetch()
  });
  assert.deepEqual(result, {
    apiBaseUrl: "https://api.example.com",
    frontendOrigin: origin,
    status: "pending"
  });
});

test("accepts an SSE first event split across network chunks", async () => {
  const result = await runWechatQrSmoke({
    apiBaseUrl: "https://api.example.com",
    frontendOrigin: origin,
    fetchImpl: splitSseFetch()
  });
  assert.equal(result.status, "pending");
});

test("rejects sensitive data in status responses", async () => {
  const fetchImpl = successfulFetch();
  await assert.rejects(
    runWechatQrSmoke({
      apiBaseUrl: "https://api.example.com",
      frontendOrigin: origin,
      fetchImpl: async (input, init) => {
        const response = await fetchImpl(input, init);
        const url = new URL(String(input));
        if (
          url.pathname === `/wechat/connect/sessions/${sessionId}`
          && init?.headers?.["x-wechat-session-token"] === sessionToken
        ) {
          return jsonResponse({
            sessionId,
            status: "pending",
            sessionToken: "leaked"
          }, 200);
        }
        return response;
      }
    }),
    /leaked sensitive field sessionToken/u
  );
});

test("rejects sensitive data in SSE events", async () => {
  const fetchImpl = successfulFetch();
  await assert.rejects(
    runWechatQrSmoke({
      apiBaseUrl: "https://api.example.com",
      frontendOrigin: origin,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/events")) {
          return new Response(
            `event: session\ndata: ${JSON.stringify({
              sessionId,
              status: "pending",
              botToken: "leaked"
            })}\n\n`,
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "access-control-allow-origin": origin
              }
            }
          );
        }
        return fetchImpl(input, init);
      }
    }),
    /leaked sensitive field botToken/u
  );
});

test("requires a pure frontend origin", async () => {
  await assert.rejects(
    runWechatQrSmoke({
      apiBaseUrl: "https://api.example.com",
      frontendOrigin: "https://app.example.com/wechat",
      fetchImpl: successfulFetch()
    }),
    /pure origin/u
  );
});
