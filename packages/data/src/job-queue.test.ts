import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memory-store.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("interactive job queue latency", () => {
  it("does not let an older retry in future backoff block a ready job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const store = new MemoryStore();
    const older = await store.enqueueJob({
      type: "agent_reply",
      payload: {},
      idempotencyKey: "older-job",
      partitionKey: "user:u1"
    });
    const claimedOlder = await store.claimJob("worker-1");
    expect(claimedOlder?.id).toBe(older.id);
    await store.failJob(older.id, "temporary", "worker-1");

    vi.advanceTimersByTime(1);
    const newer = await store.enqueueJob({
      type: "agent_reply",
      payload: {},
      idempotencyKey: "newer-job",
      partitionKey: "user:u1"
    });

    const claimedNewer = await store.claimJob("worker-2");
    expect(claimedNewer?.id).toBe(newer.id);
    expect((await store.getJob(older.id))?.status).toBe("retry");
  });
});
