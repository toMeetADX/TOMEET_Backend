import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("GitHub Actions workflows are valid YAML with triggers and jobs", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".yml"))
    .sort();
  assert.deepEqual(files, [
    "agent-layer-release.yml",
    "main-validation.yml",
    "production-watch.yml"
  ]);
  for (const file of files) {
    const source = await readFile(new URL(file, directory), "utf8");
    const workflow = parse(source);
    assert.ok(workflow.name, `${file} must have a name`);
    assert.ok(workflow.on, `${file} must have triggers`);
    assert.ok(
      workflow.jobs && Object.keys(workflow.jobs).length > 0,
      `${file} must have jobs`
    );
    if (file === "main-validation.yml") {
      assert.equal(workflow.name, "Main Validation");
      assert.deepEqual(Object.keys(workflow.jobs), ["validate-pr"]);
      assert.deepEqual(Object.keys(workflow.on), ["pull_request"]);
      assert.doesNotMatch(source, /automation\/agent-sync-main-to-wechat/u);
      assert.doesNotMatch(source, /AGENT_SYNC_PR_TOKEN/u);
      assert.doesNotMatch(source, /sync-main-to-wechat/u);
      assert.doesNotMatch(source, /\bpush:/u);
    }
    if (file === "agent-layer-release.yml") {
      assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
      assert.doesNotMatch(source, /^\s*push:/mu);
      assert.doesNotMatch(source, /agent:release:verify/u);
      assert.match(source, /current-release/u);
      assert.match(source, /SMOKE_FRONTEND_ORIGIN/u);
      assert.match(source, /pnpm wechat:smoke:qr/u);
    }
    if (file === "production-watch.yml") {
      assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
      assert.doesNotMatch(source, /^\s*schedule:/mu);
    }
  }
});
