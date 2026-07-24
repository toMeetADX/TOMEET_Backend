import { createServer, type Server } from "node:http";

export interface WorkerHealthServer {
  listen(): Promise<void>;
  setReady(value: boolean): void;
  close(): Promise<void>;
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message = "readiness dependency timed out"
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function createWorkerHealthServer(options: {
  service: string;
  port: number;
  ping: () => Promise<void>;
  timeoutMs?: number;
}): WorkerHealthServer {
  let ready = false;
  let listening = false;
  const timeoutMs = options.timeoutMs ?? 3000;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url?.split("?", 1)[0];
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (path === "/health") {
        response.writeHead(200);
        response.end(
          JSON.stringify({ status: "ok", service: options.service })
        );
        return;
      }
      if (path === "/ready") {
        if (!ready) {
          response.writeHead(503);
          response.end(
            JSON.stringify({ status: "not_ready", service: options.service })
          );
          return;
        }
        try {
          await withTimeout(options.ping(), timeoutMs);
          response.writeHead(200);
          response.end(
            JSON.stringify({ status: "ready", service: options.service })
          );
        } catch {
          response.writeHead(503);
          response.end(
            JSON.stringify({ status: "not_ready", service: options.service })
          );
        }
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ status: "not_found" }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ status: "error" }));
    });
  });

  return {
    async listen() {
      if (listening) return;
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          listening = true;
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, "0.0.0.0");
      });
    },
    setReady(value) {
      ready = value;
    },
    async close() {
      ready = false;
      if (!listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      });
      listening = false;
    }
  };
}
