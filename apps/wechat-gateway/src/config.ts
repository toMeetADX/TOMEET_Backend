export type WeChatGroupPolicy = "exclude" | "include" | "mentionsOnly";

export interface WeChatGatewayConfig {
  agentWechatUrl: string;
  agentWechatToken?: string;
  groups: WeChatGroupPolicy;
  pollIntervalMs: number;
  sendPacingMs: number;
  tomeetApiUrl: string;
  tomeetInternalApiToken: string;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function groupPolicy(value: string | undefined): WeChatGroupPolicy {
  if (value === undefined || value === "") return "exclude";
  if (value === "exclude" || value === "include" || value === "mentionsOnly") {
    return value;
  }
  throw new Error("WECHAT_GROUPS must be exclude, include, or mentionsOnly");
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
}

function url(value: string | undefined, fallback: string, name: string): string {
  const parsed = new URL(value || fallback);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadWeChatGatewayConfig(
  env: NodeJS.ProcessEnv = process.env
): WeChatGatewayConfig {
  return {
    agentWechatUrl: url(
      env.AGENT_WECHAT_URL,
      "http://localhost:6174",
      "AGENT_WECHAT_URL"
    ),
    agentWechatToken: env.AGENT_WECHAT_TOKEN || undefined,
    groups: groupPolicy(env.WECHAT_GROUPS),
    pollIntervalMs: positiveInteger(
      env.WECHAT_POLL_INTERVAL_MS,
      2000,
      "WECHAT_POLL_INTERVAL_MS"
    ),
    sendPacingMs: positiveInteger(
      env.WECHAT_SEND_PACING_MS,
      800,
      "WECHAT_SEND_PACING_MS"
    ),
    tomeetApiUrl: url(
      env.TOMEET_API_URL,
      "http://localhost:4000",
      "TOMEET_API_URL"
    ),
    tomeetInternalApiToken: requiredSecret(
      env.TOMEET_INTERNAL_API_TOKEN,
      "TOMEET_INTERNAL_API_TOKEN"
    )
  };
}
