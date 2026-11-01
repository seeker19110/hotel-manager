// Real Docker startup/shutdown check, with ephemeral PostgreSQL/SeaweedFS and a fake local scanner.
// No production settings, external account or user data are used. Cleanup touches only resources created here.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeClamd } from "../../apps/web/e2e/fakes.ts";
import { ObjectStorage } from "../../packages/app/src/files/storage.ts";
import { migrateToLatest } from "../../packages/db/src/index.ts";
import { bootstrapRoles, pgUrl } from "../../packages/testkit/src/bootstrap.ts";
import { freePort, startPgCluster } from "../../packages/testkit/src/pg-cluster.ts";
import { startS3Server } from "../../packages/testkit/src/s3-server.ts";
import { analyzeSbom } from "../sbom-check.mjs";
import { docker, smoke, waitForWorker } from "./run.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requireDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Kysely, PostgresDialect, sql } = requireDb("kysely");
const pg = requireDb("pg");
const name = `hm-image-${randomUUID().slice(0, 8)}`;
const scratch = await mkdtemp(resolve(tmpdir(), "hm-image-check-"));
const containers = [];
const images = [];
const databases = [];
let cluster;
let s3;
let clamd;
let failed = false;

function db(url) {
  const connection = new Kysely({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 3 }) }),
  });
  databases.push(connection);
  return connection;
}
async function command(args, label, timeout = 180_000, executable = "docker") {
  const file = await open(resolve(scratch, `${label}.log`), "w", 0o600);
  try {
    return await new Promise((accept, reject) => {
      const proc = spawn(executable, args, {
        cwd: root,
        stdio: ["ignore", file.fd, file.fd],
        timeout,
        killSignal: "SIGTERM",
      });
      proc.once("error", () => reject(new Error(`DOCKER_${label}_SPAWN_FAILED`)));
      proc.once("exit", (code) => (code === 0 ? accept() : reject(new Error(`DOCKER_${label}_FAILED`))));
    });
  } finally {
    await file.close();
  }
}
async function until(check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error("IMAGE_STARTUP_TIMEOUT");
}

try {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await command(["scripts/grype-ignore-check.mjs"], "ignore-expiry", 60_000, process.execPath);
  for (const kind of ["web", "worker"]) {
    const image = `${name}-${kind}:check`;
    images.push(image);
    process.stdout.write(`Building ${kind} image\n`);
    await command(
      ["build", "-f", `deploy/${kind}.Dockerfile`, "-t", image, "."],
      `build-${kind}`,
      20 * 60_000,
    );
    await command(
      [
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "-e",
        "const fs=require('node:fs');if(process.getuid()===0 || fs.existsSync('/usr/local/lib/node_modules/npm') || !['/app/LICENSE','/app/THIRD_PARTY_NOTICES.md'].every(p=>fs.existsSync(p))) process.exit(1)",
      ],
      `identity-${kind}`,
    );
  }
  cluster = await startPgCluster();
  const admin = db(cluster.adminUrl);
  await bootstrapRoles(admin);
  const database = `hm_image_${randomUUID().replaceAll("-", "")}`;
  await sql`CREATE DATABASE ${sql.id(database)}`.execute(admin);
  await migrateToLatest(db(pgUrl(cluster.adminUrl, database)));
  s3 = await startS3Server();
  await new ObjectStorage(s3.config).ensureBucket();
  clamd = await startFakeClamd();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "0.0.0.0",
    NEXT_TELEMETRY_DISABLED: "1",
    APP_BASE_URL: origin,
    DATABASE_URL: pgUrl(cluster.adminUrl, database, "app_runtime"),
    WORKER_DATABASE_URL: pgUrl(cluster.adminUrl, database, "app_worker"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    S3_ENDPOINT: s3.config.endpoint,
    S3_BUCKET: s3.config.bucket,
    S3_REGION: s3.config.region,
    S3_ACCESS_KEY_ID: s3.config.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.config.secretAccessKey,
    HM_PII_KEYS: `1:${randomBytes(32).toString("base64")}`,
    HM_PII_KEY_ID: "1",
    HM_PII_INDEX_KEY: randomBytes(32).toString("base64"),
    CLAMD_HOST: "127.0.0.1",
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: "fake://local",
  };
  const envFile = resolve(scratch, "runtime-config.txt");
  await writeFile(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    { mode: 0o600 },
  );
  for (const kind of ["web", "worker"]) {
    const container = `${name}-${kind}`;
    containers.push(container);
    // The check runs on a Linux Docker host: loopback services are test-only and reached via host networking.
    const args = ["run", "-d", "--name", container, "--network", "host", "--env-file", envFile];
    args.push(`${name}-${kind}:check`);
    await command(args, `start-${kind}`);
  }
  const pkg = JSON.parse(await readFile(resolve(root, "apps/web/package.json"), "utf8"));
  await until(async () => {
    try {
      await smoke(origin, pkg.version);
      return true;
    } catch {
      return false;
    }
  });
  const htmlResponse = await fetch(`${origin}/dang-nhap`, { signal: AbortSignal.timeout(5000) });
  const html = await htmlResponse.text();
  const staticPath = /(?:src|href)="(\/_next\/static\/[^"?#]+)(?:[?#][^"]*)?"/.exec(html)?.[1];
  if (!staticPath) throw new Error("IMAGE_STATIC_ASSET_MISSING");
  for (const path of ["/serwist/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", staticPath]) {
    const response = await fetch(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200 || (await response.arrayBuffer()).byteLength === 0)
      throw new Error(`IMAGE_PWA_ASSET_FAILED:${path}`);
  }
  await waitForWorker({
    compose: resolve(root, "deploy/compose.yaml"),
    override: resolve(scratch, "images.json"),
    // This harness starts containers directly. Adapt only Compose selection; inspect/logs use the production executor.
    run: (args, timeout) =>
      docker(args[0] === "compose" ? ["inspect", "--format", "{{.Id}}", `${name}-worker`] : args, timeout),
  });
  for (const kind of ["web", "worker"]) {
    await command(["stop", "--time", "40", `${name}-${kind}`], `stop-${kind}`, 50_000);
    await command(["inspect", "--format", "{{.State.ExitCode}}", `${name}-${kind}`], `exit-${kind}`);
    if ((await readFile(resolve(scratch, `exit-${kind}.log`), "utf8")).trim() !== "0")
      throw new Error("IMAGE_SHUTDOWN_FAILED");
  }
  const ids = {};
  const scans = {};
  for (const kind of ["web", "worker"]) {
    await command(["image", "inspect", "--format", "{{.Id}}", `${name}-${kind}:check`], `digest-${kind}`);
    ids[kind] = (await readFile(resolve(scratch, `digest-${kind}.log`), "utf8")).trim();
    const sbom = resolve(scratch, `${kind}.cdx.json`);
    const vulnerabilities = resolve(scratch, `${kind}.grype.json`);
    await command(
      [`docker:${name}-${kind}:check`, "-o", `cyclonedx-json=${sbom}`],
      `sbom-${kind}`,
      180_000,
      "syft",
    );
    await command(
      [`sbom:${sbom}`, "--fail-on", "high", "--only-fixed", "--output", "json", "--file", vulnerabilities],
      `grype-${kind}`,
      180_000,
      "grype",
    );
    await command(["scripts/sbom-check.mjs", sbom], `licenses-${kind}`, 60_000, process.execPath);
    const bom = JSON.parse(await readFile(sbom, "utf8"));
    const license = analyzeSbom(bom);
    const report = JSON.parse(await readFile(vulnerabilities, "utf8"));
    scans[kind] = {
      components: license.total,
      grypeFixedHighCritical: report.matches.filter((m) =>
        ["High", "Critical"].includes(m.vulnerability.severity),
      ).length,
      licenseCoveragePassed: true,
      licenseCoveragePercent: Number(license.coverage.toFixed(2)),
    };
  }
  const evidence = {
    checkedAt: new Date().toISOString(),
    scope: "local-ephemeral-only",
    version: pkg.version,
    images: ids,
    scans,
    nonroot: true,
    npmAbsent: true,
    rootLicenseAndNoticesPresent: true,
    smoke: "health-ready-version-security-headers",
    workerStarted: true,
    workerStartupChecker: "real Docker inspect/logs; Compose selection adapted for this ephemeral harness",
    pwaAssets: ["service-worker", "manifest", "icon", "next-static"],
    gracefulExitCodes: { web: 0, worker: 0 },
  };
  await writeFile(resolve(scratch, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Local image verification passed; evidence: ${resolve(scratch, "evidence.json")}\n`);
} catch (error) {
  failed = true;
  for (const kind of ["web", "worker"]) {
    if (containers.includes(`${name}-${kind}`)) {
      try {
        await command(["logs", "--tail", "100", `${name}-${kind}`], `failure-logs-${kind}`);
      } catch {
        /* Container may have failed before creation. */
        process.stderr.write("IMAGE_FAILURE_LOGS_UNAVAILABLE\n");
      }
    }
  }
  throw error;
} finally {
  const cleanupErrors = [];
  const clean = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  for (const container of containers) {
    await clean(() => command(["rm", "-f", container], `cleanup-${container}`));
  }
  for (const image of images) {
    await clean(() => command(["image", "rm", image], `cleanup-image-${image.replaceAll(":", "-")}`));
  }
  for (const connection of databases.reverse()) await clean(() => connection.destroy());
  for (const fake of [clamd]) {
    if (fake) {
      fake.server.closeAllConnections?.();
      await clean(
        () =>
          new Promise((accept, reject) => fake.server.close((error) => (error ? reject(error) : accept()))),
      );
    }
  }
  await clean(() => s3?.stop());
  await clean(() => cluster?.stop());
  await clean(() => rm(resolve(scratch, "runtime-config.txt"), { force: true }));
  if (cleanupErrors.length) {
    if (!failed) process.exitCode = 1;
    process.stderr.write("IMAGE_CLEANUP_INCOMPLETE: inspect resources named in the scratch directory\n");
  }
}
