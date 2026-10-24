// PLAN đợt 3 T-222 — xuất dữ liệu (SPEC-audit-reporting S-013…S-018; ERD `export_jobs`; D-019).
// - `exports.request` / `exports.requestOrgExport` (command): quyền `data.export` (owner; kế toán chỉ nhóm tiền), cơ sở ngoài
//   phạm vi ⇒ 404 KHÔNG tạo job, xác thực lại trong 5 phút (REAUTH_REQUIRED 401), ≤ 10 yêu cầu/giờ/người (429); ghi job
//   `queued` + audit `export.requested` + outbox `export.requested` (cùng transaction) ⇒ 202 + `export_id`.
// - Worker (`runExportJob`): dựng lại actor của người yêu cầu TẠI LÚC CHẠY (membership bị thu hồi/đổi vai trò ⇒ `failed`
//   FORBIDDEN), đọc dữ liệu bằng kết nối runtime trong ngữ cảnh của chính người đó (RLS + phạm vi), ghi file riêng tư, chỉ
//   worker đổi trạng thái; `ready` + hạn 15 phút + audit `export.completed` + thông báo `export_ready`.
// - `exports.download`: chỉ người yêu cầu (RLS), chưa xong ⇒ 409 EXPORT_NOT_READY, quá hạn ⇒ 410 LINK_EXPIRED; URL ký ≤ 5 phút
//   (MAX_SIGNED_URL_SECONDS) và không quá hạn của bản xuất; audit `export.downloaded`.
// - CSV/XLSX chống formula injection (S-016): ô chữ bắt đầu bằng = + - @ tab CR ⇒ thêm `'` (CSV); XLSX ghi kiểu chuỗi; số
//   giữ là số. Xuất toàn tổ chức (S-018): ZIP các CSV nghiệp vụ + file đính kèm đã `ready` (theo quyền người yêu cầu, có trần
//   tổng dung lượng — T-405/IND-SAAS-007), không số giấy tờ, không ảnh giấy tờ tuỳ thân, bỏ cột bí mật.
import { createHash, randomUUID } from "node:crypto";
import { withTenant, withTenantRetry } from "@hm/db";
import {
  authorize,
  BYTES_PER_MIB,
  MS_PER_DAY,
  MS_PER_MINUTE,
  mibToBytes,
  minutesToMs,
  msToSeconds,
  SECONDS_PER_HOUR,
  secondsToMs,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import { AccessError, type Actor, resolveActor } from "../access/index.ts";
import { listEvents } from "../audit/index.ts";
import {
  commitGeneratedFile,
  MAX_SIGNED_URL_SECONDS,
  type ObjectStorage,
  prepareGeneratedFile,
} from "../files/index.ts";
import { t } from "../i18n.ts";
import { writeXlsx, zipStore } from "../import/index.ts";
import { createNotification } from "../notifications/index.ts";
import { type CommandContext, CommandError, rateLimited } from "../pipeline/index.ts";
import {
  collections,
  depositsHeld,
  occupancy,
  receivables,
  reportRange,
  validDate,
} from "../reports/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Xác thực lại trong vòng (giây) — SPEC Q-06 đề xuất 5 phút. */
export const REAUTH_MAX_AGE_SECONDS = 300;
/** Bản xuất tải được trong (phút) sau khi xong — SPEC Q-06. */
export const EXPORT_TTL_MINUTES = 15;
/** Số yêu cầu xuất tối đa mỗi giờ mỗi người (SPEC §6 RATE_LIMITED). */
export const EXPORT_RATE_PER_HOUR = 10;
/** Trần số dòng mỗi bảng/báo cáo — vượt ⇒ job `failed` TOO_LARGE (không cắt âm thầm). */
export const EXPORT_MAX_ROWS = 100_000;

export const EXPORT_KINDS = ["receivables", "collections", "deposits", "occupancy", "audit"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
/** Kế toán: "Có (tiền)" theo ma trận SPEC-access-and-property. */
const ACCOUNTANT_KINDS: ReadonlySet<string> = new Set(["receivables", "collections", "deposits"]);

const KIND_LABEL: Readonly<Record<ExportKind | "org_full", string>> = {
  receivables: t("exports.kind.receivables"),
  collections: t("exports.kind.collections"),
  deposits: t("exports.kind.deposits"),
  occupancy: t("exports.kind.occupancy"),
  audit: t("exports.kind.audit"),
  org_full: t("exports.kind.org_full"),
};

const MIME = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
} as const;

const notFound = () => new CommandError("NOT_FOUND", 404, t("common.not_found_data_dot"));
const forbidden = () => new CommandError("FORBIDDEN", 403, t("common.forbidden_action"));

// ───────────────────────────── CSV an toàn ─────────────────────────────

export type Cell =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

const NUMERIC = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** Chuỗi an toàn cho bảng tính: bắt đầu bằng ký tự công thức ⇒ thêm `'`; chuỗi số thuần (số tiền) giữ nguyên. */
export function safeText(s: string): string {
  return FORMULA_START.test(s) && !NUMERIC.test(s) ? `'${s}` : s;
}

function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return safeText(JSON.stringify(v));
  return safeText(v);
}

/** CSV UTF-8 (BOM cho Excel), CRLF, trích dẫn theo RFC 4180. */
export function toCsv(rows: readonly (readonly Cell[])[]): Uint8Array {
  const line = (r: readonly Cell[]) =>
    r
      .map((v) => {
        const t = cellText(v);
        return /[",\r\n]|^\s|\s$/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
      })
      .join(",");
  return new TextEncoder().encode(`﻿${rows.map(line).join("\r\n")}\r\n`);
}

function toXlsx(name: string, rows: readonly (readonly Cell[])[]): Uint8Array {
  return writeXlsx([
    {
      name,
      rows: rows.map((r) =>
        r.map((v) =>
          typeof v === "number"
            ? v
            : typeof v === "bigint"
              ? Number(v)
              : v === null || v === undefined
                ? ""
                : typeof v === "string"
                  ? v
                  : cellText(v),
        ),
      ),
    },
  ]);
}

// ───────────────────────────── Yêu cầu xuất ─────────────────────────────

export interface ExportFilters {
  asOf?: string;
  from?: string;
  to?: string;
  correlationId?: string;
}

function assertKindAllowed(actor: Actor, kind: string): void {
  authorize(actor, "data.export");
  if (actor.role === "accountant" && !ACCOUNTANT_KINDS.has(kind)) throw forbidden();
}

function assertRecentAuth(actor: Actor, now: Date): void {
  const at = actor.authenticatedAt?.getTime();
  if (
    at === undefined ||
    now.getTime() - at > secondsToMs(REAUTH_MAX_AGE_SECONDS) ||
    at > now.getTime() + MS_PER_MINUTE
  )
    throw new CommandError("REAUTH_REQUIRED", 401, t("exports.reauth_required"));
}

function normalizeFilters(kind: ExportKind, f: ExportFilters): Record<string, string> {
  switch (kind) {
    case "receivables":
      return f.asOf ? { as_of: validDate(f.asOf, "as_of") } : {};
    case "collections":
    case "occupancy":
    case "audit": {
      if (!f.from || !f.to) {
        const field = f.from ? "to" : "from";
        throw new CommandError("VALIDATION_FAILED", 422, t("exports.filter_required", { field }), {
          extensions: { errors: [{ path: field, field, code: "required" }] },
        });
      }
      const r = reportRange(f.from, f.to);
      return {
        from: r.from,
        to: r.to,
        ...(kind === "audit" && f.correlationId ? { correlation_id: f.correlationId.slice(0, 200) } : {}),
      };
    }
    case "deposits":
      return {};
  }
}

async function assertRate(ctx: CommandContext, now: Date): Promise<void> {
  // Khoá theo người yêu cầu trong transaction: hai yêu cầu song song không cùng đếm 9 rồi cùng qua (review lát 5 🟢6).
  await sql`select pg_advisory_xact_lock(hashtextextended(${`export-rate:${ctx.actor.orgId}:${ctx.actor.membershipId}`}, 0))`.execute(
    ctx.trx,
  );
  const r = await sql<{ n: number; wait: number | null }>`
    select count(*)::int as n,
           ceil(extract(epoch from min(created_at) + interval '1 hour' - ${now}::timestamptz))::int as wait
    from export_jobs
    where organization_id = ${ctx.actor.orgId} and requested_by = ${ctx.actor.membershipId}
      and created_at > ${now}::timestamptz - interval '1 hour'`.execute(ctx.trx);
  // Yêu cầu cũ nhất rời cửa sổ 1 giờ ⇒ được yêu cầu tiếp: đó là số giây `Retry-After`.
  if ((r.rows[0]?.n ?? 0) >= EXPORT_RATE_PER_HOUR)
    throw rateLimited(t("exports.rate_limited"), r.rows[0]?.wait ?? SECONDS_PER_HOUR);
}

async function createJob(
  ctx: CommandContext,
  job: {
    kind: ExportKind | "org_full";
    format: "csv" | "xlsx" | "zip";
    propertyId: string | null;
    filters: Record<string, string>;
  },
  now: Date,
): Promise<{ exportId: string; status: "queued" }> {
  await assertRate(ctx, now);
  const id = randomUUID();
  const scope = {
    role: ctx.actor.role,
    all_properties: ctx.actor.allProperties,
    property_ids: [...ctx.actor.propertyIds],
  };
  await sql`
    insert into export_jobs (id, organization_id, property_id, requested_by, kind, format, filters, scope_snapshot, created_at)
    values (${id}, ${ctx.actor.orgId}, ${job.propertyId}, ${ctx.actor.membershipId}, ${job.kind}, ${job.format},
            ${JSON.stringify(job.filters)}::jsonb, ${JSON.stringify(scope)}::jsonb, ${now})`.execute(ctx.trx);
  await ctx.audit({
    action: "export.requested",
    entityType: "export_job",
    entityId: id,
    ...(job.propertyId ? { propertyId: job.propertyId } : {}),
    after: { kind: job.kind, format: job.format, filters: job.filters },
  });
  await ctx.emit({
    eventType: "export.requested",
    aggregateType: "export_job",
    aggregateId: id,
    ...(job.propertyId ? { propertyId: job.propertyId } : {}),
    payload: { export_id: id },
  });
  return { exportId: id, status: "queued" };
}

/** `exports.request` (S-013…S-017). */
export async function requestExport(
  ctx: CommandContext,
  input: {
    kind: ExportKind;
    format: "csv" | "xlsx";
    propertyId?: string;
    filters?: ExportFilters;
    now?: Date;
  },
): Promise<{ exportId: string; status: "queued" }> {
  const now = input.now ?? new Date();
  assertKindAllowed(ctx.actor, input.kind);
  if (input.propertyId !== undefined) {
    if (!UUID.test(input.propertyId)) throw notFound();
    authorize(ctx.actor, "data.export", { propertyId: input.propertyId });
  }
  const filters = normalizeFilters(input.kind, input.filters ?? {});
  assertRecentAuth(ctx.actor, now);
  return createJob(
    ctx,
    { kind: input.kind, format: input.format, propertyId: input.propertyId ?? null, filters },
    now,
  );
}

/** `exports.requestOrgExport` (S-018): chỉ owner. */
export async function requestOrgExport(
  ctx: CommandContext,
  input: { now?: Date } = {},
): Promise<{ exportId: string; status: "queued" }> {
  const now = input.now ?? new Date();
  authorize(ctx.actor, "data.export");
  if (ctx.actor.role !== "owner") throw forbidden();
  assertRecentAuth(ctx.actor, now);
  return createJob(ctx, { kind: "org_full", format: "zip", propertyId: null, filters: {} }, now);
}

// ───────────────────────────── Trạng thái + tải ─────────────────────────────

export interface ExportStatus {
  exportId: string;
  kind: string;
  format: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  rowCount: number | null;
  failedReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface JobRow {
  id: string;
  kind: string;
  format: string;
  status: ExportStatus["status"];
  row_count: string | null;
  failed_reason: string | null;
  expires_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  file_key: string | null;
  property_id: string | null;
}

const toStatus = (r: JobRow): ExportStatus => ({
  exportId: r.id,
  kind: r.kind,
  format: r.format,
  status: r.status,
  rowCount: r.row_count === null ? null : Number(r.row_count),
  failedReason: r.failed_reason,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

/** `exports.getStatus`: chỉ job của chính mình (RLS) — khác ⇒ 404. */
export async function getExportStatus(
  db: Kysely<unknown>,
  actor: Actor,
  exportId: string,
): Promise<ExportStatus> {
  if (!UUID.test(exportId)) throw notFound();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r =
      await sql<JobRow>`select * from export_jobs where organization_id = ${actor.orgId} and id = ${exportId}`.execute(
        trx,
      );
    const row = r.rows[0];
    if (!row) throw notFound();
    return toStatus(row);
  });
}

/** `exports.listMine`: 50 yêu cầu gần nhất của chính mình. */
export async function listMyExports(db: Kysely<unknown>, actor: Actor): Promise<ExportStatus[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<JobRow>`
      select * from export_jobs where organization_id = ${actor.orgId} and requested_by = ${actor.membershipId}
      order by created_at desc, id desc limit 50`.execute(trx);
    return r.rows.map(toStatus);
  });
}

/** `exports.download` (S-015): URL ký ngắn hạn cho chính người yêu cầu. */
export async function downloadExport(
  ctx: CommandContext,
  deps: { storage: ObjectStorage },
  input: { exportId: string; now?: Date },
): Promise<{ url: string; expiresIn: number }> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.exportId)) throw notFound();
  const r = await sql<JobRow>`
    select * from export_jobs where organization_id = ${ctx.actor.orgId} and id = ${input.exportId}
      and requested_by = ${ctx.actor.membershipId}`.execute(ctx.trx);
  const job = r.rows[0];
  if (!job) throw notFound();
  if (job.status === "expired" || (job.status === "ready" && job.expires_at && job.expires_at <= now))
    throw new CommandError("LINK_EXPIRED", 410, t("exports.link_expired"));
  if (job.status !== "ready" || !job.file_key || !job.expires_at)
    throw new CommandError(
      "EXPORT_NOT_READY",
      409,
      job.status === "failed" ? t("exports.failed") : t("exports.not_ready"),
    );
  const expiresIn = Math.max(
    1,
    Math.min(MAX_SIGNED_URL_SECONDS, msToSeconds(job.expires_at.getTime() - now.getTime())),
  );
  await ctx.audit({
    action: "export.downloaded",
    entityType: "export_job",
    entityId: job.id,
    ...(job.property_id ? { propertyId: job.property_id } : {}),
  });
  ctx.security({ event: "export.downloaded", target: { type: "export_job", id: job.id } });
  return { url: await deps.storage.signedGetUrl(job.file_key, expiresIn), expiresIn };
}

// ───────────────────────────── Worker ─────────────────────────────

export interface ExportJobDeps {
  /** Kết nối vai trò runtime — đọc dữ liệu trong ngữ cảnh người yêu cầu (RLS). */
  db: Kysely<unknown>;
  /** Kết nối vai trò worker — đổi trạng thái job, audit, thông báo. */
  workerDb: Kysely<unknown>;
  storage: ObjectStorage;
  /** Ghi đè trần tổng dung lượng file đính kèm của xuất toàn tổ chức (test); mặc định `ORG_EXPORT_FILES_MAX_BYTES`. */
  orgFilesMaxBytes?: number;
}

class ExportFailure extends Error {
  readonly reason: "FORBIDDEN" | "TOO_LARGE" | "INVALID";
  constructor(reason: "FORBIDDEN" | "TOO_LARGE" | "INVALID") {
    super(reason);
    this.reason = reason;
  }
}

/** Actor của người yêu cầu tại lúc chạy; membership không còn hiệu lực/không còn quyền ⇒ FORBIDDEN. */
async function requesterNow(db: Kysely<unknown>, orgId: string, membershipId: string): Promise<Actor> {
  const m = await withTenant(db, { orgId }, (trx) =>
    sql<{ auth_user_id: string | null }>`
      select auth_user_id from memberships where organization_id = ${orgId} and id = ${membershipId}`.execute(
      trx,
    ),
  );
  const authUserId = m.rows[0]?.auth_user_id;
  if (!authUserId) throw new ExportFailure("FORBIDDEN");
  try {
    const a = await resolveActor(db, { authUserId, orgId, twoFactorEnabled: true });
    if (a.membershipId !== membershipId) throw new ExportFailure("FORBIDDEN");
    return a;
  } catch (err) {
    if (err instanceof AccessError || err instanceof ExportFailure) throw new ExportFailure("FORBIDDEN");
    throw err;
  }
}

function capped<T>(rows: readonly T[]): readonly T[] {
  if (rows.length > EXPORT_MAX_ROWS) throw new ExportFailure("TOO_LARGE");
  return rows;
}

const vnDate = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");

/** Bảng dữ liệu của một báo cáo (dòng đầu là tiêu đề). */
async function reportTable(
  db: Kysely<unknown>,
  actor: Actor,
  kind: ExportKind,
  propertyId: string | null,
  f: Record<string, string>,
): Promise<{ table: Cell[][]; rows: number }> {
  const p = propertyId ? { propertyId } : {};
  switch (kind) {
    case "receivables": {
      const r = await receivables(db, actor, { ...p, ...(f.as_of ? { asOf: f.as_of } : {}) });
      return {
        rows: r.rows.length,
        table: [
          [
            t("exports.col.invoice"),
            t("exports.col.property"),
            t("exports.col.payer"),
            t("exports.col.kind"),
            t("exports.col.due"),
            t("exports.total"),
            t("exports.col.allocated"),
            t("exports.col.adjusted"),
            t("exports.col.balance"),
            t("exports.col.days_overdue"),
          ],
          ...capped(r.rows).map((x) => [
            x.number,
            x.propertyName,
            x.payerName,
            x.kind,
            vnDate(x.dueOn),
            x.total,
            x.allocated,
            x.adjusted,
            x.balance,
            x.daysOverdue,
          ]),
          [t("exports.total"), "", "", "", "", "", "", "", r.total, ""],
          [
            t("exports.receivables.as_of", { date: vnDate(r.asOf) }),
            t("exports.receivables.ledger_balance", { amount: r.ledgerBalance }),
            r.matchesLedger ? t("exports.ledger_match") : t("exports.ledger_mismatch"),
          ],
        ],
      };
    }
    case "collections": {
      const r = await collections(db, actor, { from: f.from as string, to: f.to as string, ...p });
      return {
        rows: r.byDay.length,
        table: [
          [
            t("exports.col.business_date"),
            t("exports.col.method"),
            t("exports.col.confirmed_by"),
            t("exports.col.count"),
            t("exports.col.amount"),
          ],
          ...capped(r.byDay).map((x) => [
            vnDate(x.businessDate),
            x.method === "cash" ? t("common.payment_method.cash") : t("common.payment_method.bank_transfer"),
            x.confirmedBy,
            x.count,
            x.amount,
          ]),
          [t("exports.total"), "", "", "", r.total],
          [r.note],
        ],
      };
    }
    case "deposits": {
      const r = await depositsHeld(db, actor, p);
      return {
        rows: r.rows.length,
        table: [
          [
            t("exports.col.deposit_id"),
            t("exports.col.depositor"),
            t("exports.col.lease"),
            t("exports.col.reservation"),
            t("exports.col.received"),
            t("exports.col.deducted"),
            t("exports.col.refunded"),
            t("exports.col.held"),
          ],
          ...capped(r.rows).map((x) => [
            x.depositId,
            x.payerName,
            x.leaseId,
            x.reservationId,
            x.amount,
            x.deducted,
            x.refunded,
            x.balance,
          ]),
          [t("exports.total"), "", "", "", "", "", "", r.total],
          [
            t("exports.deposits.ledger_balance", { amount: r.ledgerBalance }),
            r.matchesLedger ? t("exports.ledger_match") : t("exports.ledger_mismatch"),
          ],
        ],
      };
    }
    case "occupancy": {
      const r = await occupancy(db, actor, { from: f.from as string, to: f.to as string, ...p });
      return {
        rows: r.rows.length,
        table: [
          [
            t("exports.col.date"),
            t("exports.col.property"),
            t("exports.col.units"),
            t("exports.col.blocked"),
            t("exports.col.available"),
            t("exports.col.occupied"),
            t("exports.col.rate"),
          ],
          ...capped(r.rows).map((x) => [
            vnDate(x.date),
            x.propertyName,
            x.units,
            x.blocked,
            x.available,
            x.occupied,
            x.rate,
          ]),
          [r.formula],
        ],
      };
    }
    case "audit": {
      const out: Cell[][] = [
        [
          t("exports.col.occurred_at"),
          t("exports.col.actor"),
          t("exports.col.action"),
          t("exports.col.entity_type"),
          t("exports.col.entity_id"),
          t("exports.col.reason"),
          t("exports.col.before"),
          "Sau",
          "Correlation",
          t("exports.col.ip"),
          t("exports.col.user_agent"),
        ],
      ];
      let cursor: string | undefined;
      for (;;) {
        const r = await listEvents(db, actor, {
          from: new Date(`${f.from}T00:00:00+07:00`),
          to: new Date(Date.parse(`${f.to}T00:00:00+07:00`) + MS_PER_DAY),
          ...(propertyId ? { propertyId } : {}),
          ...(f.correlation_id ? { correlationId: f.correlation_id } : {}),
          order: "asc",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const e of r.items)
          out.push([
            e.occurredAtLocal,
            e.actorName ?? e.actorType,
            e.action,
            e.entityType,
            e.entityId,
            e.reason,
            e.before as Cell,
            e.after as Cell,
            e.correlationId,
            e.sourceIp,
            e.userAgent,
          ]);
        if (out.length - 1 > EXPORT_MAX_ROWS) throw new ExportFailure("TOO_LARGE");
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return { rows: out.length - 1, table: out };
    }
  }
}

/** Bảng nghiệp vụ của xuất toàn tổ chức (S-018). Không có `identity_documents`, `files`, bảng xác thực/kỹ thuật. */
export const ORG_EXPORT_TABLES = [
  "properties",
  "floors",
  "room_types",
  "units",
  "persons",
  "leases",
  "lease_versions",
  "lease_occupants",
  "handovers",
  "meters",
  "meter_readings",
  "billing_periods",
  "invoices",
  "invoice_lines",
  "payments",
  "payment_allocations",
  "deposits",
  "reservations",
  "reservation_items",
  "stays",
  "charges",
  "journal_entries",
  "journal_lines",
  "work_orders",
  "blocks",
] as const;

/** Cột không bao giờ xuất: bí mật, băm, khoá lưu trữ, số giấy tờ/tài khoản đầy đủ, dữ liệu mã hoá. */
export const ORG_EXPORT_EXCLUDED_COLUMN =
  /(token|secret|hash|storage_key|encrypted|cipher|blind|doc(ument)?_number|id_number|account_number$|password|_enc$|^raw$|signature)/i;

/** Trần TỔNG dung lượng file đính kèm nhúng vào ZIP toàn tổ chức (ZIP dựng trong bộ nhớ worker). Vượt ⇒ liệt kê kèm lý do. */
export const ORG_EXPORT_FILES_MAX_BYTES = mibToBytes(100);
/** Trần thời gian tải MỘT object từ kho khi dựng ZIP; quá hạn/lỗi ⇒ file đó được liệt kê `fetch_failed`, job vẫn hoàn tất. */
export const ORG_EXPORT_FILE_FETCH_TIMEOUT_MS = 30_000;
/**
 * ALLOWLIST (D-033, 2026-10-17) owner_type của file được nhúng vào ZIP toàn tổ chức: ảnh công tơ/sự cố/biên bản/chứng từ —
 * không chứa số giấy tờ tuỳ thân. ĐÓNG MẶC ĐỊNH: loại khác (identity_document, residence_notice — CSV/XLSX chứa số giấy tờ đã
 * giải mã; import_batch — file nguồn nhập liệu có thể chứa CCCD; export_job — bản xuất cũ) và loại MỚI thêm sau KHÔNG tự lọt;
 * chúng chỉ được liệt kê ở `files/MANIFEST.csv` kèm lý do. Số giấy tờ chỉ đi ra qua luồng thông báo lưu trú có kiểm soát.
 * Đường lùi: đặt mảng rỗng ⇒ không nhúng file nào.
 */
export const ORG_EXPORT_FILE_OWNER_ALLOWLIST: readonly string[] = [
  "work_order",
  "handover",
  "meter_reading",
  "task",
  "payment_claim",
  "lease_settlement",
];
/** Lý do KHÔNG nhúng file (cột `reason` của `files/MANIFEST.csv`). */
export const ORG_EXPORT_SKIP_REASONS = {
  over_total_limit: t("exports.skip.over_total_limit"),
  identity_document: t("exports.skip.identity_document"),
  residence_notice: t("exports.skip.residence_notice"),
  import_batch: t("exports.skip.import_batch"),
  export_job: t("exports.skip.export_job"),
  owner_type_not_allowed: t("exports.skip.owner_type_not_allowed"),
  fetch_failed: t("exports.skip.fetch_failed"),
  checksum_mismatch: t("exports.skip.checksum_mismatch"),
} as const;
type SkipReason = keyof typeof ORG_EXPORT_SKIP_REASONS;

/** `null` = được nhúng (theo allowlist); ngược lại là lý do liệt kê ở MANIFEST. */
export function orgFileSkipReasonForOwner(ownerType: string): SkipReason | null {
  if (ORG_EXPORT_FILE_OWNER_ALLOWLIST.includes(ownerType)) return null;
  switch (ownerType) {
    case "identity_document":
    case "residence_notice":
    case "import_batch":
    case "export_job":
      return ownerType;
    default:
      return "owner_type_not_allowed";
  }
}

const FILE_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

interface OrgFileRow {
  id: string;
  owner_type: string;
  owner_id: string | null;
  property_id: string | null;
  mime: string;
  size_bytes: string;
  sha256: string;
  created_at: Date;
  storage_key: string;
}

/** Tải một object qua URL ký ngắn hạn, có trần thời gian; lỗi bất kỳ ⇒ null (không làm hỏng cả bản xuất). */
async function fetchObject(storage: ObjectStorage, key: string): Promise<Buffer | null> {
  try {
    const res = await fetch(await storage.signedGetUrl(key, 60), {
      signal: AbortSignal.timeout(ORG_EXPORT_FILE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * File đính kèm (ảnh công tơ, ảnh sự cố, chứng từ…) của tổ chức mà `actor` ĐƯỢC THẤY (RLS `files` chạy trong ngữ cảnh actor),
 * trạng thái `ready`. Duyệt theo thời gian tạo; file nào làm tổng vượt `maxBytes` thì không nhúng mà ghi lý do (file nhỏ hơn
 * phía sau vẫn có thể vừa). Danh sách đọc trong transaction ngắn; TẢI object NGOÀI transaction (DB-TX-003).
 */
async function orgFiles(
  db: Kysely<unknown>,
  storage: ObjectStorage,
  actor: Actor,
  maxBytes: number,
): Promise<{ entries: { name: string; data: Buffer }[]; manifest: Cell[][]; included: number }> {
  const rows = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<OrgFileRow>`
      select id, owner_type, owner_id, property_id, mime, size_bytes::text, sha256, created_at, storage_key
      from files where organization_id = ${actor.orgId} and status = 'ready'
      order by created_at, id`.execute(trx);
    return r.rows;
  });
  const entries: { name: string; data: Buffer }[] = [];
  const manifest: Cell[][] = [
    [
      "file_id",
      "owner_type",
      "owner_id",
      "property_id",
      "mime",
      "size_bytes",
      "sha256",
      "created_at",
      "zip_path",
      "status",
      "reason",
    ],
  ];
  let used = 0;
  for (const f of rows) {
    const size = Number(f.size_bytes);
    const path = `files/${f.owner_type}/${f.id}.${FILE_EXT[f.mime] ?? "bin"}`;
    let data: Buffer | null = null;
    let reason: SkipReason | null = orgFileSkipReasonForOwner(f.owner_type);
    // Loại ngoài allowlist: KHÔNG tải object (dữ liệu nhạy cảm không đi qua bộ nhớ worker).
    if (!reason && used + size > maxBytes) reason = "over_total_limit";
    else if (!reason) {
      data = await fetchObject(storage, f.storage_key);
      if (!data) reason = "fetch_failed";
      else if (data.length !== size || createHash("sha256").update(data).digest("hex") !== f.sha256) {
        data = null;
        reason = "checksum_mismatch";
      }
    }
    if (data) {
      used += size;
      entries.push({ name: path, data });
    }
    manifest.push([
      f.id,
      f.owner_type,
      f.owner_id,
      f.property_id,
      f.mime,
      size,
      f.sha256,
      f.created_at.toISOString(),
      data ? path : null,
      data ? "included" : "skipped",
      reason,
    ]);
  }
  return { entries, manifest, included: entries.length };
}

async function orgZip(
  db: Kysely<unknown>,
  storage: ObjectStorage,
  actor: Actor,
  maxFileBytes: number = ORG_EXPORT_FILES_MAX_BYTES,
): Promise<{ bytes: Uint8Array; rows: number }> {
  let total = 0;
  const files: { name: string; data: Buffer }[] = [];
  const dictionary: string[] = [];
  await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    for (const table of ORG_EXPORT_TABLES) {
      const exists = await sql<{
        ok: boolean;
      }>`select to_regclass(${`public.${table}`}) is not null as ok`.execute(trx);
      if (!exists.rows[0]?.ok) continue;
      const cols = await sql<{ column_name: string; data_type: string }>`
        select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = ${table} order by ordinal_position`.execute(trx);
      const kept = cols.rows.filter((c) => !ORG_EXPORT_EXCLUDED_COLUMN.test(c.column_name));
      const keep = kept.map((c) => c.column_name);
      // Cột `date` đọc dạng chữ YYYY-MM-DD: để pg chuyển sang Date sẽ lệch một ngày theo múi giờ của tiến trình (review
      // lát 5 🟠3). timestamptz giữ Date (ISO UTC, không mơ hồ).
      const select = kept.map((c) =>
        c.data_type === "date"
          ? sql`${sql.ref(c.column_name)}::text as ${sql.ref(c.column_name)}`
          : sql.ref(c.column_name),
      );
      const r = await sql<Record<string, Cell>>`
        select ${sql.join(select)} from ${sql.table(table)}
        where organization_id = ${actor.orgId}
        order by ${sql.ref(keep.includes("created_at") ? "created_at" : "id")}, id
        limit ${EXPORT_MAX_ROWS + 1}`.execute(trx);
      capped(r.rows);
      total += r.rows.length;
      files.push({
        name: `${table}.csv`,
        data: Buffer.from(toCsv([keep, ...r.rows.map((row) => keep.map((c) => row[c]))])),
      });
      dictionary.push(`${table}.csv: ${kept.map((c) => `${c.column_name} (${c.data_type})`).join(", ")}`);
    }
  });
  // Tải file NGOÀI transaction dữ liệu (không giữ kết nối CSDL trong lúc chờ kho object).
  const att = await orgFiles(db, storage, actor, maxFileBytes);
  files.push(...att.entries, { name: "files/MANIFEST.csv", data: Buffer.from(toCsv(att.manifest)) });
  const skipped = att.manifest.length - 1 - att.included;
  files.push({
    name: "README.txt",
    data: Buffer.from(
      [
        t("exports.readme.title"),
        "",
        t("exports.readme.format_heading"),
        t("exports.readme.format_csv", { quote: "'" }),
        t("exports.readme.format_values"),
        t("exports.readme.format_keys"),
        "",
        t("exports.readme.files_heading"),
        t("exports.readme.files_dir", { lt: "<", gt: ">", included: att.included, skipped }),
        t("exports.readme.files_manifest"),
        t("exports.readme.files_cap", { mib: ORG_EXPORT_FILES_MAX_BYTES / BYTES_PER_MIB }),
        ...Object.entries(ORG_EXPORT_SKIP_REASONS).map(([k, v]) => `  · ${k}: ${v}`),
        "",
        t("exports.readme.files_allowlist", { kinds: ORG_EXPORT_FILE_OWNER_ALLOWLIST.join(", ") }),
        "",
        t("exports.readme.excluded"),
        "",
        t("exports.readme.dictionary_heading"),
        ...dictionary,
        "",
      ].join("\r\n"),
      "utf8",
    ),
  });
  return { bytes: zipStore(files), rows: total };
}

async function transition(
  workerDb: Kysely<unknown>,
  orgId: string,
  fn: (trx: Transaction<unknown>) => Promise<void>,
): Promise<void> {
  await withTenantRetry(workerDb, { orgId }, fn);
}

/**
 * Worker xử lý `export.requested` (S-015, S-017, S-018). Giao lại (pg-boss) ⇒ bỏ qua nếu job không còn `queued`
 * (hoặc `running` bị bỏ dở > 10 phút ⇒ chạy lại). Trả trạng thái cuối.
 */
export async function runExportJob(
  deps: ExportJobDeps,
  job: { organization_id: string; payload: Record<string, unknown> },
  now: Date = new Date(),
): Promise<ExportStatus["status"] | "skipped"> {
  const orgId = job.organization_id;
  const id = job.payload.export_id;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error(t("exports.payload_missing_id"));
  const claimed = await withTenantRetry(deps.workerDb, { orgId }, async (trx) => {
    const r = await sql<{
      id: string;
      kind: ExportKind | "org_full";
      format: "csv" | "xlsx" | "zip";
      property_id: string | null;
      requested_by: string;
      filters: Record<string, string>;
      version: number;
    }>`
      update export_jobs set status = 'running', version = version + 1
      where organization_id = ${orgId} and id = ${id}
        and (status = 'queued' or (status = 'running' and updated_at < ${now}::timestamptz - interval '10 minutes'))
      returning id, kind, format, property_id, requested_by, filters, version`.execute(trx);
    return r.rows[0];
  });
  if (!claimed) return "skipped";

  /** Ghi `failed` + audit — chỉ khi job còn `running` của lượt này (không ghi đè job lượt khác đã xong). */
  const fail = async (reason: string): Promise<"failed" | "skipped"> => {
    let hit = false;
    await transition(deps.workerDb, orgId, async (trx) => {
      const u =
        await sql`update export_jobs set status = 'failed', failed_reason = ${reason}, completed_at = ${now}
                where organization_id = ${orgId} and id = ${id} and status = 'running'`.execute(trx);
      hit = Number(u.numAffectedRows ?? 0) === 1;
      if (!hit) return;
      await sql`insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after,
                                          correlation_id)
                values (${randomUUID()}, ${orgId}, ${claimed.property_id}, 'worker', 'export.failed', 'export_job', ${id},
                        ${JSON.stringify({ reason })}::jsonb, ${`export:${id}`})`.execute(trx);
    });
    return hit ? "failed" : "skipped";
  };

  try {
    return await produce(deps, claimed, id, orgId, now, fail);
  } catch (err) {
    // Lỗi tạm (mạng, kho object, CSDL): KHÔNG để job kẹt `running` — ghi `failed` INTERNAL (người dùng tạo yêu cầu mới) rồi
    // ném tiếp cho worker log/pg-boss (review lát 5 🟠2). Giao lại sau đó thấy `failed` ⇒ bỏ qua.
    await fail("INTERNAL").catch(() => {});
    throw err;
  }
}

type Claimed = {
  id: string;
  kind: ExportKind | "org_full";
  format: "csv" | "xlsx" | "zip";
  property_id: string | null;
  requested_by: string;
  filters: Record<string, string>;
  /** Tăng mỗi lần nhận job (`running`) ⇒ định danh lượt chạy; lượt chạy lại không đụng file của lượt trước. */
  version: number;
};

async function produce(
  deps: ExportJobDeps,
  claimed: Claimed,
  id: string,
  orgId: string,
  now: Date,
  fail: (reason: string) => Promise<"failed" | "skipped">,
): Promise<ExportStatus["status"] | "skipped"> {
  let actor: Actor;
  let bytes: Uint8Array;
  let rows: number;
  try {
    actor = await requesterNow(deps.db, orgId, claimed.requested_by);
    if (claimed.kind === "org_full") {
      if (actor.role !== "owner") throw new ExportFailure("FORBIDDEN");
      authorize(actor, "data.export");
      ({ bytes, rows } = await orgZip(deps.db, deps.storage, actor, deps.orgFilesMaxBytes));
    } else {
      try {
        assertKindAllowed(actor, claimed.kind);
        if (claimed.property_id) authorize(actor, "data.export", { propertyId: claimed.property_id });
      } catch {
        throw new ExportFailure("FORBIDDEN");
      }
      const { table, rows: n } = await reportTable(
        deps.db,
        actor,
        claimed.kind,
        claimed.property_id,
        claimed.filters,
      );
      rows = n;
      bytes = claimed.format === "xlsx" ? toXlsx(KIND_LABEL[claimed.kind], table) : toCsv(table);
    }
  } catch (err) {
    if (err instanceof ExportFailure) return fail(err.reason);
    if (err instanceof CommandError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND"))
      return fail("FORBIDDEN");
    if (
      err instanceof CommandError &&
      (err.code === "VALIDATION_FAILED" || err.code === "REPORT_RANGE_TOO_LARGE")
    )
      return fail("INVALID");
    throw err;
  }

  // File riêng tư, ghi trong ngữ cảnh người yêu cầu (policy `files` nhánh export_job). T-303: dòng staging (transaction ngắn)
  // → `storage.put` KHÔNG giữ kết nối CSDL → chốt `ready` (transaction ngắn). id/khoá suy từ (id job, số lần nhận job = `version`):
  // lượt chạy lại (job `running` bỏ dở > 10 phút được nhận lại, dữ liệu có thể đã đổi ⇒ sha256 khác) có file RIÊNG, không dính
  // 409 của dòng staging lượt trước (review lát 7 🟡5). File của lượt bỏ dở là mồ côi: có dòng staging + `delete_after` → job hạn giữ dọn.
  const mime = MIME[claimed.format];
  const prepared = await prepareGeneratedFile(
    deps.db,
    deps,
    actor,
    { ownerType: "export_job", ownerId: id, propertyId: claimed.property_id, bytes, mime },
    `${id}:run${claimed.version}`,
  );
  await withTenant(deps.db, { orgId, actorId: actor.membershipId }, (trx) =>
    commitGeneratedFile(trx, actor, prepared, "keep"),
  );
  const key = prepared.key;
  const expiresAt = new Date(now.getTime() + minutesToMs(EXPORT_TTL_MINUTES));
  let hit = false;
  await transition(deps.workerDb, orgId, async (trx) => {
    const u =
      await sql`update export_jobs set status = 'ready', file_key = ${key}, row_count = ${rows}, expires_at = ${expiresAt},
                     completed_at = ${now}
              where organization_id = ${orgId} and id = ${id} and status = 'running'`.execute(trx);
    // Lượt khác đã chốt job (bị nhận lại sau 10 phút): không audit/thông báo trùng; file thừa hết hạn sau 2 ngày (retention).
    hit = Number(u.numAffectedRows ?? 0) === 1;
    if (!hit) return;
    await sql`insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after,
                                        correlation_id)
              values (${randomUUID()}, ${orgId}, ${claimed.property_id}, 'worker', 'export.completed', 'export_job', ${id},
                      ${JSON.stringify({ rows, format: claimed.format })}::jsonb, ${`export:${id}`})`.execute(
      trx,
    );
    await createNotification(
      trx,
      orgId,
      {
        propertyId: claimed.property_id,
        recipientPersonId: actor.personId,
        type: "export_ready",
        vars: { exportName: KIND_LABEL[claimed.kind], exportId: id },
        dedupeKey: `export_ready:${id}`,
      },
      { now },
    );
  });
  return hit ? "ready" : "skipped";
}

/** Job định kỳ: bản xuất quá hạn tải ⇒ `expired` (mọi tổ chức). Trả số job đã chuyển. */
export async function expireExports(workerDb: Kysely<unknown>, now: Date = new Date()): Promise<number> {
  const r = await sql<{ n: number }>`select app.expire_export_jobs(${now}) as n`.execute(workerDb);
  return r.rows[0]?.n ?? 0;
}
