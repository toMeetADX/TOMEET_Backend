import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialCipher, hashSessionToken, sessionTokenMatches } from "./crypto.js";

describe("CredentialCipher", () => {
  it("round trips a credential and authenticates its context", () => {
    const cipher = new CredentialCipher(randomBytes(32).toString("base64"));
    const encrypted = cipher.encrypt("secret-token", "wechat:one");

    expect(encrypted).not.toContain("secret-token");
    expect(cipher.decrypt(encrypted, "wechat:one")).toBe("secret-token");
    expect(() => cipher.decrypt(encrypted, "wechat:two")).toThrow();
  });

  it("compares opaque session tokens by hash", () => {
    const hash = hashSessionToken("one-time-token");
    expect(sessionTokenMatches("one-time-token", hash)).toBe(true);
    expect(sessionTokenMatches("wrong-token", hash)).toBe(false);
  });
});
