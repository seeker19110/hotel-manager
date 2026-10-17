// T-301 (BASE-CFG-002, ARC-RES-009, BE-REL-004) — worker chạy thật trên Postgres thật: khởi động từ env, outbox được relay +
// xử lý, mọi job định kỳ chạy được, nhịp ghi, dừng êm đợi handler đang chạy rồi đóng sạch kết nối.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ConfigError, createLogger } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxJob } from "./relay.ts";
import { bootWorker, type RunningWorker } from "./runtime.ts";

let t: TestDb;
let A: SeededOrg;

const FAST = {
  relay: 100,
  heartbeat: 100,
  emails: 100,
  holds: 100,
  reminders: 100,
  periods: 100,
  lease: 100,
  exports: 100,
  retention: 100,
};

function envOf(): Record<string, string> {
  const s3 = testS3Config();
  return {
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    DATABASE_URL: t.runtimeUrl,
    WORKER_DATABASE_URL: t.workerUrl,
    BETTER_AUTH_SECRET: "x".repeat(40),
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: s3.region,
    S3_BUCKET: s3.bucket,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  };
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level: "debug", sink: { write: (l) => void lines.push(JSON.parse(l)) } });
  return { lines, log };
}

async function addOutbox(eventType: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
            values (${id}, ${A.orgId}, ${eventType}, '{}'::jsonb, ${`c-${id}`})`.execute(t.admin);
  return id;
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("quá thời gian chờ");
}

async function published(id: string): Promise<boolean> {
  const r = await sql<{
    p: boolean;
  }>`select published_at is not null as p from outbox where id = ${id}`.execute(t.admin);
  return r.rows[0]?.p === true;
}

/** Số kết nối còn mở của hai vai trò ứng dụng tới DB test này (pg-boss dùng app_worker nên cũng tính). */
async function appConnections(): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n from pg_stat_activity
    where datname = ${t.name} and usename in ('app_worker', 'app_runtime')`.execute(t.admin);
  return r.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Worker runtime");
});

afterAll(async () => {
  await t.drop();
});

describe("schema pgboss (migration 0047, D-024)", () => {
  it("tạo sẵn, thuộc app_worker; app_worker không có CREATE trên CSDL", async () => {
    const r = await sql<{ owner: string; can_create: boolean }>`
      select nspowner::regrole::text as owner,
             has_database_privilege('app_worker', current_database(), 'CREATE') as can_create
      from pg_namespace where nspname = 'pgboss'`.execute(t.admin);
    expect(r.rows[0]).toEqual({ owner: "app_worker", can_create: false });
  });
});

describe("cấu hình sai", () => {
  it("thiếu biến → ConfigError nêu tên biến, không giá trị bí mật, chưa mở kết nối nào", async () => {
    const env = envOf();
    const before = await appConnections();
    const bad = { ...env, WORKER_DATABASE_URL: undefined, S3_BUCKET: undefined } as Record<
      string,
      string | undefined
    >;
    const err = await bootWorker(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain("WORKER_DATABASE_URL");
    expect(msg).toContain("S3_BUCKET");
    expect(msg).not.toContain(env.S3_SECRET_ACCESS_KEY as string);
    expect(msg).not.toContain("x".repeat(40));
    expect(await appConnections()).toBe(before);
  });
});

describe("worker chạy thật", () => {
  let w: RunningWorker;
  const cap = capture();
  const handled: OutboxJob[] = [];
  let slowStarted = false;
  let slowFinished = false;

  beforeAll(async () => {
    w = await bootWorker(envOf(), {
      log: cap.log,
      intervals: FAST,
      pollingIntervalSeconds: 0.5,
      retentionInitialDelayMs: 0,
      stopTimeoutMs: 15_000,
      extraHandlers: {
        "test.ping": async (job) => void handled.push(job),
        "test.slow": async () => {
          slowStarted = true;
          await new Promise((r) => setTimeout(r, 1_500));
          slowFinished = true;
        },
      },
    });
  });

  afterAll(async () => {
    await w.shutdown();
  });

  it("outbox được relay sang pg-boss và handler nhận đúng tổ chức/sự kiện", async () => {
    const id = await addOutbox("test.ping");
    await waitFor(() => handled.some((j) => j.outbox_id === id));
    const job = handled.find((j) => j.outbox_id === id);
    expect(job?.organization_id).toBe(A.orgId);
    expect(job?.event_type).toBe("test.ping");
    expect(await published(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(handled.filter((j) => j.outbox_id === id)).toHaveLength(1); // không phát trùng
  });

  it("sự kiện 'chỉ để audit' được đánh dấu đã phát mà không sinh job; loại KHÔNG có consumer và không khai audit-only ở lại outbox (no_consumer), không kẹt đầu hàng", async () => {
    const orphan = await addOutbox("stay.checked_in"); // audit-only
    const unlisted = await addOutbox("orphan.unlisted"); // không consumer, không khai
    const after = await addOutbox("test.ping");
    await waitFor(() => published(orphan));
    await waitFor(() => handled.some((j) => j.outbox_id === after));
    const jobs = await sql<{
      n: number;
    }>`select count(*)::int as n from pgboss.job where name in ('stay.checked_in', 'orphan.unlisted')`.execute(
      t.admin,
    );
    expect(jobs.rows[0]?.n).toBe(0);
    expect(await published(unlisted)).toBe(false);
    const r = await sql<{
      last_error: string;
      attempts: number;
    }>`select last_error, attempts from outbox where id = ${unlisted}`.execute(t.admin);
    expect(r.rows[0]).toEqual({ last_error: "no_consumer", attempts: 1 }); // lùi lần thử ⇒ không bị thử lại ngay
    expect(cap.lines.some((l) => l.msg === "outbox.no_consumer" && l.event_type === "orphan.unlisted")).toBe(
      true,
    );
  });

  it("mọi job định kỳ chạy ít nhất một lượt, không lượt nào lỗi; nhịp được ghi", async () => {
    const expected = [
      "outbox.relay",
      "worker.heartbeat",
      "inventory.expire_holds",
      "notifications.reminders",
      "billing.generate_periods",
      "lease.daily",
      "exports.expire",
      "import.retention",
      "notifications.send_due",
    ];
    await waitFor(() => expected.every((j) => cap.lines.some((l) => l.msg === "job.done" && l.job === j)));
    const failed = cap.lines.filter((l) => l.msg === "job.failed");
    expect(failed).toEqual([]);
    const beat = await sql<{
      name: string;
      age: number;
    }>`select name, extract(epoch from now() - beat_at)::float8 as age from worker_heartbeats`.execute(
      t.admin,
    );
    expect(beat.rows.map((r) => r.name)).toContain("worker");
    expect(beat.rows[0]?.age).toBeLessThan(5);
  });

  it("dừng êm: chờ handler đang chạy xong, ngừng nhận việc mới, đóng sạch mọi kết nối", async () => {
    expect(await appConnections()).toBeGreaterThan(0);
    const slowId = await addOutbox("test.slow");
    await waitFor(() => slowStarted);
    const t0 = Date.now();
    const down = w.shutdown();
    // Tín hiệu dừng ⇒ pg-boss ngừng lấy job NGAY: job đến sau tín hiệu (gửi thẳng vào queue) không được nhận.
    await new Promise((r) => setTimeout(r, 200));
    const sender = new PgBoss({
      connectionString: t.adminUrl,
      schema: "pgboss",
      supervise: false,
      schedule: false,
    });
    sender.on("error", () => {});
    await sender.start();
    const lateJobId = await sender.send("test.ping", { outbox_id: randomUUID(), organization_id: A.orgId });
    await sender.stop({ graceful: false });
    await down;
    // handler chậm (1,5 s) đã hoàn tất TRƯỚC khi shutdown trả về
    expect(slowFinished).toBe(true);
    const lateJob = await sql<{
      state: string;
    }>`select state from pgboss.job where id = ${lateJobId}`.execute(t.admin);
    expect(lateJob.rows[0]?.state).toBe("created"); // chưa ai nhận
    expect(Date.now() - t0).toBeLessThan(15_000);
    const state = await sql<{
      state: string;
    }>`select state from pgboss.job where name = 'test.slow' and data->>'outbox_id' = ${slowId}`.execute(
      t.admin,
    );
    expect(state.rows[0]?.state).toBe("completed");
    expect(cap.lines.some((l) => l.msg === "worker.stopped")).toBe(true);

    // đóng sạch: không còn kết nối app_worker/app_runtime
    await waitFor(async () => (await appConnections()) === 0, 5_000);

    // ngừng nhận: sự kiện mới không còn được relay; gọi lại shutdown an toàn
    const late = await addOutbox("test.ping");
    await new Promise((r) => setTimeout(r, 600));
    expect(await published(late)).toBe(false);
    await w.shutdown();
  });
});

/** Chạy `node src/index.ts` như tiến trình thật; trả stdout/stderr + mã thoát. `onLine` được gọi mỗi dòng stdout. */
function runProcess(
  env: Record<string, string | undefined>,
  onLine: (line: string, child: ReturnType<typeof spawn>) => void = () => {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, ...env },
    });
    let out = "";
    let err = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d;
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        onLine(buf.slice(0, i), child);
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tiến trình worker không thoát kịp\n${out}\n${err}`));
    }, 45_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

describe("tiến trình thật (node src/index.ts)", () => {
  it("thiếu biến → thoát ≠ 0, stderr nêu tên biến, không in giá trị bí mật", async () => {
    const env = envOf();
    const r = await runProcess({ ...env, WORKER_DATABASE_URL: "", S3_ENDPOINT: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("WORKER_DATABASE_URL");
    expect(r.err).toContain("S3_ENDPOINT");
    for (const secret of [env.S3_SECRET_ACCESS_KEY, env.BETTER_AUTH_SECRET, env.DATABASE_URL]) {
      expect(r.err + r.out).not.toContain(secret as string);
    }
  });

  it("SIGTERM → dừng êm, đóng sạch, thoát 0", async () => {
    const r = await runProcess(envOf(), (line, child) => {
      if (line.includes('"worker.started"')) child.kill("SIGTERM");
    });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.out).toContain('"worker.stopping"');
    expect(r.out).toContain('"worker.stopped"');
    expect(await appConnections()).toBe(0);
  });
});
