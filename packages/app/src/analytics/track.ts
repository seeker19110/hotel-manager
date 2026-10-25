// `track()` — ĐIỂM GỬI DUY NHẤT của analytics sản phẩm (PLAN T-2309; PM-METRIC-003/005/006; D-118). Tự host: ghi `product_events`
// (migration 0067) bằng chính kết nối/transaction của lệnh gọi — không SDK, không cookie, không gửi ra ngoài.
// Thứ tự (cố ý): (1) kiểm hợp lệ TRƯỚC — kể cả khi chưa có đồng ý — để lỗi lập trình lộ ngay ở test dù mặc định không ghi;
// (2) kiểm đồng ý cho mục đích analytics; (3) ghi.
// - Đồng ý: bộ kiểm đồng ý được tiêm (`configureAnalytics({ consent })` hoặc `opts.consent`); MẶC ĐỊNH TỪ CHỐI ⇒ sự kiện bị bỏ,
//   trả `{ status: "dropped", reason: "no_consent" }`, không lỗi (T-2310 nối `consent_records`). Bộ kiểm ném lỗi ⇒ coi như không đồng ý.
// - Không làm hỏng lệnh nghiệp vụ: `track` gọi trong transaction của lệnh. Ghi bằng SAVEPOINT riêng nên lỗi ghi (RLS, ràng buộc,
//   mất kết nối cục bộ) KHÔNG làm transaction của lệnh rơi vào trạng thái "aborted". Lỗi kiểm hợp lệ/ghi là lỗi LẬP TRÌNH:
//   · dev/test (`NODE_ENV` ≠ production, hoặc `strict: true`): ném `AnalyticsValidationError`/lỗi CSDL để test đỏ ngay;
//   · production: ghi log cảnh báo (chỉ tên sự kiện + mã lỗi, KHÔNG giá trị payload), bỏ sự kiện, trả `dropped` — lệnh nghiệp vụ
//     tiếp tục. Sự kiện bị bỏ vì lỗi nghĩa là số đo thiếu, không phải dữ liệu sai.
// - Sự kiện nằm cùng transaction của lệnh ⇒ lệnh rollback thì sự kiện cũng rollback (không đo hành động chưa xảy ra).
import { randomUUID } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import { appLogger } from "../logging/index.ts";
import { EVENTS, type EventName, type EventRegistry } from "./events.ts";
import { AnalyticsValidationError, assertRegistrySafe, isUuid, validateEvent } from "./validate.ts";

// Registry sai (khoá PII, tên lạ…) là lỗi lập trình: nạp module là ném, không đợi tới lúc phát sự kiện.
assertRegistrySafe(EVENTS);

export type AnalyticsDb = Kysely<unknown> | Transaction<unknown>;

export interface TrackContext {
  /** Kết nối/transaction ĐÃ đặt ngữ cảnh tổ chức (`app.org_id`) — thường `ctx.trx` của lệnh. */
  db: AnalyticsDb;
  organizationId: string;
  propertyId?: string | null;
  /** Id `auth."user"` của người thao tác (ngắt liên kết khi xoá tài khoản — `app.unlink_product_events_actor`). */
  actorUserId?: string | null;
  /** Thời điểm xảy ra; mặc định đồng hồ CSDL. */
  occurredAt?: Date;
}

export interface ConsentQuery {
  organizationId: string;
  actorUserId: string | null;
  purpose: "analytics";
}
export type ConsentCheck = (q: ConsentQuery) => boolean | Promise<boolean>;

export type DropReason = "no_consent" | "invalid" | "write_failed";
export type TrackResult = { status: "recorded"; id: string } | { status: "dropped"; reason: DropReason };

export interface TrackOptions {
  consent?: ConsentCheck;
  /** true = ném lỗi lập trình (mặc định: `NODE_ENV` ≠ production). */
  strict?: boolean;
  /** Registry thay thế (test); mặc định `EVENTS`. */
  registry?: EventRegistry;
  /** Phiên bản schema; mặc định `current` của sự kiện. */
  version?: number;
}

/** Mặc định từ chối: chưa có bộ kiểm đồng ý ⇒ không ghi gì. */
export const denyAllConsent: ConsentCheck = () => false;

let defaults: { consent: ConsentCheck; strict: boolean | undefined } = {
  consent: denyAllConsent,
  strict: undefined,
};

/** Nối bộ kiểm đồng ý thật (T-2310) hoặc ép chế độ; gọi lúc khởi động tiến trình/đầu test. */
export function configureAnalytics(cfg: { consent?: ConsentCheck; strict?: boolean }): void {
  defaults = { consent: cfg.consent ?? defaults.consent, strict: cfg.strict ?? defaults.strict };
}

/** Về mặc định (từ chối mọi đồng ý, chế độ theo `NODE_ENV`) — test dùng để dọn. */
export function resetAnalytics(): void {
  defaults = { consent: denyAllConsent, strict: undefined };
}

const isStrict = (opt: boolean | undefined): boolean =>
  opt ?? defaults.strict ?? process.env.NODE_ENV !== "production";

function checkContext(ctx: TrackContext): void {
  const fail = (field: string): never => {
    throw new AnalyticsValidationError("invalid_context", `track context field "${field}" is invalid`, field);
  };
  if (!isUuid(ctx.organizationId)) fail("organizationId");
  if (ctx.propertyId != null && !isUuid(ctx.propertyId)) fail("propertyId");
  if (ctx.actorUserId != null && !isUuid(ctx.actorUserId)) fail("actorUserId");
  if (ctx.occurredAt !== undefined && Number.isNaN(ctx.occurredAt.getTime())) fail("occurredAt");
}

const isTransaction = (db: AnalyticsDb): boolean =>
  (db as { isTransaction?: boolean }).isTransaction === true;

async function insertEvent(
  db: AnalyticsDb,
  ctx: TrackContext,
  ev: { name: string; version: number; props: Record<string, string | number> },
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into product_events (id, organization_id, property_id, name, schema_version, props, actor_user_id, occurred_at)
    values (${id}, ${ctx.organizationId}, ${ctx.propertyId ?? null}, ${ev.name}, ${ev.version},
            ${JSON.stringify(ev.props)}::jsonb, ${ctx.actorUserId ?? null}, coalesce(${ctx.occurredAt ?? null}::timestamptz, now()))`.execute(
    db,
  );
  return id;
}

/** Ghi trong savepoint: lỗi ghi không để transaction của lệnh gọi rơi vào trạng thái aborted. */
async function writeIsolated(
  db: AnalyticsDb,
  ctx: TrackContext,
  ev: { name: string; version: number; props: Record<string, string | number> },
): Promise<string> {
  if (!isTransaction(db)) return insertEvent(db, ctx, ev);
  await sql`savepoint hm_track`.execute(db);
  try {
    const id = await insertEvent(db, ctx, ev);
    await sql`release savepoint hm_track`.execute(db);
    return id;
  } catch (err) {
    try {
      await sql`rollback to savepoint hm_track`.execute(db);
    } catch (rollbackErr) {
      // Transaction đã hỏng hẳn (mất kết nối…): lỗi gốc mới là thứ cần thấy; chỉ ghi nhận việc lùi savepoint cũng thất bại.
      appLogger().warn("analytics.savepoint_rollback_failed", {
        error: rollbackErr instanceof Error ? rollbackErr.name : "error",
      });
    }
    throw err;
  }
}

/**
 * Gửi một sự kiện đo chỉ số. Không bao giờ làm hỏng lệnh gọi ở production (xem đầu tệp). Trả kết quả để test/giám sát đọc;
 * lệnh nghiệp vụ không cần dùng giá trị trả về.
 */
export async function track(
  name: EventName,
  props: Record<string, unknown>,
  ctx: TrackContext,
  opts: TrackOptions = {},
): Promise<TrackResult> {
  const strict = isStrict(opts.strict);
  const registry = opts.registry ?? EVENTS;
  const log = appLogger();
  let ev: ReturnType<typeof validateEvent>;
  try {
    checkContext(ctx);
    ev = validateEvent(registry, name, props, opts.version);
  } catch (err) {
    if (strict) throw err;
    log.warn("analytics.event_invalid", {
      event: Object.hasOwn(registry, name) ? name : "(unknown)",
      code: err instanceof AnalyticsValidationError ? err.code : "error",
    });
    return { status: "dropped", reason: "invalid" };
  }
  let allowed = false;
  try {
    allowed = await (opts.consent ?? defaults.consent)({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId ?? null,
      purpose: "analytics",
    });
  } catch {
    log.warn("analytics.consent_check_failed", { event: name });
  }
  if (allowed !== true) return { status: "dropped", reason: "no_consent" };
  try {
    return { status: "recorded", id: await writeIsolated(ctx.db, ctx, ev) };
  } catch (err) {
    if (strict) throw err;
    log.warn("analytics.write_failed", { event: name, error: err instanceof Error ? err.name : "error" });
    return { status: "dropped", reason: "write_failed" };
  }
}
