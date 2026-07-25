import { describe, expect, it } from "vitest";
import {
  assertActionMatchesMatchingFlag,
  filterSocialHooksByTextEvidence,
  isMultimodalPlaceholderContent,
  isUserTextEvidenceMessage
} from "./agent-policy.js";
import { StoreConflictError } from "@tomeet/data";

describe("agent-policy", () => {
  it("rejects multimodal placeholder content as social-hook evidence", () => {
    expect(isMultimodalPlaceholderContent("[发送了一张图片]")).toBe(true);
    expect(isMultimodalPlaceholderContent("[一次发送了 3 张图片]\n看看风景")).toBe(true);
    expect(isMultimodalPlaceholderContent("[发送了一段录音]")).toBe(true);
    expect(isMultimodalPlaceholderContent("我是贝斯手，上台演过三次")).toBe(false);
    expect(isUserTextEvidenceMessage({ role: "user", content: "[发送了一张图片]" })).toBe(false);
    expect(isUserTextEvidenceMessage({ role: "user", content: "我负责贝斯" })).toBe(true);
  });

  it("filters hooks that cite image placeholders", () => {
    const filtered = filterSocialHooksByTextEvidence(
      [
        {
          hookText: "当过乐队贝斯手",
          evidenceMessageIds: ["img-1", "text-1"]
        },
        {
          hookText: "上台演过三次",
          evidenceMessageIds: ["text-1"]
        }
      ],
      [
        { id: "img-1", role: "user", content: "[发送了一张图片]" },
        { id: "text-1", role: "user", content: "我是贝斯手，上台演过三次" }
      ]
    );
    expect(filtered).toEqual([
      {
        hookText: "上台演过三次",
        evidenceMessageIds: ["text-1"]
      }
    ]);
  });

  it("blocks V1-only actions when the matching flag is off", () => {
    expect(() => assertActionMatchesMatchingFlag({ type: "enable_match_push" }, false))
      .toThrow(StoreConflictError);
    expect(() => assertActionMatchesMatchingFlag({ type: "confirm_room" }, true))
      .toThrow(StoreConflictError);
    expect(() => assertActionMatchesMatchingFlag({ type: "confirm_room" }, false))
      .not.toThrow();
    expect(() => assertActionMatchesMatchingFlag({ type: "start_match", intent: {} }, false))
      .not.toThrow();
    expect(() => assertActionMatchesMatchingFlag({ type: "explain_match_option", optionNumber: 1 }, true))
      .not.toThrow();
  });
});
