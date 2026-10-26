// Worker chạy thật (PLAN đợt 4 T-301; BASE-CFG-002, ARC-RES-009, BE-REL-004): validate env → mở pool + pg-boss → tạo queue →
// consumer → lịch định kỳ; SIGTERM/SIGINT: ngừng nhận việc → đồng thời abort scheduler + `boss.stop({graceful, timeout})` (một hạn chót) → đóng pool → exit 0.
// `startWorker(deps)` thuần phụ thuộc tiêm vào (test được trên Postgres thật); `bootWorker(env)` dựng phụ thuộc từ cấu hình;
// `main()` (index.ts) nối tiến trình + tín hiệu.
import {
  anonymizeExpiredPeople,
  BANK_TXN_RECEIVED,
  ConfigError,
  createLogger,
  createPool,
  createServices,
  detectOverdue,
  detectOverstay,
  type EmailSender,
  expireHeldReservations,
  FakeEmailSender,
  generatePeriods,
  invitationKey,
  type Logger,
  loadWorkerConfig,
  type ObjectStorage,
  orgPurgeEnabled,
  parseOutboxPayload,
  processDsarRequests,
  purgeDueOrganizations,
  purgeEventTables,
  purgeExpiredOperational,
  remindExpiring,
  runReconciliationDaily,
  runReminders,
  runRetention,
  sendDueEmails,
  unsubscribeKey,
} from "@hm/app";
import { Kysely, PostgresDialect } from "kysely";
import { PgBoss } from "pg-boss";
import {
  bankTransactionReceivedHandler,
  expireExportsJob,
  expireHolds,
  exportHandlers,
  invitationHandlers,
  notifyHandlers,
  workerHeartbeat,
} from "./jobs.ts";
import { ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";
import { type ScheduledJob, startScheduler } from "./scheduler.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Khoảng giữa hai lượt của từng job (ms). Ghi đè được (test dùng giá trị nhỏ). */
export interface Intervals {
  relay: number;
  heartbeat: number;
  emails: number;
  holds: number;
  reminders: number;
  periods: number;
  lease: number;
  /** Lượt ở quá giờ trả chưa check-out → ngoại lệ STAY_OVERSTAY (SPEC-inventory S-017). */
  overdue: number;
  exports: number;
  retention: number;
  /** Dọn bảng sự kiện (outbox đã phát, idempotency hết hạn, lần gửi thông báo đã xong; T-505). */
  eventsRetention: number;
  /** Hạn lưu dữ liệu cá nhân/vận hành còn lại: xoá thông báo/phiên/mã xác minh/liên kết khách/nhịp worker, ẩn danh giấy tờ + người (T-2308). */
  privacyRetention: number;
  /** Đối soát hằng ngày (IND-FIN-006). */
  reconciliation: number;
  /** Yêu cầu quyền chủ thể: xuất dữ liệu, xoá tài khoản, dọn gói hết hạn (T-2311; hạn VN ngắn nhất 3 ngày). */
  dsar: number;
  /** Purge tổ chức đã quá 30 ngày giữ (T-2312, D-125) — hằng ngày. */
  orgPurge: number;
}

export const DEFAULT_INTERVALS: Intervals = {
  relay: 2 * SECOND,
  heartbeat: 30 * SECOND, // RUNBOOK: cảnh báo khi nhịp > 120 giây
  emails: 15 * SECOND,
  holds: MINUTE,
  reminders: 15 * MINUTE, // nhắc lưu trú cần nhịp 15 phút; quá hạn/hợp đồng chạy cùng nhịp, dedupe giữ không lặp
  periods: HOUR,
  lease: HOUR,
  overdue: 15 * MINUTE, // ngưỡng quá hạn mặc định 60 phút (Q-03): nhịp 15 phút đủ sát
  exports: 5 * MINUTE,
  retention: 24 * HOUR,
  eventsRetention: HOUR, // xoá theo lô có trần; tồn đọng lớn được dọn dần qua các lượt
  privacyRetention: 24 * HOUR, // hạn tính theo ngày/tháng — hằng ngày là đủ; tồn đọng dọn dần qua các lượt
  reconciliation: 24 * HOUR,
  dsar: 2 * MINUTE, // hạn trả lời tính theo ngày; nhịp vài phút để người dùng nhận gói/xoá xong gần như ngay
  orgPurge: 24 * HOUR, // hạn giữ tính theo ngày (30 ngày) — hằng ngày là đủ
};

export const DEFAULT_STOP_TIMEOUT_MS = 25_000;
const RELAY_BATCH = 100;
/** Một lượt relay xả tối đa chừng này lô liên tiếp rồi nhường (tránh độc chiếm khi outbox đầy). */
const RELAY_MAX_ROUNDS = 20;

export interface WorkerDeps {
  /** Kết nối vai trò app_worker. */
  workerDb: Kysely<unknown>;
  /** Kết nối vai trò app_runtime — export đọc dữ liệu trong ngữ cảnh người yêu cầu (RLS). */
  db: Kysely<unknown>;
  /** Chưa `start()` — startWorker sẽ start. */
  boss: PgBoss;
  storage: ObjectStorage;
  /** null = chưa có adapter gửi thật (SMTP): KHÔNG chạy vòng gửi để không đốt lượt thử của thông báo. */
  sender: EmailSender | null;
  log: Logger;
  baseUrl: string;
  unsubscribeKey: Buffer;
  /** Khoá dựng token lời mời nhân viên (`invitationKey(BETTER_AUTH_SECRET)`) — consumer `member.invited`. */
  invitationKey: Buffer;
  /** Tên ghi ở `worker_heartbeats` (khớp `^[a-z0-9][a-z0-9._-]{0,62}$`). */
  name?: string;
  /** Handler bổ sung cho event_type khác (mở rộng/test); trùng tên với handler sẵn có thì handler này thắng. */
  extraHandlers?: Readonly<Record<string, (job: OutboxJob) => Promise<unknown>>>;
  intervals?: Partial<Intervals>;
  /** Trần chờ job/handler đang chạy khi dừng (ms). */
  stopTimeoutMs?: number;
  pollingIntervalSeconds?: number;
  /** Trì hoãn lượt đầu của job hạn giữ (ms) — test đặt 0. */
  retentionInitialDelayMs?: number;
  /**
   * Bật job `tenancy.purge` (xoá cứng tổ chức quá hạn giữ — T-2312, D-125). `bootWorker` đặt theo `orgPurgeEnabled(NODE_ENV)`:
   * TẮT ở production (grant `data_delete hard_delete=false` — bật cần người + grant, RUNBOOK), bật ở dev/test. Bỏ trống = tắt.
   */
  orgPurge?: boolean;
}

export interface WorkerHandle {
  /** Dừng êm: ngừng nhận (scheduler + pg-boss, song song) → chờ việc đang chạy tới MỘT hạn chót chung → đóng pool pg-boss. KHÔNG đóng pool của người gọi. Gọi lại trả cùng promise. */
  stop(): Promise<void>;
  /** Tập event_type có consumer. */
  readonly eventTypes: readonly string[];
}

/** Chạy lần lượt các bước; một bước lỗi không chặn bước sau, hết lượt mới ném. */
async function sequence(steps: readonly (() => Promise<unknown>)[]): Promise<unknown[]> {
  const out: unknown[] = [];
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      out.push(await step());
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length}/${steps.length} bước lỗi`);
  return out;
}

async function withTimeout(p: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => "done" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startWorker(deps: WorkerDeps): Promise<WorkerHandle> {
  const { workerDb, db, boss, storage, log } = deps;
  const name = deps.name ?? "worker";
  const iv = { ...DEFAULT_INTERVALS, ...deps.intervals };
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  // Handler của pg-boss: validate payload theo event_type TRƯỚC khi chạy (BE-JOB-007; sai ⇒ lỗi vĩnh viễn, dead letter
  // ngay); lỗi được log rồi ném lại — `startConsumers` phân loại: vĩnh viễn ⇒ dead letter không retry, còn lại ⇒ pg-boss
  // retry/dead letter theo chính sách queue.
  const wrap =
    (type: string, h: (job: OutboxJob) => Promise<unknown>) =>
    async (job: OutboxJob): Promise<void> => {
      try {
        parseOutboxPayload(type, job.payload);
        await h(job);
      } catch (err) {
        log.error("job.handler_failed", { event_type: type, outbox_id: job.outbox_id, error: err });
        throw err;
      }
    };
  const raw: Record<string, (job: OutboxJob) => Promise<unknown>> = {
    ...notifyHandlers(workerDb, log.child({ component: "notify.dispatch" })),
    ...exportHandlers({ db, workerDb, storage }),
    // Không có bộ gửi ⇒ không có consumer: relay giữ sự kiện chưa phát (`no_consumer`) tới khi có bộ gửi, không mất lời mời.
    ...(deps.sender
      ? invitationHandlers(
          workerDb,
          deps.sender,
          {
            key: deps.invitationKey,
            baseUrl: deps.baseUrl,
            // Hết ngân sách email ngày ⇒ xếp lại job tới đầu ngày UTC kế (không vào dead letter) — OPS-COST-004.
            requeue: async (job, startAfter, id) => {
              await boss.send("member.invited", job, { id, startAfter, group: { id: job.organization_id } });
            },
          },
          log.child({ component: "member.invitation" }),
        )
      : {}),
    [BANK_TXN_RECEIVED]: bankTransactionReceivedHandler(workerDb),
    ...deps.extraHandlers,
  };
  const handlers = Object.fromEntries(Object.entries(raw).map(([t, h]) => [t, wrap(t, h)]));
  const eventTypes = Object.keys(handlers);
  const consumed = new Set(eventTypes);

  boss.on("error", (err) => log.error("pgboss.error", { error: err }));
  await boss.start();
  await ensureQueues(boss, eventTypes);
  await startConsumers(boss, handlers, {
    pollingIntervalSeconds: deps.pollingIntervalSeconds ?? 2,
    log: (e, f) => log.warn(e, f),
  });

  const ac = new AbortController();
  const jobs: ScheduledJob[] = [
    {
      name: "outbox.relay",
      everyMs: iv.relay,
      run: async () => {
        let total = 0;
        for (let round = 0; round < RELAY_MAX_ROUNDS && !ac.signal.aborted; round++) {
          const n = await relayOutbox(workerDb, boss, RELAY_BATCH, {
            consumed,
            log: (e, f) => log.warn(e, f),
          });
          total += n;
          if (n < RELAY_BATCH) break;
        }
        return total;
      },
    },
    { name: "worker.heartbeat", everyMs: iv.heartbeat, run: () => workerHeartbeat(workerDb, name) },
    {
      name: "inventory.expire_holds",
      everyMs: iv.holds,
      run: () =>
        sequence([
          () => expireHolds(workerDb, new Date()),
          () => expireHeldReservations(workerDb, new Date()),
        ]),
    },
    { name: "notifications.reminders", everyMs: iv.reminders, run: () => runReminders(workerDb, new Date()) },
    {
      name: "billing.generate_periods",
      everyMs: iv.periods,
      run: () => generatePeriods(workerDb, new Date()),
    },
    {
      name: "lease.daily",
      everyMs: iv.lease,
      run: () =>
        sequence([() => remindExpiring(workerDb, new Date()), () => detectOverstay(workerDb, new Date())]),
    },
    { name: "inventory.detect_overdue", everyMs: iv.overdue, run: () => detectOverdue(workerDb, new Date()) },
    { name: "exports.expire", everyMs: iv.exports, run: expireExportsJob(workerDb) },
    {
      // Hằng ngày: break đối soát mở quá SLA + sổ cái trôi (IND-FIN-006). Chạy lại bao nhiêu lần/ngày vẫn một hiệu lực.
      name: "reconciliation.daily",
      everyMs: iv.reconciliation,
      run: () => runReconciliationDaily(workerDb, new Date(), { log: (e, f) => log.error(e, f) }),
    },
    {
      name: "import.retention",
      everyMs: iv.retention,
      initialDelayMs: deps.retentionInitialDelayMs ?? MINUTE,
      run: () => runRetention(workerDb, storage, { now: new Date(), log: (e, f) => log.info(e, f) }),
    },
    {
      // Bảng sự kiện theo chính sách hạn giữ (docs/ops/retention-policy.md). Xoá theo lô qua hàm SECURITY DEFINER; an toàn khi
      // nhiều worker chạy song song (SKIP LOCKED) và khi chạy lại (idempotent).
      name: "events.retention",
      everyMs: iv.eventsRetention,
      initialDelayMs: deps.retentionInitialDelayMs ?? MINUTE,
      run: () => purgeEventTables(workerDb, { now: new Date(), log: (e, f) => log.info(e, f) }),
    },
    {
      // Hạn lưu D-116/D-118 (docs/ops/retention-policy.md RET-11…RET-17, RET-19): xoá dữ liệu vận hành + sự kiện analytics quá hạn, rồi ẩn danh giấy tờ → người.
      // Hai nhóm độc lập (`sequence`): nhóm này lỗi không chặn nhóm kia; trong mỗi nhóm một bảng lỗi không chặn bảng khác.
      name: "privacy.retention",
      everyMs: iv.privacyRetention,
      initialDelayMs: deps.retentionInitialDelayMs ?? MINUTE,
      run: () =>
        sequence([
          () => purgeExpiredOperational(workerDb, { now: new Date(), log: (e, f) => log.info(e, f) }),
          () => anonymizeExpiredPeople(workerDb, { now: new Date(), log: (e, f) => log.info(e, f) }),
        ]),
    },
    {
      // Quyền chủ thể (D-123): xử lý yêu cầu truy cập/xoá đến hạn (SKIP LOCKED — nhiều worker an toàn), rồi dọn gói hết hạn.
      // Tắt (đường lùi D-123): bỏ mục này; yêu cầu nằm lại `verified` và metric hm_dsar_overdue báo khi quá hạn.
      name: "privacy.dsar",
      everyMs: iv.dsar,
      run: () =>
        processDsarRequests(workerDb, {
          storage,
          log: (e, f) => log.info(e, f),
        }),
    },
    ...(deps.orgPurge
      ? [
          {
            // Vòng đời xoá tổ chức (D-125): object kho TRƯỚC, rồi `app.purge_organization` (mọi bảng + chứng nhận). Đường lùi: tắt
            // (`orgPurge: false`) — tổ chức nằm lại `pending_deletion` (vẫn bị khoá, huỷ được), gauge hm_org_pending_deletion{state="due"} báo.
            name: "tenancy.purge",
            everyMs: iv.orgPurge,
            initialDelayMs: deps.retentionInitialDelayMs ?? MINUTE,
            run: () => purgeDueOrganizations(workerDb, { storage, log: (e, f) => log.info(e, f) }),
          } satisfies ScheduledJob,
        ]
      : []),
  ];
  const sender = deps.sender;
  if (sender) {
    jobs.push({
      name: "notifications.send_due",
      everyMs: iv.emails,
      run: () =>
        sendDueEmails(workerDb, sender, {
          now: new Date(),
          baseUrl: deps.baseUrl,
          unsubscribeKey: deps.unsubscribeKey,
          log: (e, f) => log.info(e, f),
        }),
    });
  } else {
    log.warn("email.sender_unavailable", { reason: "chưa có adapter SMTP — bỏ vòng gửi email (D-010)" });
  }
  const scheduler = startScheduler(jobs, { signal: ac.signal, log });
  log.info("worker.started", { name, queues: eventTypes.length, jobs: jobs.map((j) => j.name) });

  let stopping: Promise<void> | undefined;
  return {
    eventTypes,
    stop() {
      stopping ??= (async () => {
        // MỘT hạn chót chung (`stopTimeoutMs`) cho cả hai việc, chạy SONG SONG — tín hiệu dừng là ngừng nhận việc mới ngay:
        //  a) scheduler: abort ⇒ không lượt mới; lượt đang chạy làm nốt tới hạn chót;
        //  b) pg-boss: ngừng lấy job mới + chờ handler đang chạy tới hạn chót; `close: false` để giữ pool cho relay còn dở
        //     (nó còn `boss.send`).
        // Sau cùng mới đóng pool của boss; pool CSDL của worker do `bootWorker().shutdown()` đóng sau `stop()` này.
        ac.abort();
        const [sched, quiesce] = await Promise.allSettled([
          withTimeout(scheduler.stopped, stopTimeoutMs),
          boss.stop({ graceful: true, close: false, timeout: stopTimeoutMs }),
        ]);
        if (sched.status === "fulfilled" && sched.value === "timeout") {
          log.warn("worker.stop_timeout", { stage: "scheduler", timeout_ms: stopTimeoutMs });
        }
        // Đóng pool boss kể cả khi bước (b) lỗi; đã dừng rồi thì chỉ đóng pool, chưa thì dừng cưỡng bức.
        await boss.stop({ graceful: false, close: true, timeout: 1000 });
        if (quiesce.status === "rejected") throw quiesce.reason;
        log.info("worker.stopped", { name });
      })();
      return stopping;
    },
  };
}

export interface RunningWorker {
  handle: WorkerHandle;
  /** Dừng êm rồi đóng mọi pool. Gọi lại an toàn. */
  shutdown(): Promise<void>;
}

export interface BootOptions {
  log?: Logger;
  intervals?: Partial<Intervals>;
  stopTimeoutMs?: number;
  pollingIntervalSeconds?: number;
  retentionInitialDelayMs?: number;
  extraHandlers?: WorkerDeps["extraHandlers"];
  /** Thay bộ gửi email (test). Mặc định: `fake://…` → FakeEmailSender; `smtp(s)://…` → null (chưa có adapter). */
  sender?: EmailSender | null;
  /** Ghi đè bật/tắt job `tenancy.purge` (mặc định theo NODE_ENV — `orgPurgeEnabled`). Tuỳ chọn runtime, không phải biến môi trường. */
  orgPurge?: boolean;
}

/** Dựng worker từ env: ConfigError nếu thiếu/sai biến (nêu tên, không giá trị). */
export async function bootWorker(
  env: Record<string, string | undefined>,
  opts: BootOptions = {},
): Promise<RunningWorker> {
  const cfg = loadWorkerConfig(env); // ném ConfigError trước khi mở bất kỳ kết nối nào
  const config = cfg.app;
  const log = opts.log ?? createLogger({ level: config.LOG_LEVEL, bindings: { service: "worker" } });
  const onError = (err: Error) => log.warn("pool.idle_error", { error: err });
  const workerPool = createPool(cfg.workerDatabaseUrl, { max: 10, onError });
  const runtimePool = createPool(config.DATABASE_URL, { max: 5, onError });
  const workerDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: workerPool }) });
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: runtimePool }) });
  const boss = new PgBoss({
    connectionString: cfg.workerDatabaseUrl,
    schema: "pgboss",
    // Schema do migration 0047 tạo sẵn cho app_worker (D-024); vai trò worker không có CREATE trên CSDL.
    createSchema: false,
    application_name: "hm-worker-boss",
    max: 5,
  });
  const closePools = async () => {
    await Promise.allSettled([workerDb.destroy(), db.destroy()]);
  };
  let handle: WorkerHandle;
  try {
    handle = await startWorker({
      workerDb,
      db,
      boss,
      storage: createServices(config).storage,
      sender:
        // biome-ignore lint/nursery/useNullishCoalescing: opts.sender null = chủ ý tắt gửi thư, undefined = tự chọn theo cấu hình — `??` sẽ gộp hai trường hợp (BASE-DATA-003)
        opts.sender !== undefined
          ? opts.sender
          : config.SMTP_URL.startsWith("fake://")
            ? new FakeEmailSender()
            : null,
      log,
      baseUrl: config.APP_BASE_URL,
      unsubscribeKey: unsubscribeKey(config.BETTER_AUTH_SECRET),
      invitationKey: invitationKey(config.BETTER_AUTH_SECRET),
      // Tên nhịp cố định (không theo hostname): container khởi động lại đổi hostname sẽ để lại hàng nhịp cũ → cảnh báo treo giả.
      ...(opts.extraHandlers ? { extraHandlers: opts.extraHandlers } : {}),
      ...(opts.intervals ? { intervals: opts.intervals } : {}),
      ...(opts.stopTimeoutMs !== undefined ? { stopTimeoutMs: opts.stopTimeoutMs } : {}),
      ...(opts.pollingIntervalSeconds !== undefined
        ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
        : {}),
      ...(opts.retentionInitialDelayMs !== undefined
        ? { retentionInitialDelayMs: opts.retentionInitialDelayMs }
        : {}),
      orgPurge: orgPurgeEnabled(config.NODE_ENV, opts.orgPurge),
    });
  } catch (err) {
    // Khởi động dở (DB không tới, thiếu quyền tạo schema pgboss…): dọn những gì đã mở rồi báo lỗi.
    await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
    await closePools();
    throw err;
  }
  let down: Promise<void> | undefined;
  return {
    handle,
    shutdown() {
      down ??= (async () => {
        try {
          await handle.stop();
        } finally {
          await closePools();
        }
      })();
      return down;
    },
  };
}

/** Phần của `process` mà worker dùng — tách để test bằng bản giả. */
export interface ProcessLike {
  env: Record<string, string | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  exit(code: number): unknown;
  stderr: { write(s: string): unknown };
}

/**
 * SIGTERM/SIGINT lần đầu → `shutdown()` (êm) rồi exit 0 (lỗi → exit 1); lần thứ hai → exit 1 NGAY. Đồng hồ canh: quá
 * `stopTimeoutMs + 10 s` mà chưa xong thì exit 1 (không treo mãi dưới orchestrator). Hạn chót tổng của `stop()` là `stopTimeoutMs`
 * (+ thời gian đóng pool), nên đồng hồ canh luôn muộn hơn nó.
 */
export function installShutdown(
  proc: ProcessLike,
  shutdown: () => Promise<void>,
  log: Logger,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): void {
  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    if (signals > 1) {
      log.warn("worker.force_exit", { signal });
      proc.exit(1);
      return;
    }
    log.info("worker.stopping", { signal });
    setTimeout(() => {
      log.error("worker.shutdown_watchdog", { timeout_ms: stopTimeoutMs + 10_000 });
      proc.exit(1);
    }, stopTimeoutMs + 10_000).unref();
    shutdown().then(
      () => proc.exit(0),
      (err) => {
        log.error("worker.shutdown_failed", { error: err });
        proc.exit(1);
      },
    );
  };
  proc.on("SIGTERM", () => onSignal("SIGTERM"));
  proc.on("SIGINT", () => onSignal("SIGINT"));
}

/**
 * Điểm vào tiến trình. Bộ xử lý tín hiệu được cài TRƯỚC khi khởi động: SIGTERM đến giữa lúc đang mở kết nối vẫn dừng êm
 * (đợi khởi động xong rồi dừng) thay vì bị hệ điều hành giết ngang. Lỗi khởi động → exit 1.
 */
export async function runMain(proc: ProcessLike, opts: BootOptions = {}): Promise<void> {
  const fatal = createLogger({
    sink: { write: (l) => proc.stderr.write(`${l}\n`) },
    bindings: { service: "worker" },
  });
  const booting = bootWorker(proc.env, opts);
  // Tránh "unhandled rejection" nếu khởi động lỗi trong lúc chưa ai await (xử lý thật ở try/catch bên dưới).
  booting.catch(() => {});
  installShutdown(
    proc,
    async () => {
      const worker = await booting.catch(() => undefined);
      await worker?.shutdown();
    },
    opts.log ?? createLogger({ bindings: { service: "worker" } }),
    opts.stopTimeoutMs,
  );
  try {
    await booting;
    const crash = (err: unknown) => {
      fatal.error("worker.crashed", { error: err });
      proc.exit(1);
    };
    proc.on("uncaughtException", crash);
    proc.on("unhandledRejection", crash);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Chỉ tên biến + lý do (ConfigError không chứa giá trị).
      proc.stderr.write(`worker: ${err.message}\n`);
    } else {
      fatal.error("worker.start_failed", { error: err });
    }
    proc.exit(1);
  }
}
