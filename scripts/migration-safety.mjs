#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDirectory, "migration-safety.config.json");
const migrationsDirectory = "supabase/migrations";

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (options.allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export function parseArguments(argv) {
  const [command = "check", ...rest] = argv;
  if (command !== "check") throw new Error(`Unknown command: ${command}`);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (token === "--staged" || token === "--all" || token === "--json") {
      options[token.slice(2)] = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function sha256(content) {
  return createHash("sha256")
    .update(content.replace(/\r\n/gu, "\n"))
    .digest("hex");
}

export function stripSqlCommentsAndStrings(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\r\n]*/gu, " ")
    .replace(/'(?:''|[^'])*'/gu, " ");
}

const destructivePatterns = [
  {
    code: "drop-object",
    expression:
      /\bdrop\s+(?:table|schema|type|view|materialized\s+view|function|procedure|trigger|policy|index)\b/giu
  },
  {
    code: "drop-column-or-constraint",
    expression:
      /\balter\s+table\b[\s\S]{0,800}?\bdrop\s+(?:column|constraint)\b/giu
  },
  {
    code: "alter-column-type",
    expression:
      /\balter\s+table\b[\s\S]{0,800}?\balter\s+column\b[\s\S]{0,300}?\btype\b/giu
  },
  {
    code: "rename-schema-object",
    expression:
      /\balter\s+(?:table|type|view)\b[\s\S]{0,800}?\brename\s+(?:column\s+|to\s+)/giu
  },
  {
    code: "set-not-null",
    expression:
      /\balter\s+table\b[\s\S]{0,800}?\balter\s+column\b[\s\S]{0,300}?\bset\s+not\s+null\b/giu
  },
  {
    code: "truncate",
    expression: /\btruncate(?:\s+table)?\b/giu
  },
  {
    code: "delete-data",
    expression: /\bdelete\s+from\b/giu
  },
  {
    code: "revoke-access",
    expression: /\brevoke\b/giu
  }
];

function statementViolations(sql) {
  const violations = [];
  for (const statement of sql.split(";")) {
    if (
      /\balter\s+table\b/iu.test(statement) &&
      /\badd\s+column\b/iu.test(statement) &&
      /\bnot\s+null\b/iu.test(statement) &&
      !/\bdefault\b/iu.test(statement)
    ) {
      violations.push({
        code: "required-column-without-default",
        excerpt: statement.trim().replace(/\s+/gu, " ").slice(0, 180)
      });
    }
  }
  return violations;
}

export function analyzeMigration(sql) {
  const normalized = stripSqlCommentsAndStrings(sql);
  const violations = statementViolations(normalized);
  for (const { code, expression } of destructivePatterns) {
    expression.lastIndex = 0;
    for (const match of normalized.matchAll(expression)) {
      violations.push({
        code,
        excerpt: normalized
          .slice(Math.max(0, match.index - 40), (match.index ?? 0) + 180)
          .trim()
          .replace(/\s+/gu, " ")
      });
    }
  }
  return violations;
}

async function loadConfig(path = defaultConfigPath) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (
    !config.approvedLegacyMigrations ||
    typeof config.approvedLegacyMigrations !== "object"
  ) {
    throw new Error("approvedLegacyMigrations must be an object");
  }
  return config;
}

function parseChangedMigrations(output) {
  if (!output.trim()) return [];
  return output
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const [status, ...pathParts] = line.split(/\s+/u);
      return { status, path: pathParts.join(" ") };
    })
    .filter(
      ({ path }) =>
        path.startsWith(`${migrationsDirectory}/`) && path.endsWith(".sql")
    );
}

async function migrationCandidates(repoRoot, options) {
  if (options.all) {
    const names = (await readdir(resolve(repoRoot, migrationsDirectory)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    return names.map((name) => ({
      status: "A",
      path: `${migrationsDirectory}/${name}`
    }));
  }

  if (options.staged) {
    return parseChangedMigrations(
      git(
        [
          "diff",
          "--cached",
          "--name-status",
          "--no-renames",
          "--diff-filter=AMD",
          "--",
          migrationsDirectory
        ],
        { cwd: repoRoot }
      )
    );
  }

  const baseRef = options.base ?? "origin/main";
  const headRef = options.head ?? "HEAD";
  return parseChangedMigrations(
    git(
      [
        "diff",
        "--name-status",
        "--no-renames",
        "--diff-filter=AMD",
        baseRef,
        headRef,
        "--",
        migrationsDirectory
      ],
      { cwd: repoRoot }
    )
  );
}

export async function checkMigrations({
  repoRoot,
  options = {},
  configPath = defaultConfigPath
}) {
  const config = await loadConfig(configPath);
  const candidates = await migrationCandidates(repoRoot, options);
  const violations = [];
  const inspected = [];

  for (const candidate of candidates) {
    const name = basename(candidate.path);
    if (candidate.status === "D") {
      violations.push({
        file: candidate.path,
        code: "immutable-migration-deleted",
        excerpt: "Existing migration files are immutable and cannot be deleted"
      });
      continue;
    }
    const content = await readFile(resolve(repoRoot, candidate.path), "utf8");
    const contentHash = sha256(content);
    const approvedHash = config.approvedLegacyMigrations[name];

    if (candidate.status === "M") {
      violations.push({
        file: candidate.path,
        code: "immutable-migration-modified",
        excerpt: "Existing migration files are immutable; add a new migration instead"
      });
      continue;
    }

    if (approvedHash) {
      if (approvedHash !== contentHash) {
        violations.push({
          file: candidate.path,
          code: "legacy-migration-hash-mismatch",
          excerpt: `Expected ${approvedHash}, received ${contentHash}`
        });
      } else {
        inspected.push({ file: candidate.path, legacyApproved: true, contentHash });
      }
      continue;
    }

    if (!/^\d{14}_[a-z0-9_]+\.sql$/u.test(name)) {
      violations.push({
        file: candidate.path,
        code: "invalid-migration-name",
        excerpt:
          "New migrations must be created by Supabase CLI and use YYYYMMDDHHMMSS_name.sql"
      });
    }

    const fileViolations = analyzeMigration(content).map((violation) => ({
      file: candidate.path,
      ...violation
    }));
    violations.push(...fileViolations);
    inspected.push({ file: candidate.path, legacyApproved: false, contentHash });
  }

  return {
    safe: violations.length === 0,
    inspected,
    violations
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = options.repo
    ? resolve(options.repo)
    : git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).trim();
  const result = await checkMigrations({
    repoRoot,
    options,
    configPath: options.config ? resolve(options.config) : defaultConfigPath
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.safe) {
    console.log(`Migration safety passed (${result.inspected.length} files inspected)`);
  } else {
    console.error("Migration safety violations:");
    for (const violation of result.violations) {
      console.error(
        `- ${violation.file}: ${violation.code}: ${violation.excerpt}`
      );
    }
  }
  if (!result.safe) process.exitCode = 1;
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
