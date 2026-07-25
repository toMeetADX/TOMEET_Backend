import { createServer, type Server } from "node:http";

export interface WorkerHealthServer {
  listen(): Promise<void>;
  setReady(value: boolean): void;
  close(): Promise<void>;
}

export function createWorkerHealthServer(options: {
  service: string;
  port: number;
  ping: () => Promise<void>;
}): WorkerHealthServer {
  let ready = false;
  let listening = false;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url?.split("?", 1)[0];
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (path === "/health") {
        response.writeHead(200);
        response.end(JSON.stringify({ status: "ok", service: options.service }));
        return;
      }
      if (path === "/ready") {
        if (!ready) {
          response.writeHead(503);
          response.end(JSON.stringify({ status: "not_ready", service: options.service }));
          return;
        }
        try {
          await options.ping();
          response.writeHead(200);
          response.end(JSON.stringify({ status: "ready", service: options.service }));
        } catch {
          response.writeHead(503);
          response.end(JSON.stringify({ status: "not_ready", service: options.service }));
        }
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ status: "not_found" }));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ status: "error" }));
    });
  });

  return {
    async listen() {
      if (listening) return;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "0.0.0.0", () => {
          server.off("error", reject);
          listening = true;
          resolve();
        });
      });
    },
    setReady(value) {
      ready = value;
    },
    async close() {
      ready = false;
      if (!listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      listening = false;
    }
  };
}
