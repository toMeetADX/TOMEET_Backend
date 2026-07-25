import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sharedWatchPatterns = [
  "/packages/**",
  "/package.json",
  "/pnpm-lock.yaml",
  "/pnpm-workspace.yaml",
  "/tsconfig.base.json"
];

const configs = [
  {
    file: "railway.api.toml",
    appPattern: "/apps/api/**"
  },
  {
    file: "railway.worker.toml",
    appPattern: "/apps/intelligence-worker/**"
  },
  {
    file: "railway.wechat.toml",
    appPattern: "/apps/wechat-ilink-worker/**"
  },
  {
    file: "railway.relationship.toml",
    appPattern: "/apps/relationship-worker/**"
  }
];

function readStringArray(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "mu"));
  assert.ok(match, `${key} must be configured`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

test("Railway services redeploy for shared workspace changes", async () => {
  for (const config of configs) {
    const source = await readFile(new URL(`../${config.file}`, import.meta.url), "utf8");
    assert.deepEqual(readStringArray(source, "watchPatterns"), [
      config.appPattern,
      ...sharedWatchPatterns,
      `/${config.file}`
    ]);
  }
});
