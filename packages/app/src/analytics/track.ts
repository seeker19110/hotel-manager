// `track()` — MỘT điểm duy nhất ghi sự kiện sản phẩm (PM-METRIC-003): kiểm schema + PII rồi ghi vào `product_events` (tự host, không SDK,
// không gửi ra ngoài tiến trình). Mọi chỗ khác trong mã không được gọi SDK analytics (rào: scripts/analytics-guard.test.mjs).
//
// Hai loại lỗi, xử lý KHÁC nhau có chủ đích:
//  - Sự kiện/thuộc tính sai (không có trong danh mục, sai schema, tên trường bị cấm, giá trị giống PII, orgId không phải UUID) = LỖI LẬP TRÌNH
//    ⇒ ném `AnalyticsError` TRƯỚC khi chạm CSDL, để test/CI bắt ngay.
//  - Lỗi I/O khi ghi (CSDL mất kết nối, hết hạn, quyền…) = sự cố hạ tầng của tính năng PHỤ ⇒ ghi log cảnh báo (chỉ tên sự kiện và tên lỗi,
//    không PII) rồi nuốt: phân tích sản phẩm không bao giờ được làm hỏng hay làm chậm lệnh nghiệp vụ đã commit.
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { appLogger } from "../logging/index.ts";
import { pseudonymizeActor } from "./actor.ts";
import {
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMAS,
  type EventName,
  type EventProps,
  isEventName,
} from "./events.ts";
import { isBlacklistedField, looksLikePii } from "./pii.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9_]{1,40}$/;

/** Lỗi lập trình của sự kiện. Thông báo KHÔNG chứa giá trị thuộc tính (tránh PII vào log/stack). */
export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsError";
  }
}

const label = (key: string) => (SAFE_KEY.test(key) ? key : "<invalid>");

/** Kiểm sự kiện + thuộc tính; trả thuộc tính đã parse. Ném `AnalyticsError` nếu sai. Thuần, không I/O. */
export function validateEvent<E extends EventName>(event: E, props: unknown): EventProps<E> {
  if (!isEventName(event)) throw new AnalyticsError("analytics: event is not in the allowlist");
  if (props === null || typeof props !== "object" || Array.isArray(props))
    throw new AnalyticsError(`analytics: ${event} props must be an object`);
  for (const [key, value] of Object.entries(props)) {
    if (isBlacklistedField(key))
      throw new AnalyticsError(`analytics: ${event} field "${label(key)}" is blacklisted (PII)`);
    if (looksLikePii(value))
      throw new AnalyticsError(`analytics: ${event} field "${label(key)}" value looks like PII`);
  }
  const parsed = EVENT_SCHEMAS[event].safeParse(props);
  if (!parsed.success) {
    const where = parsed.error.issues.map(
      (i) => `${i.code}@${i.path.map((p) => label(String(p))).join(".")}`,
    );
    throw new AnalyticsError(`analytics: ${event} props do not match schema (${where.join(", ")})`);
  }
  return parsed.data as EventProps<E>;
}

export interface AnalyticsSink {
  /** Kết nối có quyền INSERT `product_events` (app_runtime hoặc app_worker). */
  db: Kysely<unknown>;
  /** Khoá giả danh (`analyticsActorKey(BETTER_AUTH_SECRET)`). */
  actorKey: Buffer;
}

export interface TrackInput<E extends EventName> {
  event: E;
  /** Tổ chức phát sinh sự kiện (RLS + xoá theo tổ chức). */
  orgId: string;
  /** Người dùng đăng nhập (auth user id) — được giả danh; null/undefined = sự kiện hệ thống (không actor). */
  userId?: string | null | undefined;
  props: EventProps<E>;
}

export async function track<E extends EventName>(sink: AnalyticsSink, input: TrackInput<E>): Promise<void> {
  const props = validateEvent(input.event, input.props);
  if (!UUID.test(input.orgId)) throw new AnalyticsError("analytics: orgId is not a UUID");
  const actor = input.userId ? pseudonymizeActor(sink.actorKey, input.userId) : null;
  try {
    await withTenant(sink.db, { orgId: input.orgId }, async (trx) => {
      await sql`
        insert into product_events (organization_id, event, schema_version, actor_key, props)
        values (${input.orgId}, ${input.event}, ${EVENT_SCHEMA_VERSION}, ${actor}, ${JSON.stringify(props)}::jsonb)`.execute(
        trx,
      );
    });
  } catch (err) {
    appLogger().warn("analytics.write_failed", {
      event: input.event,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * Xoá MỌI sự kiện của một người dùng ở mọi tổ chức (ngắt liên kết khi xoá tài khoản — PM-METRIC-006; T-2311 gọi). Chạy qua hàm CSDL
 * `app.forget_analytics_actor` (SECURITY DEFINER, CHỈ app_worker gọi được) ⇒ `workerDb` phải là kết nối app_worker. Trả số dòng đã xoá.
 * Lỗi I/O ở đây KHÔNG nuốt: xoá theo yêu cầu chủ thể phải biết có thất bại để thử lại.
 */
export async function forgetAnalyticsActor(
  workerDb: Kysely<unknown>,
  actorKey: Buffer,
  userId: string,
): Promise<number> {
  const actor = pseudonymizeActor(actorKey, userId);
  const r = await sql<{ n: number }>`select app.forget_analytics_actor(${actor}) as n`.execute(workerDb);
  return r.rows[0]?.n ?? 0;
}
