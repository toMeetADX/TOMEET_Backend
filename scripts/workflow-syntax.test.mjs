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
    "agent-layer-sync.yml",
    "production-watch.yml"
  ]);
  for (const file of files) {
    const workflow = parse(await readFile(new URL(file, directory), "utf8"));
    assert.ok(workflow.name, `${file} must have a name`);
    assert.ok(workflow.on, `${file} must have triggers`);
    assert.ok(
      workflow.jobs && Object.keys(workflow.jobs).length > 0,
      `${file} must have jobs`
    );
  }
});
