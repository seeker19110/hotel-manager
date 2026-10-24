// PLAN đợt 3 T-220 — nhật ký audit (SPEC-audit-reporting S-001…S-005; INV-G6; D-017).
// - `audit.listEvents`: lọc thời gian / cơ sở / người / thực thể / hành động / `correlation_id`; phân trang keyset theo
//   (occurred_at, id) — không OFFSET (50.000 sự kiện vẫn ổn định); giờ hiển thị theo múi giờ cơ sở (cấp tổ chức: múi giờ
//   cơ sở đầu tiên của tổ chức, mặc định Asia/Ho_Chi_Minh).
// - Quyền: vai trò không có `audit.read` → 403 (kể cả khi lọc cơ sở ngoài phạm vi); cơ sở ngoài phạm vi → 404, không lộ
//   cơ sở tồn tại. Dòng nào thấy được do RLS `audit_read_by_role` (0042) quyết: manager theo phạm vi, accountant chỉ nhóm
//   tiền; app lọc thêm cùng điều kiện cho kế toán (phòng thủ nhiều lớp).
// - Không có secret/CCCD: `before/after` đã qua `redact` lúc ghi (pipeline), đọc trả nguyên.

import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/index.ts";
import { t } from "../i18n.ts";
import { CommandError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tiền tố `action` thuộc nhóm tiền — trùng danh sách trong policy `audit_read_by_role` (0042, có test đối chiếu). */
export const AUDIT_MONEY_GROUPS = [
  "payment",
  "payment_claim",
  "invoice",
  "deposit",
  "period",
  "billing",
  "ledger",
  "reconciliation",
  "shift",
  "folio",
] as const;

export const AUDIT_PAGE_MAX = 200;

export interface AuditFilter {
  from?: Date;
  to?: Date;
  propertyId?: string;
  actorPersonId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  correlationId?: string;
  /** Mặc định mới nhất trước; lọc theo `correlationId` mặc định theo thứ tự xảy ra (S-005). */
  order?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  occurredAtLocal: string;
  propertyId: string | null;
  actorType: string;
  actorPersonId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlationId: string;
  commandId: string | null;
  outcome: string;
  /** "Từ đâu" (CMP-AUDIT-002): IP đã cắt (/24, /48) và User-Agent ≤ 200 ký tự; null = lệnh worker/hệ thống. */
  sourceIp: string | null;
  userAgent: string | null;
}

const notFound = () => new CommandError("NOT_FOUND", 404, t("common.not_found"));
const invalid = (field: string) =>
  new CommandError("VALIDATION_FAILED", 422, t("audit.filter_invalid"), {
    extensions: { errors: [{ path: field, field, code: "invalid" }] },
  });

interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (
      typeof c.t !== "string" ||
      Number.isNaN(Date.parse(c.t)) ||
      typeof c.id !== "string" ||
      !UUID.test(c.id)
    )
      throw new Error("cursor");
    return c;
  } catch {
    throw invalid("cursor");
  }
}

/** 403 trước (vai trò), rồi 404 (cơ sở ngoài phạm vi) — S-004. */
function authorizeAudit(actor: Actor, propertyId?: string): void {
  authorize(actor, "audit.read");
  if (propertyId !== undefined) authorize(actor, "audit.read", { propertyId });
}

// SQL: Khoá keyset đủ micro giây (Date của JS chỉ tới mili giây ⇒ cắt ⇒ lặp/sót dòng ở ranh trang).
const SELECT = sql`
  select e.id, e.occurred_at, e.property_id, e.actor_type, e.actor_person_id, pe.full_name as actor_name, e.action,
         e.entity_type, e.entity_id, e.before, e.after, e.reason, e.correlation_id, e.command_id, e.outcome,
         e.source_ip, e.user_agent,
         to_char(e.occurred_at at time zone coalesce(p.timezone,
                   (select p2.timezone from properties p2 where p2.organization_id = e.organization_id order by p2.created_at, p2.id limit 1),
                   'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD HH24:MI:SS') as occurred_at_local,
         to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_key
  from audit_events e
  left join properties p on p.organization_id = e.organization_id and p.id = e.property_id
  left join persons pe on pe.organization_id = e.organization_id and pe.id = e.actor_person_id`;

interface Row {
  id: string;
  occurred_at: Date;
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
  source_ip: string | null;
  user_agent: string | null;
  occurred_at_local: string;
  occurred_at_key: string;
}

const toEvent = (r: Row): AuditEvent => ({
  id: r.id,
  occurredAt: r.occurred_at,
  occurredAtLocal: r.occurred_at_local,
  propertyId: r.property_id,
  actorType: r.actor_type,
  actorPersonId: r.actor_person_id,
  actorName: r.actor_name,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  before: r.before,
  after: r.after,
  reason: r.reason,
  correlationId: r.correlation_id,
  commandId: r.command_id,
  outcome: r.outcome,
  sourceIp: r.source_ip,
  userAgent: r.user_agent,
});

const moneyOnly = (actor: Actor) =>
  actor.role === "accountant"
    ? sql`and split_part(e.action, '.', 1) = any(${[...AUDIT_MONEY_GROUPS]}::text[])`
    : sql``;

/** `audit.listEvents` (S-004, S-005). */
export async function listEvents(
  db: Kysely<unknown>,
  actor: Actor,
  f: AuditFilter = {},
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  for (const k of ["propertyId", "actorPersonId", "entityId"] as const)
    if (f[k] !== undefined && !UUID.test(f[k] as string)) {
      if (k === "propertyId") {
        authorize(actor, "audit.read");
        throw notFound();
      }
      throw invalid(k);
    }
  authorizeAudit(actor, f.propertyId);
  if (f.from && f.to && f.from.getTime() > f.to.getTime()) throw invalid("from");
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), AUDIT_PAGE_MAX);
  const order = f.order ?? (f.correlationId ? "asc" : "desc");
  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Row>`
      ${SELECT}
      where e.organization_id = ${actor.orgId}
        ${f.from ? sql`and e.occurred_at >= ${f.from}` : sql``}
        ${f.to ? sql`and e.occurred_at < ${f.to}` : sql``}
        ${f.propertyId ? sql`and e.property_id = ${f.propertyId}` : sql``}
        ${f.actorPersonId ? sql`and e.actor_person_id = ${f.actorPersonId}` : sql``}
        ${f.entityType ? sql`and e.entity_type = ${f.entityType}` : sql``}
        ${f.entityId ? sql`and e.entity_id = ${f.entityId}` : sql``}
        ${f.action ? sql`and e.action = ${f.action}` : sql``}
        ${f.correlationId ? sql`and e.correlation_id = ${f.correlationId}` : sql``}
        ${moneyOnly(actor)}
        ${
          cur
            ? order === "desc"
              ? sql`and (e.occurred_at, e.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`
              : sql`and (e.occurred_at, e.id) > (${cur.t}::timestamptz, ${cur.id}::uuid)`
            : sql``
        }
      order by ${order === "desc" ? sql`e.occurred_at desc, e.id desc` : sql`e.occurred_at, e.id`}
      limit ${limit + 1}`.execute(trx);
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map(toEvent),
      nextCursor:
        r.rows.length > limit && last ? encodeCursor({ t: last.occurred_at_key, id: last.id }) : null,
    };
  });
}

/** `audit.getEvent`: không thấy (RLS/phạm vi) = 404. */
export async function getEvent(db: Kysely<unknown>, actor: Actor, id: string): Promise<AuditEvent> {
  authorize(actor, "audit.read");
  if (!UUID.test(id)) throw notFound();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r =
      await sql<Row>`${SELECT} where e.organization_id = ${actor.orgId} and e.id = ${id} ${moneyOnly(actor)}`.execute(
        trx,
      );
    const row = r.rows[0];
    if (!row) throw notFound();
    return toEvent(row);
  });
}
