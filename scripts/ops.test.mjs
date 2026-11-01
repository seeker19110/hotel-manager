// SPEC-operations S-001…S-005: immutable release, verified rollback, bounded backups, strict smoke and worker startup.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { backup, composeOverride, deploy, smoke, validateManifest, waitForWorker } from "./ops/run.mjs";

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hm-ops-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const release = (n = "1") => ({
  format: "hm-release/1",
  commit: n.repeat(40),
  version: `0.2.${n}`,
  web: `ghcr.io/example/hm-web@sha256:${n.repeat(64)}`,
  worker: `ghcr.io/example/hm-worker@sha256:${n.repeat(64)}`,
});
const read = async (name) => JSON.parse(await readFile(join(dir, name), "utf8"));
const workerId = "a".repeat(64);
const workerStart = "2026-11-01T00:00:00.123456789Z";
const workerState = (extra = {}) =>
  JSON.stringify({ Running: true, Restarting: false, Status: "running", StartedAt: workerStart, ...extra });
const startup = (ts = "2026-11-01T00:00:00.124Z") => JSON.stringify({ ts, msg: "worker.started" });
const workerRead = async (args) => {
  if (args[0] === "compose") return `${workerId}\n`;
  if (args[0] === "inspect") return workerState();
  if (args[0] === "logs") return startup();
  assert.fail("unexpected worker command");
};
const workerClock = () => {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms) => {
      at += ms;
    },
    timeoutMs: 2_000,
  };
};
const deployOptions = () => ({
  stateDir: dir,
  compose: "/repo/deploy/compose.yaml",
  origin: "https://hotel.example",
  run: async () => {},
  read: workerRead,
  workerWait: workerClock(),
  probe: async () => {},
});

test("worker startup waits for structured fresh logs from the current running instance", async () => {
  let logReads = 0;
  const result = await waitForWorker({
    compose: "/repo/deploy/compose.yaml",
    override: "/state/images.json",
    ...workerClock(),
    run: async (args, timeout) => {
      assert.ok(timeout > 0 && timeout <= 5_000);
      if (args[0] === "logs") {
        assert.deepEqual(args, ["logs", "--since", workerStart, workerId]);
        return ++logReads === 1 ? "pending database\nworker.started\n" : startup();
      }
      return workerRead(args);
    },
  });
  assert.equal(logReads, 2);
  assert.deepEqual(result, { id: workerId, startedAt: workerStart });
});

test("worker startup rejects stale markers, crashed containers, restarts and replacement IDs", async () => {
  const options = () => ({ compose: "/repo/compose.yaml", override: "/state/images.json", ...workerClock() });
  await assert.rejects(
    waitForWorker({
      ...options(),
      run: (args) => (args[0] === "logs" ? startup("2026-10-31T23:59:59.999Z") : workerRead(args)),
    }),
    /WORKER_STARTUP_TIMEOUT/,
  );
  await assert.rejects(
    waitForWorker({
      ...options(),
      run: (args) =>
        args[0] === "inspect" ? workerState({ Running: false, Status: "exited" }) : workerRead(args),
    }),
    /WORKER_NOT_RUNNING/,
  );
  for (const replace of [false, true]) {
    let readLog = false;
    await assert.rejects(
      waitForWorker({
        ...options(),
        run: (args) => {
          if (args[0] === "logs") {
            readLog = true;
            return startup();
          }
          if (readLog && replace && args[0] === "compose") return "b".repeat(64);
          if (readLog && !replace && args[0] === "inspect")
            return workerState({ StartedAt: "2026-11-01T00:00:01Z" });
          return workerRead(args);
        },
      }),
      /WORKER_INSTANCE_CHANGED/,
    );
  }
});

test("worker reader refuses malformed identities/state and never exposes child errors", async () => {
  const options = () => ({ compose: "/repo/compose.yaml", override: "/state/images.json", ...workerClock() });
  for (const value of ["", `${workerId}\n${"b".repeat(64)}`, "--help"])
    await assert.rejects(
      waitForWorker({ ...options(), run: async () => value }),
      /WORKER_CONTAINER_NOT_FOUND/,
    );
  for (const value of ["secret malformed JSON", workerState({ StartedAt: "invalid" })])
    await assert.rejects(
      waitForWorker({ ...options(), run: (args) => (args[0] === "inspect" ? value : workerRead(args)) }),
      /WORKER_STATE_UNAVAILABLE|WORKER_START_TIME_INVALID/,
    );
  await assert.rejects(
    waitForWorker({
      ...options(),
      run: async () => {
        throw new Error("postgres://private-password");
      },
    }),
    (error) => error.message === "WORKER_STATE_UNAVAILABLE",
  );
});

test("worker startup bounds every query by the remaining monotonic deadline", async () => {
  let at = 0;
  const limits = [];
  await assert.rejects(
    waitForWorker({
      compose: "/repo/compose.yaml",
      override: "/state/images.json",
      timeoutMs: 2_000,
      now: () => at,
      run: async (args, timeout) => {
        limits.push(timeout);
        at += Math.min(600, timeout);
        return args[0] === "logs" ? "pending" : workerRead(args);
      },
    }),
    /WORKER_STARTUP_TIMEOUT/,
  );
  assert.equal(at, 2_000);
  assert.deepEqual(limits, [2_000, 1_400, 800, 200]);
  for (const timeoutMs of [0, -1, 120_001, Number.NaN])
    await assert.rejects(
      waitForWorker({
        compose: "/repo/compose.yaml",
        override: "/state/images.json",
        timeoutMs,
        run: async () => assert.fail("invalid deadline must not query Docker"),
      }),
      /INVALID_WORKER_STARTUP_TIMEOUT/,
    );
});

test("healthy HTTP cannot promote a pending worker, and rollback must verify its own worker", async () => {
  for (const rollbackReady of [true, false]) {
    await deploy({ ...deployOptions(), manifest: release() });
    let phase = 0;
    const probes = [];
    await assert.rejects(
      deploy({
        ...deployOptions(),
        manifest: release("2"),
        run: async () => {
          phase += 1;
        },
        read: (args) =>
          args[0] === "logs" && (phase === 1 || !rollbackReady) ? "pending" : workerRead(args),
        probe: async (_, value) => {
          probes.push(value);
        },
      }),
      rollbackReady ? /DEPLOY_FAILED_ROLLBACK_PASSED/ : /DEPLOY_FAILED_REQUIRES_RECOVERY/,
    );
    assert.equal(phase, 2);
    assert.deepEqual(probes, rollbackReady ? [release().version] : []);
    assert.equal((await read("releases.json")).current.commit, release().commit);
    assert.equal((await read("last-attempt.json")).outcome, rollbackReady ? "rolled_back" : "failed");
  }
});

test("a worker crash during HTTP smoke prevents history from advancing", async () => {
  await deploy({ ...deployOptions(), manifest: release() });
  let running = true;
  await assert.rejects(
    deploy({
      ...deployOptions(),
      manifest: release("2"),
      run: async () => {
        running = true;
      },
      read: (args) =>
        args[0] === "inspect" && !running
          ? workerState({ Running: false, Status: "exited" })
          : workerRead(args),
      probe: async (_, value) => {
        if (value === release("2").version) running = false;
      },
    }),
    /DEPLOY_FAILED_ROLLBACK_PASSED/,
  );
  assert.equal((await read("releases.json")).current.commit, release().commit);
  assert.equal((await read("last-attempt.json")).outcome, "rolled_back");
});

test("release manifest rejects tags, unknown fields and unsafe values before any external operation", async () => {
  for (const bad of [
    Object.fromEntries(
      Object.entries(release()).map(([key, value]) => [key, key === "format" ? value : [value]]),
    ),
    { ...release(), web: "image:latest" },
    { ...release(), commit: "main" },
    { ...release(), worker: "--help" },
    { ...release(), token: "private" },
    null,
  ]) {
    assert.throws(() => validateManifest(bad), /INVALID_RELEASE_MANIFEST/);
    let called = false;
    await assert.rejects(
      deploy({
        ...deployOptions(),
        manifest: bad,
        run: async () => {
          called = true;
        },
      }),
    );
    assert.equal(called, false);
  }
  assert.deepEqual(JSON.parse(composeOverride(release())).services.web, { image: release().web });
});

test("promotion pins identical digests and saves history only after smoke; explicit rollback swaps versions", async () => {
  const applied = [];
  const run = async (args) => {
    assert.deepEqual(args.slice(-11), [
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
    applied.push(JSON.parse(await readFile(args[4], "utf8")));
  };
  await deploy({ ...deployOptions(), manifest: release(), run });
  await deploy({ ...deployOptions(), manifest: release("2"), run });
  assert.equal((await read("releases.json")).previous.commit, release().commit);
  await deploy({ ...deployOptions(), rollback: true, run });
  assert.equal((await read("releases.json")).current.commit, release().commit);
  assert.equal(applied[2].services.web.image, release().web);
});

test("failed candidate restores last good artifact and preserves successful history", async () => {
  await deploy({ ...deployOptions(), manifest: release() });
  const probes = [];
  await assert.rejects(
    deploy({
      ...deployOptions(),
      manifest: release("2"),
      probe: async (_, v) => {
        probes.push(v);
        if (v === "0.2.2") throw new Error("bad readiness");
      },
    }),
    /DEPLOY_FAILED_ROLLBACK_PASSED/,
  );
  assert.deepEqual(probes, ["0.2.2", "0.2.1"]);
  assert.equal((await read("releases.json")).current.commit, release().commit);
  assert.equal((await read("last-attempt.json")).outcome, "rolled_back");
});

test("re-promoting the current release preserves the actual previous release", async () => {
  await deploy({ ...deployOptions(), manifest: release() });
  await deploy({ ...deployOptions(), manifest: release("2") });
  await deploy({ ...deployOptions(), manifest: release("2") });
  assert.equal((await read("releases.json")).previous.commit, release().commit);
  await deploy({ ...deployOptions(), rollback: true });
  assert.equal((await read("releases.json")).current.commit, release().commit);
});

test("post-smoke evidence/history failures restore the application without advancing successful history", async () => {
  for (const failedFile of ["last-attempt.json", "releases.json"]) {
    await deploy({ ...deployOptions(), manifest: release() });
    const versions = [];
    let failed = false;
    await assert.rejects(
      deploy({
        ...deployOptions(),
        manifest: release("2"),
        probe: async (_, v) => {
          versions.push(v);
        },
        persist: async (path, content) => {
          if (
            !failed &&
            path.endsWith(failedFile) &&
            (failedFile === "releases.json" || JSON.parse(content).outcome === "passed")
          ) {
            failed = true;
            throw new Error("disk full");
          }
          await writeFile(path, content);
        },
      }),
      /DEPLOY_FAILED_ROLLBACK_PASSED/,
    );
    assert.deepEqual(versions, ["0.2.2", "0.2.1"]);
    assert.equal((await read("releases.json")).current.commit, release().commit);
  }
});

test("first deployment failure never invents a rollback or successful release", async () => {
  await assert.rejects(
    deploy({
      ...deployOptions(),
      manifest: release(),
      run: async () => {
        throw new Error("failed");
      },
    }),
    /REQUIRES_RECOVERY/,
  );
  await assert.rejects(read("releases.json"), { code: "ENOENT" });
  assert.equal((await read("last-attempt.json")).outcome, "failed");
});

test("concurrent promotion refuses lock; malformed persisted state fails before Compose", async () => {
  await mkdir(join(dir, "operation.lock"));
  await assert.rejects(deploy({ ...deployOptions(), manifest: release() }), { code: "EEXIST" });
  await rm(join(dir, "operation.lock"), { recursive: true });
  await writeFile(join(dir, "releases.json"), "{broken");
  let called = false;
  await assert.rejects(
    deploy({
      ...deployOptions(),
      manifest: release(),
      run: async () => {
        called = true;
      },
    }),
    /INVALID_STATE_FILE/,
  );
  assert.equal(called, false);
});

const response = (path, status = 200, v = "0.2.1", secure = true) =>
  new Response(path === "/api/version" ? JSON.stringify({ version: v }) : "ok", {
    status,
    headers: secure
      ? {
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "content-security-policy": "object-src 'none'; frame-ancestors 'none'",
        }
      : {},
  });
test("smoke probes readiness, exact version and real security headers without redirects", async () => {
  const paths = [];
  await smoke("https://hotel.example", "0.2.1", async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return response(path);
  });
  assert.deepEqual(paths, ["/api/health", "/api/ready", "/api/version", "/dang-nhap"]);
  await assert.rejects(
    smoke("https://hotel.example", "0.2.1", async (url) => response(new URL(url).pathname, 503)),
    /SMOKE_HTTP_STATUS/,
  );
  await assert.rejects(
    smoke("https://hotel.example", "0.2.1", async (url) => response(new URL(url).pathname, 200, "0.2.2")),
    /SMOKE_VERSION_MISMATCH/,
  );
  await assert.rejects(
    smoke("https://hotel.example", "0.2.1", async (url) =>
      response(new URL(url).pathname, 200, "0.2.1", false),
    ),
    /SMOKE_SECURITY_HEADERS/,
  );
});
test("smoke forbids credential URLs, remote plaintext and hidden path/query; localhost is permitted", async () => {
  for (const url of [
    "http://hotel.example",
    "https://user:secret@example.test",
    "https://hotel.example/?token=x",
    "https://hotel.example/other",
  ]) {
    let called = false;
    await assert.rejects(
      smoke(url, "0.2.1", async () => {
        called = true;
      }),
      /INVALID_SMOKE_ORIGIN/,
    );
    assert.equal(called, false);
  }
  await smoke("http://127.0.0.1:3000", "0.2.1", async (url) => response(new URL(url).pathname));
});

test("smoke rejects CSP lookalikes, duplicate directives and additional allowed sources", async () => {
  for (const csp of [
    "x-object-src 'none'; frame-ancestors 'none'",
    "object-src 'none' https:; frame-ancestors 'none'",
    "object-src 'none'; frame-ancestors 'none' https:",
    "object-src 'none'; object-src https:; frame-ancestors 'none'",
  ]) {
    await assert.rejects(
      smoke("https://hotel.example", "0.2.1", async (url) => {
        const res = response(new URL(url).pathname);
        res.headers.set("content-security-policy", csp);
        return res;
      }),
      /SMOKE_SECURITY_HEADERS/,
    );
  }
});

test("backup runs bounded pgBackRest as postgres and preserves success metrics across failure", async () => {
  const metricsDir = join(dir, "metrics");
  const opts = {
    type: "full",
    compose: "/repo/deploy/compose.yaml",
    stateDir: dir,
    metricsDir,
    now: () => 100_000,
  };
  await backup({
    ...opts,
    run: async (args, timeout) => {
      assert.ok(timeout > 0 && timeout < 60 * 60_000);
      assert.deepEqual(args.slice(-7), [
        "postgres",
        "postgres",
        "pgbackrest",
        "--stanza=hm",
        "--type=full",
        "--log-level-console=warn",
        "backup",
      ]);
    },
  });
  await assert.rejects(
    backup({
      ...opts,
      type: "diff",
      now: () => 200_000,
      run: async () => {
        throw new Error("secret URL");
      },
    }),
    /BACKUP_FAILED/,
  );
  const state = await read("backup.json");
  assert.equal(state.lastSuccess, 100);
  assert.equal(state.lastFullSuccess, 100);
  assert.equal(state.lastAttempt, 200);
  assert.equal(state.ok, false);
  const metrics = await readFile(join(metricsDir, "hotel-manager-backup.prom"), "utf8");
  assert.match(metrics, /hm_backup_last_run_success 0\n/);
  assert.match(metrics, /hm_backup_last_success_timestamp_seconds 100\n/);
  assert.doesNotMatch(metrics, /secret/);
  assert.equal((await stat(join(metricsDir, "hotel-manager-backup.prom"))).mode & 0o777, 0o644);
  assert.equal((await stat(join(dir, "backup.json"))).mode & 0o777, 0o600);
});
test("backup rejects bad type/state and serializes full and differential runs", async () => {
  const opts = {
    type: "full",
    compose: "/repo/deploy/compose.yaml",
    stateDir: dir,
    metricsDir: join(dir, "metrics"),
    run: async () => {
      assert.fail("must not run");
    },
  };
  await assert.rejects(backup({ ...opts, type: "--help" }), /INVALID_BACKUP_TYPE/);
  await mkdir(join(dir, "operation.lock"));
  await assert.rejects(backup(opts), { code: "EEXIST" });
  await rm(join(dir, "operation.lock"), { recursive: true });
  await writeFile(join(dir, "backup.json"), '{"lastSuccess":-1}');
  await assert.rejects(backup(opts), /INVALID_BACKUP_STATE/);
});

test("systemd restrictive umask still emits readable public counters and private backup state", async () => {
  const previous = process.umask(0o027);
  try {
    const metricsDir = join(dir, "textfile");
    await backup({
      type: "full",
      compose: "/repo/deploy/compose.yaml",
      stateDir: dir,
      metricsDir,
      run: async () => {},
    });
    assert.equal((await stat(join(metricsDir, "hotel-manager-backup.prom"))).mode & 0o777, 0o644);
    assert.equal((await stat(metricsDir)).mode & 0o777, 0o755);
    assert.equal((await stat(join(dir, "backup.json"))).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});
