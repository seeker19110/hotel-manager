// Command pipeline (ARCHITECTURE "Luồng một command ghi"): idempotency (INV-G5) → quyền → nghiệp vụ →
// audit_events + outbox CÙNG transaction (INV-G6) → kết quả lưu theo command_id; retry 40001/40P01 (DB-TX-002).
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { redact } from "../logging/logger.ts";
import { CommandError, type Problem, toProblem } from "./problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 3;

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string;
  propertyId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface EventInput {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  propertyId?: string;
  /** Chỉ id/số — không PII (ERD outbox). */
  payload: Record<string, string | number | boolean | null>;
  dedupeKey?: string;
}

export interface CommandContext {
  trx: Transaction<unknown>;
  actor: Actor;
  commandId: string;
  correlationId: string;
  audit(e: AuditInput): Promise<void>;
  emit(e: EventInput): Promise<void>;
}

export type CommandResult<T> =
  | { status: "committed"; commandId: string; httpStatus: number; data: T; replayed: boolean }
  | { status: "failed"; commandId: string; httpStatus: number; problem: Problem; replayed: boolean };

export interface CommandRequest {
  command: string;
  idempotencyKey: string | null | undefined;
  payload: unknown;
  correlationId: string;
}

/** JSON chuẩn hoá (khoá sắp xếp) để băm payload ổn định. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function hashPayload(command: string, payload: unknown): Buffer {
  return createHash("sha256").update(command).update("\n").update(canonicalJson(payload)).digest();
}

interface StoredRow {
  status: "in_progress" | "committed" | "failed";
  request_hash: Buffer;
  http_status: number | null;
  response: { data?: unknown; problem?: Problem } | null;
}

function replay<T>(commandId: string, row: StoredRow): CommandResult<T> {
  if (row.status === "committed") {
    return {
      status: "committed",
      commandId,
      httpStatus: row.http_status ?? 200,
      data: row.response?.data as T,
      replayed: true,
    };
  }
  return {
    status: "failed",
    commandId,
    httpStatus: row.http_status ?? 500,
    problem: row.response?.problem ?? toProblem(new Error("unknown")),
    replayed: true,
  };
}

async function auditRow(
  trx: Transaction<unknown>,
  actor: Actor,
  ids: { commandId: string; correlationId: string },
  e: AuditInput,
  outcome: "success" | "denied",
) {
  await sql`
    insert into audit_events (id, organization_id, property_id, actor_type, actor_person_id, action, entity_type, entity_id,
                              before, after, reason, correlation_id, command_id, outcome)
    values (${randomUUID()}, ${actor.orgId}, ${e.propertyId ?? null}, 'user', ${actor.personId}, ${e.action}, ${e.entityType},
            ${e.entityId ?? null}, ${e.before === undefined ? null : JSON.stringify(redact(e.before))}::jsonb,
            ${e.after === undefined ? null : JSON.stringify(redact(e.after))}::jsonb, ${e.reason ?? null},
            ${ids.correlationId}, ${ids.commandId}, ${outcome})`.execute(trx);
}

export async function executeCommand<T>(
  db: Kysely<unknown>,
  actor: Actor,
  req: CommandRequest,
  handler: (ctx: CommandContext) => Promise<{ data: T; httpStatus?: number }>,
): Promise<CommandResult<T>> {
  if (!req.idempotencyKey || !UUID.test(req.idempotencyKey)) {
    throw new CommandError("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)");
  }
  const commandId = req.idempotencyKey.toLowerCase();
  const hash = hashPayload(req.command, req.payload);
  const ids = { commandId, correlationId: req.correlationId };

  for (let attempt = 1; ; attempt++) {
    try {
      return await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
        const inserted = await sql<{ id: string }>`
          insert into idempotency_keys (id, organization_id, key, command, actor_person_id, request_hash, correlation_id)
          values (${randomUUID()}, ${actor.orgId}, ${commandId}, ${req.command}, ${actor.personId}, ${hash}, ${req.correlationId})
          on conflict (organization_id, key) do nothing
          returning id`.execute(trx);
        if (inserted.rows.length === 0) {
          const existing = await sql<StoredRow>`
            select status, request_hash, http_status, response from idempotency_keys
            where organization_id = ${actor.orgId} and key = ${commandId}`.execute(trx);
          const row = existing.rows[0] as StoredRow;
          if (!Buffer.from(row.request_hash).equals(hash)) {
            throw new CommandError("IDEMPOTENCY_CONFLICT", 409, "Idempotency-Key đã dùng cho yêu cầu khác");
          }
          return replay<T>(commandId, row);
        }

        const ctx: CommandContext = {
          trx,
          actor,
          commandId,
          correlationId: req.correlationId,
          audit: (e) => auditRow(trx, actor, ids, e, "success"),
          async emit(e) {
            await sql`
              insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload,
                                  correlation_id, command_id, dedupe_key)
              values (${randomUUID()}, ${actor.orgId}, ${e.propertyId ?? null}, ${e.eventType}, ${e.aggregateType ?? null},
                      ${e.aggregateId ?? null}, ${JSON.stringify(e.payload)}::jsonb, ${req.correlationId}, ${commandId},
                      ${e.dedupeKey ?? null})`.execute(trx);
          },
        };
        const { data, httpStatus = 200 } = await handler(ctx);
        await sql`
          update idempotency_keys set status = 'committed', http_status = ${httpStatus},
                 response = ${JSON.stringify({ data: redact(data) })}::jsonb, completed_at = now()
          where organization_id = ${actor.orgId} and key = ${commandId}`.execute(trx);
        return { status: "committed", commandId, httpStatus, data, replayed: false } as CommandResult<T>;
      });
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode && RETRYABLE.has(pgCode) && attempt < MAX_ATTEMPTS) continue;
      if (
        err instanceof CommandError &&
        (err.code === "IDEMPOTENCY_CONFLICT" || err.code === "MALFORMED_REQUEST")
      )
        throw err;
      const problem = toProblem(err, req.correlationId);
      if (problem.status >= 500) throw err;
      // Lỗi nghiệp vụ: transaction đã rollback (không audit/outbox nghiệp vụ). Ghi kết quả failed ở transaction riêng
      // để gửi lại cùng key trả cùng lỗi; lần bị từ chối được ghi audit outcome=denied.
      await withTenant(db, { orgId: actor.orgId }, async (trx) => {
        const ins = await sql<{ id: string }>`
          insert into idempotency_keys (id, organization_id, key, command, actor_person_id, request_hash, correlation_id,
                                        status, http_status, response, error_code, completed_at)
          values (${randomUUID()}, ${actor.orgId}, ${commandId}, ${req.command}, ${actor.personId}, ${hash}, ${req.correlationId},
                  'failed', ${problem.status}, ${JSON.stringify({ problem })}::jsonb, ${problem.code}, now())
          on conflict (organization_id, key) do nothing returning id`.execute(trx);
        if (ins.rows.length > 0) {
          await auditRow(
            trx,
            actor,
            ids,
            { action: "command.denied", entityType: req.command, reason: problem.code },
            "denied",
          );
        }
      });
      return { status: "failed", commandId, httpStatus: problem.status, problem, replayed: false };
    }
  }
}

export type CommandStatus =
  | { status: "committed"; data: unknown; httpStatus: number }
  | { status: "in_progress" }
  | { status: "failed"; problem: Problem; httpStatus: number };

const MANAGER_ROLES = new Set(["owner", "manager"]);

/** GET /api/v1/commands/{id}: chỉ người tạo (hoặc owner/manager) xem; còn lại → COMMAND_NOT_FOUND (404). */
export async function getCommandResult(
  db: Kysely<unknown>,
  actor: Actor,
  commandId: string,
): Promise<CommandStatus> {
  if (!UUID.test(commandId)) throw new CommandError("COMMAND_NOT_FOUND", 404, "Không tìm thấy lệnh");
  const row = await withTenant(db, { orgId: actor.orgId }, async (trx) => {
    const r = await sql<StoredRow & { actor_person_id: string }>`
      select status, request_hash, http_status, response, actor_person_id from idempotency_keys
      where organization_id = ${actor.orgId} and key = ${commandId.toLowerCase()}`.execute(trx);
    return r.rows[0];
  });
  if (!row || (row.actor_person_id !== actor.personId && !MANAGER_ROLES.has(actor.role))) {
    throw new CommandError("COMMAND_NOT_FOUND", 404, "Không tìm thấy lệnh");
  }
  if (row.status === "in_progress") return { status: "in_progress" };
  if (row.status === "committed")
    return { status: "committed", data: row.response?.data, httpStatus: row.http_status ?? 200 };
  return { status: "failed", problem: row.response?.problem as Problem, httpStatus: row.http_status ?? 500 };
}
