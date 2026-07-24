#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const inProgressStatuses = new Set([
  "QUEUED",
  "INITIALIZING",
  "WAITING",
  "BUILDING",
  "DEPLOYING"
]);
const failedStatuses = new Set([
  "FAILED",
  "CRASHED",
  "NEEDS_APPROVAL",
  "SLEEPING",
  "SKIPPED",
  "REMOVED",
  "REMOVING"
]);

function parseArguments(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function railwayEnvironment() {
  return {
    ...process.env,
    RAILWAY_CALLER: "skill:use-railway@1.3.5",
    RAILWAY_AGENT_SESSION:
      process.env.RAILWAY_AGENT_SESSION ??
      `agent-layer-release-${process.env.GITHUB_RUN_ID ?? process.pid}`
  };
}

async function railway(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const command = process.env.RAILWAY_CLI ?? "railway";
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: railwayEnvironment(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    if (allowFailure) {
      return error.stdout?.toString() ?? "";
    }
    const detail =
      error.stderr?.toString().trim() ||
      error.stdout?.toString().trim() ||
      error.message;
    throw new Error(`railway ${args.join(" ")} failed: ${detail}`);
  }
}

function firstJsonValue(output) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Railway CLI returned empty JSON output");
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split(/\r?\n/u).reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Railway JSON mode can emit non-JSON progress lines before the result.
      }
    }
  }
  throw new Error("Railway CLI returned invalid JSON output");
}

function deploymentEdges(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => entry?.node ?? entry).filter(Boolean);
}

export function normalizeDeployments(payload) {
  const candidates = [
    payload,
    payload?.deployments,
    payload?.data,
    payload?.data?.deployments,
    payload?.deployments?.edges,
    payload?.data?.deployments?.edges
  ];
  const raw = candidates.find(Array.isArray) ?? [];
  return deploymentEdges(raw).map((deployment) => ({
    id: String(
      deployment.id ?? deployment.deploymentId ?? deployment.deployment_id ?? ""
    ),
    status: String(
      deployment.status ?? deployment.state ?? deployment.deploymentStatus ?? ""
    ).toUpperCase(),
    createdAt:
      deployment.createdAt ??
      deployment.created_at ??
      deployment.updatedAt ??
      deployment.updated_at ??
      null,
    raw: deployment
  }));
}

async function listDeployments({ project, environment, service, limit = 20 }) {
  const output = await railway([
    "deployment",
    "list",
    "--project",
    project,
    "--environment",
    environment,
    "--service",
    service,
    "--limit",
    String(limit),
    "--json"
  ]);
  const deployments = normalizeDeployments(firstJsonValue(output));
  if (deployments.length === 0) {
    throw new Error(`No Railway deployments found for ${service}`);
  }
  return deployments;
}

export async function probeHealth({
  url,
  successes = 5,
  intervalSeconds = 10,
  timeoutSeconds = 5
}) {
  let consecutive = 0;
  let attempts = 0;
  const maximumAttempts = Math.max(successes * 3, successes);
  while (consecutive < successes && attempts < maximumAttempts) {
    attempts += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutSeconds * 1000
    );
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "tomeet-release-healthcheck/1" }
      });
      if (response.status === 200) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }
    } catch {
      consecutive = 0;
    } finally {
      clearTimeout(timeout);
    }
    if (consecutive < successes) await sleep(intervalSeconds * 1000);
  }
  if (consecutive < successes) {
    throw new Error(
      `Health probe did not return ${successes} consecutive HTTP 200 responses: ${url}`
    );
  }
  return { url, successes: consecutive, attempts };
}

async function deploymentLogs({ project, environment, service, deploymentId }) {
  const args = [
    "logs",
    "--project",
    project,
    "--environment",
    environment,
    "--service",
    service,
    "--lines",
    "200",
    "--json"
  ];
  if (deploymentId) args.push(deploymentId);
  return railway(args, { allowFailure: true });
}

export async function deployService({
  cwd,
  project,
  environment,
  service,
  message,
  healthUrl,
  timeoutSeconds = 900,
  pollSeconds = 10,
  healthSuccesses = 5
}) {
  const previous = await listDeployments({
    project,
    environment,
    service
  }).catch(() => []);
  const previousIds = new Set(previous.map(({ id }) => id).filter(Boolean));

  await railway(
    [
      "up",
      "--project",
      project,
      "--environment",
      environment,
      "--service",
      service,
      "--detach",
      "--json",
      "--message",
      message
    ],
    { cwd }
  );

  const deadline = Date.now() + timeoutSeconds * 1000;
  let deployment = null;
  while (Date.now() < deadline) {
    const deployments = await listDeployments({
      project,
      environment,
      service
    });
    deployment =
      deployments.find(({ id }) => id && !previousIds.has(id)) ??
      (previous.length === 0 ? deployments[0] : null);
    if (!deployment) {
      await sleep(pollSeconds * 1000);
      continue;
    }
    if (deployment.status === "SUCCESS") break;
    if (failedStatuses.has(deployment.status)) {
      const logs = await deploymentLogs({
        project,
        environment,
        service,
        deploymentId: deployment.id
      });
      throw new Error(
        `Railway deployment ${deployment.id} for ${service} ended as ${deployment.status}\n${logs}`
      );
    }
    if (!inProgressStatuses.has(deployment.status)) {
      throw new Error(
        `Railway deployment ${deployment.id} for ${service} has unknown status ${deployment.status}`
      );
    }
    await sleep(pollSeconds * 1000);
  }

  if (!deployment || deployment.status !== "SUCCESS") {
    const logs = await deploymentLogs({
      project,
      environment,
      service,
      deploymentId: deployment?.id
    });
    throw new Error(
      `Timed out waiting for Railway deployment of ${service}\n${logs}`
    );
  }

  let health = null;
  if (healthUrl) {
    health = await probeHealth({
      url: healthUrl,
      successes: healthSuccesses,
      intervalSeconds: pollSeconds
    });
  }
  return {
    service,
    deploymentId: deployment.id,
    status: deployment.status,
    health
  };
}

export async function checkServiceStatus({
  project,
  environment,
  service
}) {
  const [latest] = await listDeployments({
    project,
    environment,
    service,
    limit: 5
  });
  if (!latest || latest.status !== "SUCCESS") {
    throw new Error(
      `Railway service ${service} is not healthy; latest deployment status is ${latest?.status ?? "missing"}`
    );
  }
  return {
    service,
    deploymentId: latest.id,
    status: latest.status
  };
}

export async function observeServices({
  project,
  environment,
  services,
  healthUrls = [],
  seconds,
  intervalSeconds = 15
}) {
  const deadline = Date.now() + seconds * 1000;
  let checks = 0;
  while (Date.now() < deadline) {
    checks += 1;
    for (const service of services) {
      await checkServiceStatus({ project, environment, service });
    }
    for (const url of healthUrls) {
      await probeHealth({
        url,
        successes: 1,
        intervalSeconds: 1,
        timeoutSeconds: 5
      });
    }
    if (Date.now() < deadline) await sleep(intervalSeconds * 1000);
  }
  return { checks, seconds, services, healthUrls };
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "deploy") {
    output(
      await deployService({
        cwd: resolve(options.cwd ?? process.cwd()),
        project: required(options, "project"),
        environment: required(options, "environment"),
        service: required(options, "service"),
        message: required(options, "message"),
        healthUrl: options["health-url"],
        timeoutSeconds: positiveInteger(
          options["timeout-seconds"],
          900,
          "timeout-seconds"
        ),
        pollSeconds: positiveInteger(
          options["poll-seconds"],
          10,
          "poll-seconds"
        ),
        healthSuccesses: positiveInteger(
          options["health-successes"],
          5,
          "health-successes"
        )
      })
    );
    return;
  }
  if (command === "status") {
    output(
      await checkServiceStatus({
        project: required(options, "project"),
        environment: required(options, "environment"),
        service: required(options, "service")
      })
    );
    return;
  }
  if (command === "probe") {
    output(
      await probeHealth({
        url: required(options, "url"),
        successes: positiveInteger(options.successes, 3, "successes"),
        intervalSeconds: positiveInteger(
          options["interval-seconds"],
          10,
          "interval-seconds"
        ),
        timeoutSeconds: positiveInteger(
          options["timeout-seconds"],
          5,
          "timeout-seconds"
        )
      })
    );
    return;
  }
  if (command === "observe") {
    output(
      await observeServices({
        project: required(options, "project"),
        environment: required(options, "environment"),
        services: required(options, "services")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        healthUrls: (options["health-urls"] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        seconds: positiveInteger(options.seconds, 600, "seconds"),
        intervalSeconds: positiveInteger(
          options["interval-seconds"],
          15,
          "interval-seconds"
        )
      })
    );
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
