import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeMigration,
  checkMigrations,
  parseArguments as parseMigrationArguments,
  stripSqlCommentsAndStrings
} from "./migration-safety.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

test("migration CLI accepts pnpm's argument separator", () => {
  assert.deepEqual(
    parseMigrationArguments([
      "check",
      "--",
      "--base",
      "origin/main",
      "--head",
      "HEAD"
    ]),
    { base: "origin/main", head: "HEAD" }
  );
});

test("migration analyzer allows additive changes", () => {
  const result = analyzeMigration(`
    alter table public.users add column if not exists locale text;
    create index concurrently if not exists users_locale_idx on public.users(locale);
  `);
  assert.deepEqual(result, []);
});

test("migration analyzer blocks destructive and incompatible changes", () => {
  const result = analyzeMigration(`
    alter table public.users drop column display_name;
    alter table public.users add column required_value text not null;
    delete from public.users;
  `);
  assert.ok(result.some(({ code }) => code === "drop-column-or-constraint"));
  assert.ok(
    result.some(({ code }) => code === "required-column-without-default")
  );
  assert.ok(result.some(({ code }) => code === "delete-data"));
});

test("comments and quoted examples do not trigger destructive checks", () => {
  const normalized = stripSqlCommentsAndStrings(`
    -- drop table public.users;
    select 'delete from public.users';
    /* truncate public.users; */
  `);
  assert.deepEqual(analyzeMigration(normalized), []);
});

test("existing migrations are immutable", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "migration-safety-"));
  await mkdir(join(repoRoot, "supabase", "migrations"), { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await writeFile(
    join(repoRoot, "scripts", "config.json"),
    JSON.stringify({ approvedLegacyMigrations: {} })
  );
  const migrationPath = join(
    repoRoot,
    "supabase",
    "migrations",
    "20260724120000_add_locale.sql"
  );
  await writeFile(
    migrationPath,
    "alter table public.users add column locale text;\n"
  );
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Migration Test");
  git(repoRoot, "config", "user.email", "migration@example.invalid");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "migration");
  git(repoRoot, "branch", "base");
  await writeFile(
    migrationPath,
    "alter table public.users add column locale_code text;\n"
  );
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "rewrite migration");

  const result = await checkMigrations({
    repoRoot,
    options: { base: "base", head: "HEAD" },
    configPath: join(repoRoot, "scripts", "config.json")
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.violations.some(
      ({ code }) => code === "immutable-migration-modified"
    )
  );
});

test("existing migrations cannot be deleted", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "migration-safety-delete-"));
  await mkdir(join(repoRoot, "supabase", "migrations"), { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await writeFile(
    join(repoRoot, "scripts", "config.json"),
    JSON.stringify({ approvedLegacyMigrations: {} })
  );
  const migrationPath = join(
    repoRoot,
    "supabase",
    "migrations",
    "20260724130000_add_timezone.sql"
  );
  await writeFile(
    migrationPath,
    "alter table public.users add column timezone text;\n"
  );
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Migration Test");
  git(repoRoot, "config", "user.email", "migration@example.invalid");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "migration");
  git(repoRoot, "branch", "base");
  git(repoRoot, "rm", "supabase/migrations/20260724130000_add_timezone.sql");
  git(repoRoot, "commit", "-m", "delete migration");

  const result = await checkMigrations({
    repoRoot,
    options: { base: "base", head: "HEAD" },
    configPath: join(repoRoot, "scripts", "config.json")
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.violations.some(
      ({ code }) => code === "immutable-migration-deleted"
    )
  );
});

test("an approved migration rename must preserve the exact SQL", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "migration-safety-rename-"));
  await mkdir(join(repoRoot, "supabase", "migrations"), { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  const originalName = "20260726140000_add_claim_recovery.sql";
  const replacementName = "20260726145000_add_claim_recovery.sql";
  await writeFile(
    join(repoRoot, "scripts", "config.json"),
    JSON.stringify({
      approvedLegacyMigrations: {},
      approvedMigrationRenames: {
        [originalName]: replacementName
      }
    })
  );
  await writeFile(
    join(repoRoot, "supabase", "migrations", originalName),
    "alter table public.claims add column recovered_at timestamptz;\n"
  );
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Migration Test");
  git(repoRoot, "config", "user.email", "migration@example.invalid");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "migration");
  git(repoRoot, "branch", "base");
  git(
    repoRoot,
    "mv",
    `supabase/migrations/${originalName}`,
    `supabase/migrations/${replacementName}`
  );
  git(repoRoot, "commit", "-m", "rename migration");

  const result = await checkMigrations({
    repoRoot,
    options: { base: "base", head: "HEAD" },
    configPath: join(repoRoot, "scripts", "config.json")
  });
  assert.equal(result.safe, true);
  assert.equal(
    result.inspected.some(
      ({ renamedTo }) =>
        renamedTo === `supabase/migrations/${replacementName}`
    ),
    true
  );
});

test("an exact documented approval allows an intentional destructive migration", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "migration-safety-approved-"));
  await mkdir(join(repoRoot, "supabase", "migrations"), { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  const migrationName = "20260725180000_merge_duplicate_state.sql";
  const migrationContent = "drop table public.duplicate_state;\n";
  const { createHash } = await import("node:crypto");
  const migrationHash = createHash("sha256").update(migrationContent).digest("hex");
  await writeFile(
    join(repoRoot, "scripts", "config.json"),
    JSON.stringify({
      approvedLegacyMigrations: {},
      approvedDestructiveMigrations: {
        [migrationName]: {
          sha256: migrationHash,
          reason: "Canonical data is backfilled before replacing the duplicate table with a view."
        }
      }
    })
  );
  await writeFile(
    join(repoRoot, "supabase", "migrations", migrationName),
    migrationContent
  );
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Migration Test");
  git(repoRoot, "config", "user.email", "migration@example.invalid");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  git(repoRoot, "branch", "base");
  await writeFile(join(repoRoot, "README.md"), "trigger head commit\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "head");

  const result = await checkMigrations({
    repoRoot,
    options: { all: true },
    configPath: join(repoRoot, "scripts", "config.json")
  });
  assert.equal(result.safe, true);
  assert.equal(result.inspected[0]?.destructiveApproved, true);
});
