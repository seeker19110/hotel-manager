// Provider-neutral operations; credentials stay in Compose/pgBackRest configuration outside Git.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const fail = (code) => {
  throw new Error(code);
};

export function validateManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["commit", "version", "web", "worker"].every((key) => typeof value[key] === "string") ||
    value?.format !== "hm-release/1" ||
    !/^[a-f0-9]{40}$/.test(value.commit ?? "") ||
    !version.test(value.version ?? "") ||
    !digest.test(value.web ?? "") ||
    !digest.test(value.worker ?? "") ||
    Object.keys(value).some((key) => !["format", "commit", "version", "web", "worker"].includes(key))
  )
    fail("INVALID_RELEASE_MANIFEST");
  return value;
}

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    fail("INVALID_STATE_FILE");
  }
}

async function atomic(path, content, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode, flag: "wx" });
    await chmod(temp, mode); // Explicit public metric/private state modes even under systemd UMask=0027.
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {
      process.stderr.write("OPS_TEMP_CLEANUP_FAILED\n");
    });
  }
}

async function locked(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "operation.lock");
  await mkdir(lock, { mode: 0o700 }); // Atomic across processes; never steal an active/stale lock automatically.
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

/** Deliberately suppress child output: Compose/pgBackRest errors may contain credential-bearing URLs. */
export async function docker(args, timeout = 180_000) {
  try {
    await execute("docker", args, { timeout, killSignal: "SIGTERM", maxBuffer: 1024 * 1024 });
  } catch {
    fail("DOCKER_COMMAND_FAILED");
  }
}

function targetUrl(base) {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    fail("INVALID_SMOKE_ORIGIN");
  return url.origin;
}

/** Probe real responses; no cookies, credentials, redirects or response bodies are logged. */
export async function smoke(base, expectedVersion, fetcher = fetch) {
  const origin = targetUrl(base);
  if (!version.test(expectedVersion)) fail("INVALID_EXPECTED_VERSION");
  for (const path of ["/api/health", "/api/ready", "/api/version", "/dang-nhap"]) {
    const response = await fetcher(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "cache-control": "no-cache" },
    });
    if (response.status !== 200) fail(`SMOKE_HTTP_STATUS:${path}`);
    if (path === "/api/version" && (await response.json()).version !== expectedVersion)
      fail("SMOKE_VERSION_MISMATCH");
    if (path === "/dang-nhap") {
      const csp = response.headers.get("content-security-policy") ?? "";
      const directives = csp.split(";").map((directive) => directive.trim().split(/\s+/));
      const denies = (name) => {
        const matches = directives.filter(([key]) => key === name);
        return matches.length === 1 && matches[0].length === 2 && matches[0][1] === "'none'";
      };
      if (
        response.headers.get("x-content-type-options") !== "nosniff" ||
        response.headers.get("x-frame-options") !== "DENY" ||
        !denies("object-src") ||
        !denies("frame-ancestors")
      )
        fail("SMOKE_SECURITY_HEADERS");
    }
    if (!response.bodyUsed) await response.body?.cancel();
  }
  return { ok: true, version: expectedVersion };
}

export function composeOverride(manifest) {
  const m = validateManifest(manifest);
  // JSON is valid YAML. No shell/YAML interpolation of manifest fields.
  return `${JSON.stringify({ services: { web: { image: m.web }, worker: { image: m.worker } } }, null, 2)}\n`;
}

/** Promote the same immutable artifact; update durable history only after readiness, version and security probes pass. */
export async function deploy({
  manifest,
  compose,
  stateDir,
  origin,
  rollback = false,
  run = docker,
  probe = smoke,
  persist = atomic,
}) {
  targetUrl(origin);
  return locked(stateDir, async () => {
    const stateFile = resolve(stateDir, "releases.json");
    const history = await json(stateFile, { current: null, previous: null });
    if (!history || !Object.hasOwn(history, "current") || !Object.hasOwn(history, "previous"))
      fail("INVALID_RELEASE_STATE");
    if (history.current !== null) validateManifest(history.current);
    if (history.previous !== null) validateManifest(history.previous);
    const candidate = validateManifest(rollback ? history.previous : manifest);
    const override = resolve(stateDir, "images.json");
    const apply = async (m) => {
      await persist(override, composeOverride(m));
      await run([
        "compose",
        "-f",
        resolve(compose),
        "-f",
        override,
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "always",
        "--wait",
        "--wait-timeout",
        "120",
        "web",
        "worker",
      ]);
      await probe(origin, m.version);
    };
    await persist(
      resolve(stateDir, "last-attempt.json"),
      JSON.stringify({ commit: candidate.commit, outcome: "started" }),
    );
    try {
      await apply(candidate);
      await persist(
        resolve(stateDir, "last-attempt.json"),
        JSON.stringify({ commit: candidate.commit, outcome: "passed" }),
      );
      const same =
        history.current &&
        ["commit", "version", "web", "worker"].every((key) => history.current[key] === candidate[key]);
      // Commit history last: any earlier failure restores the previous application and leaves history intact.
      await persist(
        stateFile,
        JSON.stringify({ current: candidate, previous: same ? history.previous : history.current }),
      );
      return { ok: true, commit: candidate.commit };
    } catch {
      let restored = false;
      if (history.current) {
        try {
          await apply(history.current);
          restored = true;
        } catch {
          // Keep the last known good manifest and explicit failure evidence for operator recovery.
          process.stderr.write("OPS_ROLLBACK_FAILED\n");
        }
      }
      await persist(
        resolve(stateDir, "last-attempt.json"),
        JSON.stringify({ commit: candidate.commit, outcome: restored ? "rolled_back" : "failed" }),
      );
      fail(restored ? "DEPLOY_FAILED_ROLLBACK_PASSED" : "DEPLOY_FAILED_REQUIRES_RECOVERY");
    }
  });
}

/** A single shared lock serializes full/differential jobs. Failure retains previous success time and publishes a failure gauge. */
export async function backup({ type, compose, stateDir, metricsDir, run = docker, now = () => Date.now() }) {
  if (!["full", "diff"].includes(type)) fail("INVALID_BACKUP_TYPE");
  return locked(stateDir, async () => {
    const file = resolve(stateDir, "backup.json");
    const state = await json(file, { lastSuccess: 0, lastFullSuccess: 0, lastDiffSuccess: 0 });
    if (
      ![state?.lastSuccess, state?.lastFullSuccess, state?.lastDiffSuccess].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      fail("INVALID_BACKUP_STATE");
    let ok = false;
    try {
      await run(
        [
          "compose",
          "-f",
          resolve(compose),
          "exec",
          "-T",
          "--user",
          "postgres",
          "postgres",
          "pgbackrest",
          "--stanza=hm",
          `--type=${type}`,
          "--log-level-console=warn",
          "backup",
        ],
        55 * 60_000,
      );
      ok = true;
    } catch {
      // Emit durable failure state and metrics before returning a nonzero service status.
      process.stderr.write("OPS_BACKUP_COMMAND_FAILED\n");
    }
    const stamp = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(stamp) || stamp < 0) fail("INVALID_CLOCK");
    const next = { ...state, lastAttempt: stamp, ok };
    if (ok) {
      next.lastSuccess = stamp;
      next[type === "full" ? "lastFullSuccess" : "lastDiffSuccess"] = stamp;
    }
    const created = await mkdir(metricsDir, { recursive: true, mode: 0o755 });
    if (created) await chmod(metricsDir, 0o755);
    await atomic(file, JSON.stringify(next));
    const metrics = [
      `hm_backup_last_attempt_timestamp_seconds ${stamp}`,
      `hm_backup_last_success_timestamp_seconds ${next.lastSuccess}`,
      `hm_backup_last_full_success_timestamp_seconds ${next.lastFullSuccess}`,
      `hm_backup_last_run_success ${ok ? 1 : 0}`,
    ];
    await atomic(resolve(metricsDir, "hotel-manager-backup.prom"), `${metrics.join("\n")}\n`, 0o644);
    if (!ok) fail("BACKUP_FAILED");
    return { ok, type };
  });
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "smoke" && rest.length === 2) return smoke(...rest);
  if (command === "backup" && rest.length === 4)
    return backup({ type: rest[0], compose: rest[1], stateDir: rest[2], metricsDir: rest[3] });
  if (command === "promote" && rest.length === 4)
    return deploy({ manifest: await json(rest[0]), compose: rest[1], stateDir: rest[2], origin: rest[3] });
  if (command === "rollback" && rest.length === 3)
    return deploy({ compose: rest[0], stateDir: rest[1], origin: rest[2], rollback: true });
  fail(
    "USAGE: smoke ORIGIN VERSION | backup full|diff COMPOSE STATE METRICS | promote MANIFEST COMPOSE STATE ORIGIN | rollback COMPOSE STATE ORIGIN",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${error.message.startsWith("USAGE:") ? error.message : "OPERATION_FAILED: inspect service state and runbook; no credentials logged"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
