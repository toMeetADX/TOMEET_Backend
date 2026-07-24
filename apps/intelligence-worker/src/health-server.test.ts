import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkerHealthServer,
  type WorkerHealthServer
} from "./health-server.js";

const servers: WorkerHealthServer[] = [];

function get(port: number, path: string) {
  return new Promise<{ statusCode: number; body: Record<string, unknown> }>(
    (resolveResponse, reject) => {
      const outgoing = request(
        { host: "127.0.0.1", port, path, method: "GET" },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            resolveResponse({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
            });
          });
        }
      );
      outgoing.on("error", reject);
      outgoing.end();
    }
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("intelligence worker health server", () => {
  it("separates liveness from dependency-backed readiness", async () => {
    const port = 18_000 + Math.floor(Math.random() * 10_000);
    let dependencyHealthy = true;
    const server = createWorkerHealthServer({
      service: "test-worker",
      port,
      ping: async () => {
        if (!dependencyHealthy) throw new Error("database unavailable");
      }
    });
    servers.push(server);
    await server.listen();

    expect((await get(port, "/health")).statusCode).toBe(200);
    expect((await get(port, "/ready")).statusCode).toBe(503);

    server.setReady(true);
    expect((await get(port, "/ready")).statusCode).toBe(200);

    dependencyHealthy = false;
    expect((await get(port, "/ready")).statusCode).toBe(503);
  });
});
