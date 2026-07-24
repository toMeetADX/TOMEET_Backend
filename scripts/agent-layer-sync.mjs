#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDirectory, "agent-layer-sync.config.json");

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd,
      encoding: options.encoding ?? "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (options.allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function parseArguments(argv) {
  const [command = "check", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const name = token.slice(2);
    if (name === "json") {
      options.json = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

export async function loadSyncConfig(configPath = defaultConfigPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const requiredArrays = ["sharedPaths", "migrationPaths"];
  for (const field of requiredArrays) {
    if (!Array.isArray(config[field]) || config[field].length === 0) {
      throw new Error(`${field} must be a non-empty array`);
    }
  }
  for (const field of ["sourceBranch", "targetBranch", "automationBranch", "stateFile"]) {
    if (typeof config[field] !== "string" || config[field].trim() === "") {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  return config;
}

export function findRepositoryRoot(cwd = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], { cwd }).trim();
}

export function resolveGitRef(repoRoot, ref) {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (!sha) throw new Error(`Git ref does not exist or is not a commit: ${ref}`);
  return sha.trim();
}

function treeListing(repoRoot, ref, paths) {
  const result = git(
    ["ls-tree", "-r", "-z", "--full-tree", ref, "--", ...paths],
    { cwd: repoRoot, encoding: "buffer" }
  );
  return Buffer.from(result);
}

export function computeTreeHash(repoRoot, ref, paths) {
  resolveGitRef(repoRoot, ref);
  return createHash("sha256").update(treeListing(repoRoot, ref, paths)).digest("hex");
}

export function listDifferences(repoRoot, sourceRef, targetRef, paths) {
  const output = git(
    ["diff", "--name-status", "--no-renames", sourceRef, targetRef, "--", ...paths],
    { cwd: repoRoot }
  ).trim();
  return output ? output.split(/\r?\n/u) : [];
}

function currentBranch(repoRoot) {
  return git(["branch", "--show-current"], { cwd: repoRoot }).trim();
}

function ensureCleanWorktree(repoRoot) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repoRoot
  }).trim();
  if (status) {
    throw new Error("Refusing to apply Agent sync because the Git worktree is not clean");
  }
}

async function readStateAtRef(repoRoot, ref, stateFile) {
  const content = git(["show", `${ref}:${stateFile}`], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${stateFile} at ${ref} is not valid JSON`);
  }
}

function assertStateShape(state, stateFile) {
  for (const field of [
    "sourceCommit",
    "sourceTreeHash",
    "migrationHash",
    "targetBaseCommit"
  ]) {
    if (typeof state?.[field] !== "string" || state[field].trim() === "") {
      throw new Error(`${stateFile} is missing ${field}`);
    }
  }
}

export function checkSync({ repoRoot, sourceRef, targetRef, config }) {
  const sourceCommit = resolveGitRef(repoRoot, sourceRef);
  const targetCommit = resolveGitRef(repoRoot, targetRef);
  const sourceTreeHash = computeTreeHash(
    repoRoot,
    sourceCommit,
    config.sharedPaths
  );
  const targetTreeHash = computeTreeHash(
    repoRoot,
    targetCommit,
    config.sharedPaths
  );
  return {
    aligned: sourceTreeHash === targetTreeHash,
    sourceRef,
    sourceCommit,
    targetRef,
    targetCommit,
    sourceTreeHash,
    targetTreeHash,
    migrationHash: computeTreeHash(
      repoRoot,
      sourceCommit,
      config.migrationPaths
    ),
    differences:
      sourceTreeHash === targetTreeHash
        ? []
        : listDifferences(
            repoRoot,
            sourceCommit,
            targetCommit,
            config.sharedPaths
          )
  };
}

export async function applySync({ repoRoot, sourceRef, config }) {
  ensureCleanWorktree(repoRoot);
  const branch = currentBranch(repoRoot);
  if (branch !== config.automationBranch) {
    throw new Error(
      `Agent sync apply is allowed only on ${config.automationBranch}; current branch is ${branch || "(detached HEAD)"}`
    );
  }

  const sourceCommit = resolveGitRef(repoRoot, sourceRef);
  const targetBaseCommit = resolveGitRef(repoRoot, "HEAD");
  const currentHash = computeTreeHash(
    repoRoot,
    targetBaseCommit,
    config.sharedPaths
  );
  const sourceTreeHash = computeTreeHash(
    repoRoot,
    sourceCommit,
    config.sharedPaths
  );
  if (currentHash === sourceTreeHash) {
    return {
      changed: false,
      sourceCommit,
      sourceTreeHash,
      migrationHash: computeTreeHash(
        repoRoot,
        sourceCommit,
        config.migrationPaths
      ),
      targetBaseCommit
    };
  }

  git(
    [
      "restore",
      "--source",
      sourceCommit,
      "--staged",
      "--worktree",
      "--",
      ...config.sharedPaths
    ],
    { cwd: repoRoot }
  );

  const state = {
    schemaVersion: 1,
    sourceBranch: config.sourceBranch,
    sourceCommit,
    sourceTreeHash,
    migrationHash: computeTreeHash(
      repoRoot,
      sourceCommit,
      config.migrationPaths
    ),
    targetBranch: config.targetBranch,
    targetBaseCommit
  };
  const statePath = resolve(repoRoot, config.stateFile);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  git(["add", "--", config.stateFile], { cwd: repoRoot });

  return {
    changed: true,
    ...state,
    stagedDifferences: git(
      ["diff", "--cached", "--name-status", "--no-renames"],
      { cwd: repoRoot }
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
  };
}

export async function verifyRelease({
  repoRoot,
  sourceRef,
  targetRef,
  config
}) {
  const result = checkSync({ repoRoot, sourceRef, targetRef, config });
  if (!result.aligned) {
    throw new Error(
      `Agent layers are not aligned:\n${result.differences.join("\n")}`
    );
  }

  const state = await readStateAtRef(repoRoot, targetRef, config.stateFile);
  if (!state) {
    throw new Error(
      `${config.stateFile} is missing at ${targetRef}; run agent:sync:apply first`
    );
  }
  assertStateShape(state, config.stateFile);

  if (state.sourceTreeHash !== result.sourceTreeHash) {
    throw new Error("Sync state sourceTreeHash does not match the current Agent tree");
  }
  if (state.migrationHash !== result.migrationHash) {
    throw new Error("Sync state migrationHash does not match the current migrations");
  }
  resolveGitRef(repoRoot, state.sourceCommit);
  const ancestorCheck = git(
    ["merge-base", "--is-ancestor", state.sourceCommit, result.sourceCommit],
    { cwd: repoRoot, allowFailure: true }
  );
  if (ancestorCheck === null) {
    throw new Error(
      `Recorded source commit ${state.sourceCommit} is not an ancestor of ${sourceRef}`
    );
  }

  return {
    verified: true,
    sourceCommit: state.sourceCommit,
    currentSourceCommit: result.sourceCommit,
    targetCommit: result.targetCommit,
    targetBaseCommit: state.targetBaseCommit,
    agentTreeHash: result.sourceTreeHash,
    migrationHash: result.migrationHash
  };
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if ("aligned" in result) {
    console.log(
      result.aligned
        ? `Agent layers aligned: ${result.sourceTreeHash}`
        : `Agent layer drift detected:\n${result.differences.join("\n")}`
    );
    return;
  }
  if ("verified" in result) {
    console.log(
      `Release verified: source=${result.sourceCommit} target=${result.targetCommit} tree=${result.agentTreeHash}`
    );
    return;
  }
  console.log(
    result.changed
      ? `Agent sync staged ${result.stagedDifferences.length} path changes`
      : "Agent layer already aligned; nothing to apply"
  );
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const config = await loadSyncConfig(
    options.config ? resolve(options.config) : defaultConfigPath
  );
  const repoRoot = options.repo
    ? resolve(options.repo)
    : findRepositoryRoot(process.cwd());
  const sourceRef = options.source ?? `origin/${config.sourceBranch}`;
  const targetRef = options.target ?? `origin/${config.targetBranch}`;

  if (command === "check") {
    const result = checkSync({ repoRoot, sourceRef, targetRef, config });
    printResult(result, options.json);
    if (!result.aligned) process.exitCode = 2;
    return;
  }
  if (command === "apply") {
    const result = await applySync({ repoRoot, sourceRef, config });
    printResult(result, options.json);
    return;
  }
  if (command === "verify") {
    const result = await verifyRelease({
      repoRoot,
      sourceRef,
      targetRef,
      config
    });
    printResult(result, options.json);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
