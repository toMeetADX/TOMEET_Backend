# Phase 1 QA baseline

> Audit date: 2026-07-23
>
> Branch: `feat/addBaseline`
>
> Baseline commit: `1c0d333`
>
> Scope: repository audit, build baseline repair, and one local quality gate only. This phase does not migrate Fastify, add Route Handlers, change database SQL, or add new business tests.

## Executive summary

The repository is a 13-workspace pnpm monorepo: three applications, nine domain/data packages, and the root workspace. Before this phase, the active Windows shell used Node.js 20, pnpm had no working global shim, API tests referenced two undeclared workspace packages, and the Web scripts used POSIX environment-variable syntax. Those issues prevented the repository's existing tests and build from forming a green, cross-platform baseline.

Phase 1 pins the development/CI major to Node.js 22, documents Corepack and pnpm 10.14.0, declares the missing test dependencies, standardizes Next.js on `.next`, and adds a root ESLint 9 flat configuration. `pnpm check` is now the single ordered gate: lint, typecheck, test, then build.

The green baseline contains 18 tests. It does **not** prove that Supabase Auth, RLS, Storage, Realtime, deployment, or browser journeys work. The four PGlite tests only exercise migration and RPC SQL as an embedded PostgreSQL smoke test.

## Repository tree (three levels)

```text
TOMEET_Backend/
├── apps/
│   ├── api/
│   │   ├── src/app.ts
│   │   ├── src/app.test.ts
│   │   └── src/server.ts
│   ├── intelligence-worker/
│   │   ├── src/index.ts
│   │   └── src/smoke.ts
│   └── web/
│       ├── app/layout.tsx
│       ├── app/page.tsx
│       └── next.config.ts
├── packages/
│   ├── agent-core/src/
│   ├── contracts/src/
│   ├── data/src/
│   ├── feedback/src/
│   ├── game-catalog/src/
│   ├── intelligence/src/
│   ├── matchmaking/src/
│   ├── room/src/
│   └── user-model/src/
├── supabase/
│   ├── migrations/
│   ├── config.toml
│   └── seed.sql
├── tests/
│   └── load/k6-api.js
├── docs/
│   ├── api.md
│   ├── architecture.md
│   └── product-flow.md
├── railway.api.toml
├── railway.worker.toml
├── pnpm-workspace.yaml
└── package.json
```

Generated directories such as `node_modules`, `.next`, `.next-dev`, and `.next-build` are intentionally omitted.

## Current architecture

| Surface | Current implementation | Runtime/deployment |
| --- | --- | --- |
| API | Fastify 5 in `apps/api`; CORS, Helmet, rate limiting, Zod contracts | Railway API, health check at `/health` |
| Intelligence | `HostedLlmIntelligence` plus a polling `JobProcessor` | Separate Railway worker |
| Web | Next.js 15 App Router page used as the current local client/test console | Documented for Vercel; no Route Handlers yet |
| Data | `DataStore` with in-memory and Supabase implementations | Supabase JS client; server processes use the service-role key |
| Database | Three SQL migrations, seed data, tables, constraints, triggers, and RPCs | Supabase PostgreSQL |
| Files/realtime | API upload metadata and intended Supabase Storage/Realtime usage | No real Storage or Realtime integration test exists |
| Load | One k6 script at `tests/load/k6-api.js` | No root script or CI job currently invokes it |

There are no Go services in the tracked tree. The Fastify API and independent worker remain transitional architecture; Phase 1 neither expands nor removes them.

### Workspace dependency inventory

| Workspace | Direct internal dependencies |
| --- | --- |
| `@tomeet/api` | contracts, data, intelligence; test-only agent-core and matchmaking |
| `@tomeet/intelligence-worker` | contracts, data, intelligence |
| `@tomeet/web` | none |
| `@tomeet/agent-core` | contracts, user-model |
| `@tomeet/contracts` | none |
| `@tomeet/data` | contracts, game-catalog, matchmaking, user-model |
| `@tomeet/feedback` | contracts, user-model |
| `@tomeet/game-catalog` | contracts |
| `@tomeet/intelligence` | agent-core, contracts, data, feedback, matchmaking, user-model |
| `@tomeet/matchmaking` | contracts, game-catalog |
| `@tomeet/room` | contracts |
| `@tomeet/user-model` | contracts |

### HTTP route inventory

All current routes are Fastify routes in `apps/api/src/app.ts` and have no `/api` prefix:

| Method | Route |
| --- | --- |
| GET | `/health` |
| GET | `/ready` |
| POST | `/agent/messages` |
| GET | `/agent/messages/:userId` |
| POST | `/agent/multimodal-inputs` |
| POST | `/uploads/sign` |
| POST | `/uploads` |
| GET | `/users/:userId/model` |
| GET | `/offline-games` |
| POST | `/match-requests` |
| GET | `/match-requests/:id` |
| POST | `/match-requests/:id/cancel` |
| GET | `/jobs/:id` |
| GET | `/rooms/:id` |
| POST | `/rooms/:id/confirm` |
| POST | `/rooms/:id/complete` |
| POST | `/rooms/:id/feedback` |

### LLM provider inventory

`packages/intelligence/src/hosted-llm.ts` implements an OpenAI-compatible HTTP boundary for chat completions and audio transcription. Runtime configuration uses `LLM_API_BASE_URL`, `LLM_API_KEY`, and separate text, vision, and audio model names. The documented default provider is SiliconFlow with Qwen/SenseVoice models. The API can process jobs inline only in demo mode; the normal hosted path uses the independent worker.

The current automated suite does not call a live provider. A formal scenario-driven Fake LLM abstraction is still a Phase 2 gap.

## Test baseline

### Existing test files after dependency repair

| File | Tests | What it currently covers |
| --- | ---: | --- |
| `packages/agent-core/src/index.test.ts` | 2 | Explicit social intent and message summarization/feedback |
| `packages/user-model/src/index.test.ts` | 3 | Profile merge, intent replacement, multimodal/feedback model updates |
| `packages/matchmaking/src/index.test.ts` | 1 | Duplicate member rejection |
| `packages/intelligence/src/hosted-llm.test.ts` | 1 | Hosted matchmaking request context and structured response boundary |
| `packages/data/src/migration.test.ts` | 4 | PGlite migration/RPC/lifecycle smoke |
| `apps/api/src/app.test.ts` | 7 | In-memory Fastify happy paths, ownership rejection, deduplication, cancellation, job claiming |
| **Total** | **18** | All execute in the repaired baseline |

Vitest is the only unit/integration test runner. There is no React Testing Library setup, Playwright project, browser E2E test, coverage gate, or GitHub Actions workflow.

### Observed pre-fix command state

These results were captured before changing the affected files; they are not reconstructed from the final state.

| Check | Observed result | Duration |
| --- | --- | ---: |
| Toolchain preflight | Active Node `20.18.3` did not meet `engines.node >=22`; pnpm had no usable Windows shim | <1 s |
| `pnpm typecheck` | Failed in `apps/api`: test imports for `@tomeet/agent-core` and `@tomeet/matchmaking` could not resolve | Not retained |
| `pnpm test` | 11 package tests passed; the 7 API tests did not execute because the same imports could not resolve | Not retained |
| `pnpm --filter @tomeet/web build` | Failed on Windows because `NEXT_DIST_DIR=...` was parsed as a command | <1 s |
| Equivalent direct `next build` | Passed, proving the Web source itself could produce a production build | Not retained |
| Root quality gate | `pnpm check` did not include lint, and no repository ESLint configuration existed | N/A |
| Supabase preflight | Supabase CLI absent; Docker CLI present but daemon unavailable | <1 s |

“Not retained” means the command was genuinely run but its wall-clock value was not captured during the initial failure audit; no duration is invented.

### Repaired quality gate

The final verification uses Node.js `22.23.1` and pnpm `10.14.0` on Windows. Final command results are recorded here after the complete verification pass:

| Command | Result | Duration | Notes |
| --- | --- | ---: | --- |
| `pnpm install --frozen-lockfile` | Passed | 1.056 s | Lockfile current; all 13 workspace projects discovered |
| `pnpm lint` | Passed | 5.426 s | ESLint 9 flat config, zero warnings |
| `pnpm typecheck` | Passed | 16.935 s | All 12 child workspaces passed |
| `pnpm test` | Passed | 10.908 s | 18/18 tests executed and passed |
| `pnpm build` | Passed | 30.404 s | All workspace build scripts passed |
| `pnpm check` | Passed | 64.177 s | Verified `lint -> typecheck -> test -> build` in one command |
| `pnpm --filter @tomeet/web build` | Passed | 16.766 s | Explicit Windows standard-script check; 105 kB first-load JS |

No test discovered by Vitest was skipped: 18 passed and 0 failed. Six workspaces currently have no test files (the Web workspace uses an explicit echo-only test script; the other five use `--passWithNoTests`). Coverage collection is not configured, so this baseline does not claim a coverage percentage. pnpm emitted a non-blocking warning that dependency build scripts for `esbuild`, `sharp`, and `unrs-resolver` were not allowlisted; all typecheck, test, and production-build commands still passed from the frozen install.

## Supabase test boundary and security audit

`packages/data/src/migration.test.ts` pre-creates minimal Supabase roles and a Storage bucket table, removes the unsupported `pgcrypto` extension statement, and then loads the migration SQL into PGlite. This is useful for catching SQL syntax, table presence, selected constraints, and a small set of RPC lifecycle regressions. It is **not** a local Supabase stack and must not be reported as one.

Specifically, the current suite does not validate:

- Supabase Auth identities, JWT claims, cookies, or `auth.uid()`;
- role-specific grants and negative access as `anon` or `authenticated`;
- RLS policies against real PostgREST requests;
- Storage buckets, MIME/size enforcement, or object ownership;
- Realtime channel authorization, delivery, reconnection, or payload handling;
- Supabase service configuration and extension parity.

The migrations define multiple public `SECURITY DEFINER` functions. Current SQL revokes execution from `public`, `anon`, and `authenticated` and grants selected functions to `service_role`. That is a useful defensive baseline, but Phase 4 must verify the effective privileges and negative cases in a real local Supabase stack. SQL is deliberately unchanged in this PR.

When direct browser Data API or Realtime access is introduced, table grants and RLS must be explicit rather than assuming new tables are exposed automatically. Phase 4 should follow the [Supabase testing overview](https://supabase.com/docs/guides/local-development/testing/overview) and include RPC, RLS, and denial-path tests.

## P0 test gaps

The identifiers below come from the project QA brief. “Gap” means Phase 1 did not add or pretend to run the test.

| Area | Current partial evidence | P0 gaps to implement |
| --- | --- | --- |
| `AGENT-001..005` | Explicit social intent, summary, multimodal API happy path | Question-count rules, invalid structured output, unauthorized model actions |
| `INTENT-001..005` | Explicit intent and in-memory active-request deduplication/cancellation | Negative intent cases, immutable snapshot checks, database-level 10-way concurrency |
| `MATCH-001..009` | Duplicate member unit test; one API happy flow | 2/3/10/11 boundaries, candidate-set/trigger-user validation, overlapping matches, source-job idempotency |
| `GAME-001..005` | Catalog code and seeded data exist | Unique top-three, unknown/disabled games, room-size constraints, fewer-than-three behavior |
| `ROOM-001..007` | PGlite/API lifecycle smoke | Identity authorization, idempotent and concurrent confirm, illegal transitions, private read denial |
| `FEEDBACK-001..005` | API/PGlite happy lifecycle | Non-member denial, idempotent resubmission, raw feedback persistence when LLM processing fails |
| `MEDIA-001..005` | Image happy path and cross-user path rejection | Audio, forged MIME, size limit, real Storage ownership/RLS |
| `RT-001..005` | None | Member-only delivery, duplicate event handling, reconnect state recovery, invalid payload resilience |
| `E2E-001..004` | None | Onboarding, matching, room lifecycle, and feedback browser journeys |

## Delivery decisions and phase mapping

The following decisions are recorded for later PRs; they are not runtime changes in Phase 1:

1. Use Supabase anonymous sign-ins to keep the no-login experience. Anonymous users still use the `authenticated` role, so `auth.uid()` checks, RLS, authorization, and abuse controls remain mandatory. See [Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous) and the [server package selection guide](https://supabase.com/docs/guides/auth/choosing-a-server-package).
2. Make `/api/*` the canonical Next.js interface in Phase 3. Preserve old paths temporarily with explicit rewrites while clients migrate.
3. Deliver the migration as phased PRs rather than mixing architecture, database, tests, and deployment in one change.

| Phase | Planned scope |
| --- | --- |
| Phase 1 | This audit, cross-platform green baseline, lint, and one quality command |
| Phase 2 | Reuse/harden domain packages; Zod business rules; deterministic Fake LLM; P0 unit tests |
| Phase 3 | Migrate core Fastify routes to Next.js Route Handlers; anonymous Auth/cookie session; temporary legacy rewrites |
| Phase 4 | Real local Supabase integration for migrations, seed, RPC, grants, RLS, negative authorization, Storage, and concurrency |
| Phase 5 | Four Playwright journeys and minimum Realtime authorization/recovery coverage |
| Phase 6 | GitHub Actions, Vercel preview/production, smoke checks, optional load workflow, and Railway retirement guidance |

## Files changed in Phase 1

| File | Purpose |
| --- | --- |
| `.nvmrc` | Select Node.js 22 for development and CI |
| `package.json`, `pnpm-lock.yaml` | Add ESLint tooling, `pnpm lint`, missing dependency graph entries, and the ordered `check` gate |
| `eslint.config.mjs` | Apply recommended TypeScript rules and Next.js Core Web Vitals/TypeScript rules with generated-output ignores |
| `apps/api/package.json` | Declare the two workspace packages directly imported by API tests |
| `apps/web/package.json`, `next.config.ts`, `tsconfig.json`, `next-env.d.ts` | Remove POSIX-only dist-dir switching and normalize generated types to `.next` |
| `apps/web/app/page.tsx` | Stabilize the message refresh callback and make existing polling dependencies explicit for lint |
| `README.md` | Document Node/Corepack/pnpm setup, the quality commands, and the PGlite boundary |
| `docs/qa-baseline.md` | Record the repository audit, real results, risk boundaries, P0 gaps, and phased migration decisions |

## Known limitations after Phase 1

- Supabase CLI is still absent and the local Docker daemon is unavailable; no real Supabase integration command was run.
- There are no GitHub Actions, Next.js Route Handlers, Playwright tests, Fake LLM scenario suite, or browser tests yet.
- Fastify and the independent Railway worker remain the current runtime architecture until later phases migrate them.
- The existing k6 script has no root command and was not run as part of this baseline.
- Dependency build-script allowlisting may need an explicit repository policy before CI/release images are finalized; it did not block the verified build.

## Phase 1 change boundary

Phase 1 changes only tooling, dependency declarations, generated Next.js path normalization, lint-required behavior-preserving React hook dependencies, README setup instructions, and this report. It does not change HTTP contracts, Zod business contracts, database schemas, migrations, runtime responses, deployment topology, or product behavior.
