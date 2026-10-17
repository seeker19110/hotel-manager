// PLAN đợt 3 T-225 — `/api/metrics` (Prometheus text exposition 0.0.4) + `/api/ready` (D-021). Thuần, trừ phần đọc CSDL.
// - Chỉ nội bộ: Bearer token dẫn xuất HKDF từ BETTER_AUTH_SECRET (không thêm bí mật mới; RUNBOOK §Quan sát hướng dẫn lấy
//   token). So sánh thời gian hằng; sai/thiếu ⇒ 401 không nói gì thêm. Khi chạy thật: chặn thêm ở reverse proxy/mạng nội bộ.
// - Số liệu chỉ tổng hợp toàn hệ thống (không nhãn tổ chức) — `app.metrics_snapshot`.
import { hkdfSync, timingSafeEqual } from "node:crypto";
import { type Kysely, sql } from "kysely";

export interface Sample {
  name: string;
  labels?: Readonly<Record<string, string>>;
  value: number;
}

const HELP: Readonly<Record<string, [type: "gauge" | "counter", help: string]>> = {
  hm_up: ["gauge", "Ứng dụng đang trả lời (1)."],
  hm_outbox_unpublished: ["gauge", "Số sự kiện outbox chưa phát."],
  hm_outbox_oldest_unpublished_age_seconds: [
    "gauge",
    "Tuổi (giây) sự kiện outbox chưa phát cũ nhất — độ trễ relay.",
  ],
  hm_outbox_failing: ["gauge", "Sự kiện outbox chưa phát đã thử ít nhất một lần."],
  notification_dead_total: ["counter", "Lần gửi email đã hết lượt thử (dead)."],
  hm_notification_deliveries: ["gauge", "Lần gửi email theo trạng thái."],
  hm_export_jobs: ["gauge", "Job xuất dữ liệu theo trạng thái."],
  hm_holds_expired_total: ["counter", "Giữ chỗ đã hết hạn tự nhả."],
  hm_holds_active: ["gauge", "Giữ chỗ đang hiệu lực."],
  hm_jobs_failed: ["gauge", "Job pg-boss ở trạng thái failed."],
  hm_worker_heartbeat_age_seconds: ["gauge", "Tuổi (giây) nhịp gần nhất của từng worker."],
};

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
    const g = groups.get(s.name) ?? [];
    g.push(s);
    groups.set(s.name, g);
  }
  const out: string[] = [];
  for (const [name, list] of groups) {
    const [type, help] = HELP[name] ?? ["gauge", name];
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const s of list) {
      const labels = Object.entries(s.labels ?? {}).filter(([k]) => LABEL.test(k));
      const l = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : "";
      out.push(`${name}${l} ${formatValue(s.value)}`);
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
  const r = await sql<{ name: string; labels: Record<string, string>; value: number }>`
    select name, labels, value from app.metrics_snapshot(${now})`.execute(db);
  return [
    { name: "hm_up", value: 1 },
    ...r.rows.map((x) => ({ name: x.name, labels: x.labels ?? {}, value: Number(x.value) })),
  ];
}

export interface ReadyDeps {
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
  const body = renderPrometheus(await collectMetrics(deps.db));
  return new Response(body, {
    headers: { ...noStore, "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

/** GET /api/ready: 200 khi đủ, 503 khi thiếu — cho load balancer/orchestrator. */
export async function handleReady(deps: ReadyDeps): Promise<Response> {
  const r = await readiness(deps);
  return Response.json(
    { status: r.ready ? "ready" : "not_ready", checks: r.checks },
    { status: r.ready ? 200 : 503, headers: noStore },
  );
}
