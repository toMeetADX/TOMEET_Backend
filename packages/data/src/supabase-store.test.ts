import { describe, expect, it, vi } from "vitest";
import { SupabaseStore } from "./supabase-store.js";

describe("SupabaseStore timestamp mapping", () => {
  it("normalizes PostgreSQL offset timestamps before contract validation", async () => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    Object.defineProperty(store, "client", {
      value: {
        rpc: vi.fn().mockResolvedValue({
          data: {
            id: "f86efec3-a247-47f9-9f20-fdcac7856f67",
            user_id: "cc998b7e-1c59-45d6-b0eb-09ffb6230e96",
            role: "user",
            content: "hello",
            created_at: "2026-07-24T09:52:32.91018+00:00"
          },
          error: null
        })
      }
    });

    const message = await store.appendMessage({
      userId: "cc998b7e-1c59-45d6-b0eb-09ffb6230e96",
      role: "user",
      content: "hello"
    });

    expect(message.createdAt).toBe("2026-07-24T09:52:32.910Z");
  });
});
