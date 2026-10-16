// Xem nhật ký audit (PLAN đợt 3 T-216; SPEC-audit-reporting S-004, S-005, S-019, §5 `audit.listEvents`, §6; INV-G6, SEC-LOG-007).
// Chỉ đọc (bảng append-only). Quyền xem theo ma trận `audit.read` (chủ/quản lý/kế toán; lễ tân, buồng phòng, bảo trì, người thuê → 403):
// - chủ: toàn tổ chức, gồm sự kiện cấp tổ chức (`property_id` null);
// - quản lý: chỉ sự kiện của cơ sở trong phạm vi (SPEC: "hoặc cấp tổ chức được phép" — danh mục được phép chưa có nên chặt: sự kiện cấp tổ chức
//   chỉ chủ xem; xem câu hỏi mở trong báo cáo T-216);
// - kế toán: chỉ nhóm sự kiện tiền (action bắt đầu bằng `payment.`, `invoice.`, `deposit.`, `period.`), trong phạm vi cơ sở;
// - `property_id` ngoài phạm vi → 404 `NOT_FOUND` (không lộ cơ sở khác), kể cả khi cơ sở không tồn tại.
// Khoảng thời gian: tối đa 366 ngày (S-019); mặc định 30 ngày gần nhất; riêng lọc theo `correlation_id`/`entity_id` không buộc khoảng (tra cứu
// theo mã). Phân trang keyset (occurred_at, id) với dấu thời gian ở độ chính xác micro giây (không làm tròn mili giây ⇒ không sót/không trùng).
// Dữ liệu trả ra luôn qua `redact` lần nữa (phòng thủ chiều sâu: hàng ghi thẳng bằng hàm CSDL không qua pipeline cũng không lộ giấy tờ/secret).
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { redact } from "../logging/logger.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export const AUDIT_MAX_RANGE_DAYS = 366;
export const AUDIT_DEFAULT_RANGE_DAYS = 30;
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
/** Nhóm sự kiện tiền kế toán được xem (SPEC S-004: payment, invoice, deposit, period_lock). */
export const ACCOUNTANT_ACTION_PREFIXES = ["payment.", "invoice.", "deposit.", "period."] as const;
/** Múi giờ hiển thị cho sự kiện cấp tổ chức (không gắn cơ sở) — cùng mặc định của `properties.timezone`. */
export const AUDIT_DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

export interface AuditListInput {
  propertyId?: string;
  /** Mốc thời gian, gồm `from`, không gồm `to` (nửa mở). */
  from?: Date;
  to?: Date;
  actorPersonId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  correlationId?: string;
  outcome?: "success" | "denied";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
  now?: Date;
}

export interface AuditEventView {
  id: string;
  occurred_at: string;
  /** Giờ địa phương của cơ sở (`YYYY-MM-DD HH24:MI:SS`); sự kiện cấp tổ chức dùng múi giờ mặc định. */
  occurred_at_local: string;
  timezone: string;
  property_id: string | null;
  actor_type: string;
  actor_person_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlation_id: string;
  command_id: string | null;
  outcome: string;
}

export interface AuditListResult {
  items: AuditEventView[];
  next_cursor: string | null;
  /** Khoảng thời gian thực sự đã áp dụng (UTC) — để giao diện hiển thị khi dùng mặc định. */
  range: { from: string | null; to: string };
}

interface Cursor {
  t: string;
  id: string;
}

function decodeCursor(raw: string | undefined, order: "asc" | "desc"): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const o = c as { t?: unknown; id?: unknown; o?: unknown };
    if (
      !c ||
      typeof o.t !== "string" ||
      typeof o.id !== "string" ||
      !UUID.test(o.id) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(o.t) ||
      o.o !== order
    )
      throw new Error("cursor");
    return { t: o.t, id: o.id };
  } catch {
    throw fieldError("cursor", "INVALID", "cursor không hợp lệ");
  }
}

function notFound(): CommandError {
  return new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
}

/** Chuẩn hoá khoảng thời gian: kiểm thứ tự + trần 366 ngày; trả [from|null, to]. */
function resolveRange(input: AuditListInput, now: Date): { from: Date | null; to: Date } {
  const { from, to } = input;
  for (const [f, v] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (v !== undefined && Number.isNaN(v.getTime()))
      throw fieldError(f, "INVALID", `${f} không phải thời điểm hợp lệ`);
  }
  const hasLookup = input.correlationId !== undefined || input.entityId !== undefined;
  const end = to ?? now;
  let start: Date | null;
  if (from) start = from;
  else if (to || !hasLookup) start = new Date(end.getTime() - AUDIT_DEFAULT_RANGE_DAYS * DAY_MS);
  else start = null; // tra cứu theo mã tương quan/thực thể, không giới hạn thời gian
  if (start && end.getTime() <= start.getTime()) throw fieldError("to", "RANGE_INVALID", "to phải sau from");
  if (start && end.getTime() - start.getTime() > AUDIT_MAX_RANGE_DAYS * DAY_MS)
    throw fieldError("to", "RANGE_TOO_LARGE", `Khoảng thời gian tối đa ${AUDIT_MAX_RANGE_DAYS} ngày`);
  return { from: start, to: end };
}

/**
 * `audit.listEvents`: lọc theo cơ sở, người làm, thực thể, hành động, `correlation_id`, khoảng thời gian; keyset. Mặc định mới → cũ; khi lọc
 * theo `correlation_id` mặc định cũ → mới (S-005: "sắp theo occurred_at").
 */
export async function listAuditEvents(
  db: Kysely<unknown>,
  actor: Actor,
  input: AuditListInput = {},
): Promise<AuditListResult> {
  // Vai trò không có quyền xem nhật ký → 403 (kể cả khi chỉ truyền cơ sở ngoài phạm vi: vai trò chưa đủ thì không cần biết cơ sở).
  authorize(actor, "audit.read");
  if (input.propertyId !== undefined) {
    if (!UUID.test(input.propertyId)) throw notFound();
    authorize(actor, "audit.read", { propertyId: input.propertyId });
  }
  for (const [f, v] of [
    ["actor_person_id", input.actorPersonId],
    ["entity_id", input.entityId],
  ] as const) {
    if (v !== undefined && !UUID.test(v)) throw fieldError(f, "INVALID", `${f} không hợp lệ`);
  }
  if (input.correlationId !== undefined && !/^[\x21-\x7e]{1,128}$/.test(input.correlationId))
    throw fieldError("correlation_id", "INVALID", "correlation_id không hợp lệ");
  const now = input.now ?? new Date();
  const order = input.order ?? (input.correlationId !== undefined ? "asc" : "desc");
  const range = resolveRange(input, now);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
  const after = decodeCursor(input.cursor, order);

  const isOwner = actor.role === "owner";
  const isAccountant = actor.role === "accountant";
  const scope: string[] | null = actor.allProperties ? null : [...actor.propertyIds];
  // Mẫu LIKE cho nhóm tiền: ký tự `.` không phải ký tự đặc biệt của LIKE; `_`/`%` không có trong tiền tố.
  const moneyPatterns = ACCOUNTANT_ACTION_PREFIXES.map((p) => `${p}%`);

  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    if (input.propertyId !== undefined) {
      const p = await sql<{ id: string }>`
        select id from properties where organization_id = ${actor.orgId} and id = ${input.propertyId}`.execute(
        trx,
      );
      if (!p.rows[0]) throw notFound();
    }
    const asc = order === "asc";
    const r = await sql<{
      id: string;
      occurred_at: Date;
      ts: string;
      local: string;
      tz: string;
      property_id: string | null;
      actor_type: string;
      actor_person_id: string | null;
      actor_name: string | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      before: unknown;
      after: unknown;
      reason: string | null;
      correlation_id: string;
      command_id: string | null;
      outcome: string;
    }>`
      select e.id, e.occurred_at,
             to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts,
             to_char(e.occurred_at at time zone coalesce(p.timezone, ${AUDIT_DEFAULT_TIMEZONE}), 'YYYY-MM-DD HH24:MI:SS') as local,
             coalesce(p.timezone, ${AUDIT_DEFAULT_TIMEZONE}) as tz,
             e.property_id, e.actor_type, e.actor_person_id, per.full_name as actor_name, e.action, e.entity_type, e.entity_id,
             e.before, e.after, e.reason, e.correlation_id, e.command_id, e.outcome
      from audit_events e
      left join properties p on p.organization_id = e.organization_id and p.id = e.property_id
      left join persons per on per.organization_id = e.organization_id and per.id = e.actor_person_id
      where e.organization_id = ${actor.orgId}
        and (${isOwner}::boolean
             or (e.property_id is not null and (${scope}::uuid[] is null or e.property_id = any(${scope}::uuid[]))))
        and (${!isAccountant}::boolean or e.action like any(${moneyPatterns}::text[]))
        and (${input.propertyId ?? null}::uuid is null or e.property_id = ${input.propertyId ?? null}::uuid)
        and (${range.from ?? null}::timestamptz is null or e.occurred_at >= ${range.from ?? null}::timestamptz)
        and e.occurred_at < ${range.to}::timestamptz
        and (${input.actorPersonId ?? null}::uuid is null or e.actor_person_id = ${input.actorPersonId ?? null}::uuid)
        and (${input.entityType ?? null}::text is null or e.entity_type = ${input.entityType ?? null})
        and (${input.entityId ?? null}::uuid is null or e.entity_id = ${input.entityId ?? null}::uuid)
        and (${input.action ?? null}::text is null or e.action = ${input.action ?? null})
        and (${input.correlationId ?? null}::text is null or e.correlation_id = ${input.correlationId ?? null})
        and (${input.outcome ?? null}::text is null or e.outcome = ${input.outcome ?? null})
        and (${after?.t ?? null}::timestamptz is null
             or (${asc}::boolean and (e.occurred_at, e.id) > (${after?.t ?? null}::timestamptz, ${after?.id ?? null}::uuid))
             or (not ${asc}::boolean and (e.occurred_at, e.id) < (${after?.t ?? null}::timestamptz, ${after?.id ?? null}::uuid)))
      order by e.occurred_at ${sql.raw(asc ? "asc" : "desc")}, e.id ${sql.raw(asc ? "asc" : "desc")}
      limit ${limit + 1}`.execute(trx);
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((x) => ({
        id: x.id,
        occurred_at: new Date(x.occurred_at).toISOString(),
        occurred_at_local: x.local,
        timezone: x.tz,
        property_id: x.property_id,
        actor_type: x.actor_type,
        actor_person_id: x.actor_person_id,
        actor_name: x.actor_name,
        action: x.action,
        entity_type: x.entity_type,
        entity_id: x.entity_id,
        before: x.before === null ? null : redact(x.before),
        after: x.after === null ? null : redact(x.after),
        reason: x.reason === null ? null : (redact(x.reason) as string),
        correlation_id: x.correlation_id,
        command_id: x.command_id,
        outcome: x.outcome,
      })),
      next_cursor:
        r.rows.length > limit && last
          ? Buffer.from(JSON.stringify({ t: last.ts, id: last.id, o: order })).toString("base64url")
          : null,
      range: { from: range.from ? range.from.toISOString() : null, to: range.to.toISOString() },
    };
  });
}
