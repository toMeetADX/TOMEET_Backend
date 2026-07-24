import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applySync,
  checkSync,
  verifyRelease
} from "./agent-layer-sync.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function fixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-sync-"));
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Agent Sync Test");
  git(repoRoot, "config", "user.email", "agent-sync@example.invalid");
  await mkdir(join(repoRoot, "packages", "agent-core"), { recursive: true });
  await mkdir(join(repoRoot, "supabase", "migrations"), { recursive: true });
  await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
  await writeFile(join(repoRoot, "packages", "agent-core", "index.ts"), "v1\n");
  await writeFile(
    join(repoRoot, "supabase", "migrations", "20260724000000_base.sql"),
    "create table example(id bigint);\n"
  );
  await writeFile(join(repoRoot, "apps", "web", "page.tsx"), "web-v1\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  git(repoRoot, "branch", "feat/wechat-channel");

  const config = {
    sourceBranch: "main",
    targetBranch: "feat/wechat-channel",
    automationBranch: "automation/agent-sync-main-to-wechat",
    stateFile: ".agent-sync/agent-sync-state.json",
    sharedPaths: ["packages/agent-core", "supabase/migrations"],
    migrationPaths: ["supabase/migrations"]
  };
  return { repoRoot, config };
}

test("check ignores channel-specific paths and detects shared drift", async () => {
  const { repoRoot, config } = await fixture();
  await writeFile(join(repoRoot, "apps", "web", "page.tsx"), "web-v2\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "web only");
  let result = checkSync({
    repoRoot,
    sourceRef: "main",
    targetRef: "feat/wechat-channel",
    config
  });
  assert.equal(result.aligned, true);

  await writeFile(join(repoRoot, "packages", "agent-core", "index.ts"), "v2\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "agent change");
  result = checkSync({
    repoRoot,
    sourceRef: "main",
    targetRef: "feat/wechat-channel",
    config
  });
  assert.equal(result.aligned, false);
  assert.match(result.differences.join("\n"), /packages\/agent-core\/index\.ts/u);
});

test("apply mirrors additions, modifications and deletions and writes state", async () => {
  const { repoRoot, config } = await fixture();
  await writeFile(join(repoRoot, "packages", "agent-core", "index.ts"), "v2\n");
  await writeFile(join(repoRoot, "packages", "agent-core", "new.ts"), "new\n");
  await writeFile(
    join(repoRoot, "supabase", "migrations", "20260724010000_add.sql"),
    "alter table example add column value text;\n"
  );
  git(repoRoot, "rm", "supabase/migrations/20260724000000_base.sql");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "shared change");

  git(
    repoRoot,
    "checkout",
    "-b",
    config.automationBranch,
    "feat/wechat-channel"
  );
  const result = await applySync({ repoRoot, sourceRef: "main", config });
  assert.equal(result.changed, true);
  assert.equal(
    git(repoRoot, "show", ":packages/agent-core/index.ts"),
    "v2"
  );
  assert.equal(
    git(repoRoot, "show", ":packages/agent-core/new.ts"),
    "new"
  );
  assert.throws(() =>
    git(
      repoRoot,
      "show",
      ":supabase/migrations/20260724000000_base.sql"
    )
  );

  git(repoRoot, "commit", "-m", "sync");
  const verified = await verifyRelease({
    repoRoot,
    sourceRef: "main",
    targetRef: "HEAD",
    config
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.agentTreeHash, result.sourceTreeHash);
});

test("apply refuses dirty worktrees and non-automation branches", async () => {
  const { repoRoot, config } = await fixture();
  await writeFile(join(repoRoot, "packages", "agent-core", "index.ts"), "dirty\n");
  await assert.rejects(
    applySync({ repoRoot, sourceRef: "main", config }),
    /worktree is not clean/u
  );

  git(repoRoot, "restore", ".");
  await assert.rejects(
    applySync({ repoRoot, sourceRef: "main", config }),
    /allowed only/u
  );
});
