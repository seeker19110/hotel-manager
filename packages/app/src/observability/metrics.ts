// PLAN đợt 3 T-225 — `/api/metrics` (Prometheus text exposition 0.0.4) + `/api/ready` (D-021). Thuần, trừ phần đọc CSDL.
// - Chỉ nội bộ: Bearer token dẫn xuất HKDF từ BETTER_AUTH_SECRET (không thêm bí mật mới; RUNBOOK §Quan sát hướng dẫn lấy
//   token). So sánh thời gian hằng; sai/thiếu ⇒ 401 không nói gì thêm. Khi chạy thật: chặn thêm ở reverse proxy/mạng nội bộ.
// - Số liệu chỉ tổng hợp toàn hệ thống (không nhãn tổ chức) — `app.metrics_snapshot`.
import { hkdfSync, timingSafeEqual } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { httpMetrics } from "./http-metrics.ts";

export interface Sample {
  name: string;
  labels?: Readonly<Record<string, string>>;
  value: number;
}

const HELP: Readonly<Record<string, [type: "gauge" | "counter" | "histogram", help: string]>> = {
  hm_up: ["gauge", "Ứng dụng đang trả lời (1)."],
  hm_outbox_unpublished: ["gauge", "Số sự kiện outbox chưa phát."],
  hm_outbox_oldest_unpublished_age_seconds: [
    "gauge",
    "Tuổi (giây) sự kiện outbox chưa phát cũ nhất — độ trễ relay.",
  ],
  hm_outbox_failing: ["gauge", "Sự kiện outbox chưa phát đã thử ít nhất một lần."],
  // Giá trị là SỐ HÀNG đang ở trạng thái dead (có thể giảm khi hàng được xử lý/dọn) ⇒ gauge, không phải counter. Giữ nguyên
  // tên (đuôi `_total` sai quy ước) để không vỡ `deploy/prometheus/alerts.yml`; đổi tên làm cùng lúc với luật cảnh báo.
  notification_dead_total: ["gauge", "Số lần gửi email đang ở trạng thái dead (đã hết lượt thử)."],
  hm_notification_deliveries: ["gauge", "Lần gửi email theo trạng thái."],
  hm_export_jobs: ["gauge", "Job xuất dữ liệu theo trạng thái."],
  hm_holds_expired_total: ["counter", "Giữ chỗ đã hết hạn tự nhả."],
  hm_holds_active: ["gauge", "Giữ chỗ đang hiệu lực."],
  hm_jobs_failed: ["gauge", "Job pg-boss ở trạng thái failed."],
  hm_dead_letter_jobs: [
    "gauge",
    "Job còn nằm trong queue outbox.dead_letter (hết lượt thử hoặc lỗi vĩnh viễn, chưa redrive).",
  ],
  hm_worker_heartbeat_age_seconds: ["gauge", "Tuổi (giây) nhịp gần nhất của từng worker."],
  hm_metrics_db_ok: ["gauge", "1 nếu đọc được số liệu nghiệp vụ từ CSDL lượt scrape này, 0 nếu CSDL lỗi."],
  hm_reconciliation_breaks_open: ["gauge", "Chênh lệch đối soát đang mở (IND-FIN-006)."],
  hm_reconciliation_breaks_oldest_open_age_seconds: [
    "gauge",
    "Tuổi (giây) chênh lệch đối soát đang mở cũ nhất — so với SLA xử lý.",
  ],
  // HTTP (T-406, observability/http-metrics.ts): đo ở lớp handler, lưu trong bộ nhớ từng bản web.
  hm_http_requests_total: ["counter", "Số request HTTP theo mẫu route, method, status."],
  hm_http_request_duration_seconds: [
    "histogram",
    "Thời gian xử lý request HTTP (giây) theo mẫu route, method, status.",
  ],
};

/** `x_bucket`/`x_sum`/`x_count` của histogram `x` dùng chung một HELP/TYPE ở tên gốc. */
function baseName(name: string): string {
  const m = /^(.*)_(?:bucket|sum|count)$/.exec(name);
  return m?.[1] !== undefined && HELP[m[1]]?.[0] === "histogram" ? m[1] : name;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Number.POSITIVE_INFINITY) return "+Inf";
  if (v === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(v);
}

/** Văn bản Prometheus: nhóm theo tên, mỗi nhóm một HELP/TYPE; tên/nhãn sai dạng bị bỏ (không làm hỏng cả trang). */
export function renderPrometheus(samples: readonly Sample[]): string {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!NAME.test(s.name)) continue;
    const base = baseName(s.name);
    const g = groups.get(base) ?? [];
    g.push(s);
    groups.set(base, g);
  }
  const out: string[] = [];
  for (const [name, list] of groups) {
    const [type, help] = HELP[name] ?? ["gauge", name];
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const s of list) {
      const labels = Object.entries(s.labels ?? {}).filter(([k]) => LABEL.test(k));
      const l = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : "";
      out.push(`${s.name}${l} ${formatValue(s.value)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** Token đọc metrics, dẫn xuất từ bí mật phiên (đổi bí mật ⇒ đổi token). */
export function metricsToken(secret: string): string {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hm-metrics-v1", 32)).toString("base64url");
}

/** `Authorization: Bearer <token>` đúng ⇒ true (so sánh thời gian hằng). */
export function metricsAuthorized(header: string | null, secret: string): boolean {
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header?.trim() ?? "");
  if (!m) return false;
  const want = Buffer.from(metricsToken(secret));
  const got = Buffer.from(m[1] as string);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Đọc số liệu từ CSDL (một câu, một snapshot). */
export async function collectMetrics(db: Kysely<unknown>, now: Date = new Date()): Promise<Sample[]> {
  type Row = { name: string; labels: Record<string, string>; value: number };
  const r = await sql<Row>`select name, labels, value from app.metrics_snapshot(${now})`.execute(db);
  // Đối soát (0050) ở hàm riêng để không đè `metrics_snapshot` (0046).
  const rec = await sql<Row>`select name, labels, value from app.reconciliation_metrics(${now})`.execute(db);
  // Hàm riêng (0047): số job nằm trong dead letter — cảnh báo `HmDeadLetterJobs` (BE-JOB-004).
  const dead = await sql<{ n: string }>`select app.dead_letter_jobs()::text as n`.execute(db);
  return [
    { name: "hm_up", value: 1 },
    ...[...r.rows, ...rec.rows].map((x) => ({
      name: x.name,
      labels: x.labels ?? {},
      value: Number(x.value),
    })),
    { name: "hm_dead_letter_jobs", value: Number(dead.rows[0]?.n ?? 0) },
  ];
}

export interface ReadyDeps {
  /** Tiến trình đang dừng êm (SIGTERM): trả 503 NGAY, không chạy các kiểm tra — để bộ cân bằng tải rút instance (T-402). */
  draining?: () => boolean;
  db: Kysely<unknown>;
  storage: { ping(): Promise<void> };
  scanner: { scan(bytes: Uint8Array): Promise<unknown> };
}

export type CheckResult = "ok" | "fail" | "timeout";

async function within(ms: number, fn: () => Promise<unknown>): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      fn().then(() => "ok" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
    return r;
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

/** `/api/ready`: CSDL + kho object + máy quét; không trả chi tiết lỗi (chỉ tên thành phần + ok/fail/timeout). */
export async function readiness(
  deps: ReadyDeps,
  timeoutMs = 3000,
): Promise<{ ready: boolean; checks: Record<"database" | "storage" | "scanner", CheckResult> }> {
  const [database, storage, scanner] = await Promise.all([
    within(timeoutMs, () => sql`select 1`.execute(deps.db)),
    within(timeoutMs, () => deps.storage.ping()),
    within(timeoutMs, () => deps.scanner.scan(new TextEncoder().encode("hm-ready-probe"))),
  ]);
  const checks = { database, storage, scanner };
  return { ready: Object.values(checks).every((c) => c === "ok"), checks };
}

const noStore = { "cache-control": "no-store" };

/**
 * GET /api/health — liveness (OPS-OBS-006): TĨNH, không gọi CSDL/kho/máy quét/cấu hình, không nhận phụ thuộc nào. Chỉ nói tiến
 * trình còn trả lời; orchestrator dùng để khởi động lại tiến trình treo, KHÔNG dùng để chọn bản nhận tải (đó là `/api/ready`).
 */
export function handleHealth(): Response {
  return Response.json({ status: "ok" }, { headers: noStore });
}

/** GET /api/metrics. */
export async function handleMetrics(
  req: Request,
  deps: { db: Kysely<unknown>; secret: string },
): Promise<Response> {
  if (!metricsAuthorized(req.headers.get("authorization"), deps.secret))
    return new Response("unauthorized\n", {
      status: 401,
      headers: { ...noStore, "www-authenticate": "Bearer" },
    });
  // Metric HTTP nằm trong bộ nhớ nên VẪN xuất được khi CSDL chết — đúng lúc SLI khả dụng cần số liệu nhất. CSDL lỗi ⇒ chỉ
  // mất nhóm số liệu nghiệp vụ, `hm_metrics_db_ok 0` báo điều đó (không trả 500 làm mất cả trang scrape).
  let business: Sample[];
  try {
    business = [...(await collectMetrics(deps.db)), { name: "hm_metrics_db_ok", value: 1 }];
  } catch {
    business = [
      { name: "hm_up", value: 1 },
      { name: "hm_metrics_db_ok", value: 0 },
    ];
  }
  const body = renderPrometheus([...business, ...httpMetrics.samples()]);
  return new Response(body, {
    headers: { ...noStore, "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

/** GET /api/ready: 200 khi đủ, 503 khi thiếu — cho load balancer/orchestrator. */
export async function handleReady(deps: ReadyDeps): Promise<Response> {
  if (deps.draining?.()) return Response.json({ status: "draining" }, { status: 503, headers: noStore });
  const r = await readiness(deps);
  return Response.json(
    { status: r.ready ? "ready" : "not_ready", checks: r.checks },
    {
      status: r.ready ? 200 : 503,
      headers: { ...noStore, "content-type": "application/json; charset=utf-8" },
    },
  );
}
