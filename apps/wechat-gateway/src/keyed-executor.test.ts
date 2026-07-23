import { describe, expect, it } from "vitest";
import { KeyedSerialExecutor } from "./keyed-executor.js";

describe("KeyedSerialExecutor", () => {
  it("serializes one sender while allowing different senders to overlap", async () => {
    const executor = new KeyedSerialExecutor();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executor.run("alice", async () => {
      events.push("alice-1-start");
      await firstGate;
      events.push("alice-1-end");
    });
    const second = executor.run("alice", async () => {
      events.push("alice-2");
    });
    const bob = executor.run("bob", async () => {
      events.push("bob");
    });

    await bob;
    expect(events).toEqual(["alice-1-start", "bob"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["alice-1-start", "bob", "alice-1-end", "alice-2"]);
  });
});
