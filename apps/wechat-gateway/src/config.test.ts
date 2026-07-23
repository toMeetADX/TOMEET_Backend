import { describe, expect, it } from "vitest";
import { loadWeChatGatewayConfig } from "./config.js";

describe("loadWeChatGatewayConfig", () => {
  it("uses safe direct-message defaults", () => {
    const config = loadWeChatGatewayConfig({
      TOMEET_INTERNAL_API_TOKEN: "x".repeat(32)
    });
    expect(config.groups).toBe("exclude");
    expect(config.agentWechatUrl).toBe("http://localhost:6174");
    expect(config.tomeetApiUrl).toBe("http://localhost:4000");
  });

  it("rejects missing internal service authentication", () => {
    expect(() => loadWeChatGatewayConfig({})).toThrow(
      "TOMEET_INTERNAL_API_TOKEN"
    );
  });
});
