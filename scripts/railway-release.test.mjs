import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  normalizeDeployments,
  probeHealth
} from "./railway-release.mjs";

test("normalizes Railway array and GraphQL edge payloads", () => {
  assert.deepEqual(
    normalizeDeployments([{ id: "one", status: "success" }]).map(
      ({ id, status }) => ({ id, status })
    ),
    [{ id: "one", status: "SUCCESS" }]
  );
  assert.deepEqual(
    normalizeDeployments({
      deployments: {
        edges: [{ node: { deploymentId: "two", state: "crashed" } }]
      }
    }).map(({ id, status }) => ({ id, status })),
    [{ id: "two", status: "CRASHED" }]
  );
});

test("health probe requires consecutive successes", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(requests <= 2 ? 503 : 200).end();
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  const address = server.address();
  try {
    const result = await probeHealth({
      url: `http://127.0.0.1:${address.port}/ready`,
      successes: 2,
      intervalSeconds: 0.01,
      timeoutSeconds: 1
    });
    assert.equal(result.successes, 2);
    assert.equal(requests, 4);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
