// Command pipeline (ARCHITECTURE "Luồng một command ghi"): idempotency (INV-G5) → quyền → nghiệp vụ →
// audit_events + outbox CÙNG transaction (INV-G6) → kết quả lưu theo command_id; retry 40001/40P01 (DB-TX-002).
import { createHash, randomUUID } from "node:crypto";
import {
  isTransientTxError,
  REQUEST_TX_RETRY,
  type RetryDeps,
  type RetryPolicy,
  retryAsync,
  withTenant,
} from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import { t } from "../i18n.ts";
import {
  appLogger,
  auditSource,
  type CommandSecurityInput,
  currentTraceparent,
  emitSecurity,
  redact,
  type SecurityClient,
  securityEventForProblem,
} from "../logging/index.ts";
import { CommandError, idempotencyInProgress, type Problem, rateLimited, toProblem } from "./problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hạn mức lệnh ghi theo TỔ CHỨC (IND-SAAS-008): tối đa chừng này lệnh MỚI (Idempotency-Key chưa từng thấy) trong 60 giây
 * trượt; vượt ⇒ 429 RATE_LIMITED + `Retry-After`, KHÔNG lưu kết quả (gửi lại cùng key sau khi hết giới hạn chạy bình thường).
 * Một tổ chức bão hoà hạn mức không chiếm tài nguyên của tổ chức khác. Đếm ngay trong CSDL (`idempotency_keys`) nên đúng khi
 * nhiều instance. 600/phút ≈ 10 lệnh/giây — gấp nhiều lần mức thao tác tay của một khách sạn nhỏ, chỉ chặn script/lỗi vòng
 * lặp. Đây là mặc định của pipeline (= gói `standard`, test `plans.test.ts` giữ khớp); route lệnh truyền hạn mức THEO GÓI của tổ chức (`planFor`, D-123). Cố định theo mã (không biến môi trường).
 *
 * Chỉ lệnh `committed`/`in_progress` tính vào hạn mức TỔ CHỨC: lệnh bị từ chối (401/403/404/409/422… — kết quả `failed`) do
 * chính người gửi tự gây ra, không được phép làm cạn hạn mức của cả tổ chức (một người thuê/nhân viên spam lệnh 403 không
 * chặn được owner ghi). Lệnh lỗi vẫn tính vào hạn mức THÀNH VIÊN bên dưới. (5xx không để lại hàng: transaction rollback.)
 */
export const COMMAND_QUOTA_PER_MINUTE = 600;
/**
 * Hạn mức lệnh ghi theo THÀNH VIÊN (kể cả người thuê): mọi lệnh MỚI của một thành viên (cả lệnh bị từ chối), 60 giây trượt;
 * kiểm TRƯỚC hạn mức tổ chức nên kẻ spam chỉ tự chặn mình. Nhỏ hơn hạn mức tổ chức (200/phút ≈ 3 lệnh/giây — vượt xa thao
 * tác tay của một người). Khoá đếm là `actor_person_id` của `idempotency_keys`; mỗi thành viên có đúng một person trong tổ chức
 * (`uq_memberships_person`) nên tương đương theo `membershipId`.
 */
export const COMMAND_MEMBER_QUOTA_PER_MINUTE = 200;
const QUOTA_WINDOW_SECONDS = 60;

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
  /**
   * Bù trừ cho tác dụng phụ NGOÀI transaction (vd. object storage): chạy khi lần thử này không commit được (lỗi
   * nghiệp vụ, lỗi commit, hay 40001/40P01 trước khi thử lại). Lỗi của hàm bù trừ được ghi log, không che lỗi gốc.
   */
  onRollback(fn: () => Promise<void>): void;
  /**
   * Sự kiện bảo mật của hành động THÀNH CÔNG (SEC-LOG-001): chỉ phát SAU khi transaction commit (không ghi "đã thu hồi" cho
   * thao tác rồi rollback; không phát lại khi replay cùng Idempotency-Key). Người thao tác/IP/UA/correlation tự gắn.
   */
  security(e: CommandSecurityInput): void;
}

export type CommandResult<T> =
  | { status: "committed"; commandId: string; httpStatus: number; data: T; replayed: boolean }
  | { status: "failed"; commandId: string; httpStatus: number; problem: Problem; replayed: boolean };

export interface CommandRequest {
  command: string;
  idempotencyKey: string | null | undefined;
  payload: unknown;
  correlationId: string;
  /** IP/User-Agent của request, để gắn vào sự kiện bảo mật (không dùng cho nghiệp vụ). */
  client?: SecurityClient;
  /** Ghi đè hạn mức lệnh/phút/tổ chức (test); mặc định `COMMAND_QUOTA_PER_MINUTE`. */
  quotaPerMinute?: number;
  /** Ghi đè hạn mức lệnh/phút/thành viên (test); mặc định `COMMAND_MEMBER_QUOTA_PER_MINUTE`. */
  memberQuotaPerMinute?: number;
  /** Chính sách chạy lại khi 40001/40P01 (mặc định `REQUEST_TX_RETRY`) và nguồn ngẫu nhiên/đồng hồ/chờ tiêm cho test. */
  retry?: RetryDeps & { policy?: RetryPolicy };
  /**
   * Lệnh "cấp người dùng" (tạo tổ chức, chấp nhận lời mời): người gọi CHƯA là thành viên nên `actor` là bản dựng sẵn (id tất định
   * theo Idempotency-Key) và hàng tổ chức/person/membership của nó do hàm này ghi — CÙNG transaction với lệnh, ngay trước khoá
   * idempotency (khoá có FK tới person). Chỉ chạy khi khoá CHƯA có (replay không chạy lại). Ném `CommandError` ⇒ transaction
   * rollback và lỗi ném thẳng ra ngoài (KHÔNG ghi kết quả `failed`: tổ chức/person của actor chưa từng tồn tại nên không có chỗ ghi).
   */
  bootstrap?: (trx: Transaction<unknown>) => Promise<void>;
}

/** Lỗi của `bootstrap`: đi thẳng ra ngoài `executeCommand`, bỏ qua đường ghi kết quả `failed` (xem `CommandRequest.bootstrap`). */
class BootstrapFailure extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(t("pipeline.bootstrap_failed"));
    this.name = "BootstrapFailure";
    this.original = original;
  }
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

/** Băm định danh yêu cầu (lệnh + payload chuẩn hoá) để phát hiện cùng key khác payload (IDEMPOTENCY_CONFLICT). */
export function hashPayload(command: string, payload: unknown): Buffer {
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
  client: SecurityClient | null | undefined,
) {
  // "Từ đâu" (CMP-AUDIT-002): IP đã cắt + UA làm sạch; không có client (worker/hệ thống) ⇒ null.
  const src = auditSource(client);
  // Hỗ trợ nền tảng (F-015, D-122): dòng audit mang `actor_type = platform_support` + tham chiếu grant; lý do mặc định = lý do của grant.
  const support = actor.role === "platform_support" ? (actor.supportGrant ?? null) : null;
  await sql`
    insert into audit_events (id, organization_id, property_id, actor_type, actor_person_id, action, entity_type, entity_id,
                              before, after, reason, correlation_id, command_id, outcome, source_ip, user_agent,
                              support_grant_id)
    values (${randomUUID()}, ${actor.orgId}, ${e.propertyId ?? null}, ${support ? "platform_support" : "user"}, ${actor.personId},
            ${e.action}, ${e.entityType},
            ${e.entityId ?? null}, ${e.before === undefined ? null : JSON.stringify(redact(e.before))}::jsonb,
            ${e.after === undefined ? null : JSON.stringify(redact(e.after))}::jsonb, ${e.reason ?? support?.reason ?? null},
            ${ids.correlationId}, ${ids.commandId}, ${outcome}, ${src.sourceIp}, ${src.userAgent}, ${support?.id ?? null})`.execute(
    trx,
  );
}

/** Lệnh vẫn chạy khi tổ chức chờ xoá (T-2312): xuất dữ liệu và huỷ yêu cầu xoá. */
export const PENDING_DELETION_ALLOWED: ReadonlySet<string> = new Set([
  "exports.request",
  "exports.requestOrgExport",
  "exports.download",
  "org.cancelDeletion",
]);

interface QuotaLimits {
  org: number;
  member: number;
}

/**
 * Số giây phải đợi nếu thành viên (kiểm trước) hoặc tổ chức đã dùng hết hạn mức lệnh trong 60 giây gần nhất (0 = còn hạn
 * mức) + phạm vi bị chặn. Lệnh gửi lại với key đã có (replay, ở BẤT KỲ độ cũ nào — `idempotency_keys` giữ 7 ngày) không tốn
 * hạn mức nên không bao giờ bị chặn.
 */
async function quotaWait(
  db: Kysely<unknown>,
  actor: Actor,
  commandId: string,
  limits: QuotaLimits,
): Promise<{ wait: number; scope: "member" | "org" } | null> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const window = sql`created_at > now() - make_interval(secs => ${QUOTA_WINDOW_SECONDS})`;
    const r = await sql<{ replay: boolean; member_n: number; org_n: number }>`
      select exists (select 1 from idempotency_keys where organization_id = ${actor.orgId} and key = ${commandId}) as replay,
             (select count(*)::int from idempotency_keys
               where organization_id = ${actor.orgId} and actor_person_id = ${actor.personId} and ${window}) as member_n,
             (select count(*)::int from idempotency_keys
               where organization_id = ${actor.orgId} and status in ('committed', 'in_progress') and ${window}) as org_n`.execute(
      trx,
    );
    const { replay, member_n, org_n } = r.rows[0] ?? { replay: false, member_n: 0, org_n: 0 };
    if (replay) return null;
    // Thành viên TRƯỚC tổ chức: kẻ spam bị chặn bằng hạn mức riêng của mình.
    const scopes = [
      {
        scope: "member" as const,
        n: member_n,
        limit: limits.member,
        filter: sql`actor_person_id = ${actor.personId}`,
      },
      {
        scope: "org" as const,
        n: org_n,
        limit: limits.org,
        filter: sql`status in ('committed', 'in_progress')`,
      },
    ];
    for (const { scope, n, limit, filter } of scopes) {
      if (n < limit) continue;
      // Hàng thứ (n - limit + 1) từ cũ nhất rời cửa sổ ⇒ còn limit - 1 hàng ⇒ lệnh mới vào được.
      const edge = await sql<{ wait: number }>`
        select ceil(extract(epoch from created_at + make_interval(secs => ${QUOTA_WINDOW_SECONDS}) - now()))::int as wait
        from idempotency_keys
        where organization_id = ${actor.orgId} and ${filter} and ${window}
        order by created_at offset ${n - limit} limit 1`.execute(trx);
      return { wait: Math.max(1, edge.rows[0]?.wait ?? QUOTA_WINDOW_SECONDS), scope };
    }
    return null;
  });
}

export async function executeCommand<T>(
  db: Kysely<unknown>,
  actor: Actor,
  req: CommandRequest,
  handler: (ctx: CommandContext) => Promise<{ data: T; httpStatus?: number }>,
): Promise<CommandResult<T>> {
  if (!req.idempotencyKey || !UUID.test(req.idempotencyKey)) {
    throw new CommandError("MALFORMED_REQUEST", 400, t("http.idempotency_key_invalid"));
  }
  const commandId = req.idempotencyKey.toLowerCase();
  const hash = hashPayload(req.command, req.payload);
  const ids = { commandId, correlationId: req.correlationId };

  const blocked = await quotaWait(db, actor, commandId, {
    org: req.quotaPerMinute ?? COMMAND_QUOTA_PER_MINUTE,
    member: req.memberQuotaPerMinute ?? COMMAND_MEMBER_QUOTA_PER_MINUTE,
  });
  if (blocked) {
    // 429 không lưu vào idempotency_keys: retry cùng key sau Retry-After phải chạy được, không dính kết quả lỗi cũ.
    const problem = toProblem(
      rateLimited(
        blocked.scope === "member" ? t("pipeline.rate_limit.member") : t("pipeline.rate_limit.org"),
        blocked.wait,
      ),
      req.correlationId,
    );
    emitSecurity({
      event: "rate_limit.exceeded",
      outcome: "denied",
      actor,
      target: { type: "command", id: req.command },
      reason: problem.code,
      client: req.client ?? null,
      correlationId: req.correlationId,
    });
    return { status: "failed", commandId, httpStatus: 429, problem, replayed: false };
  }

  // Một lần thử = một transaction mới; lỗi ⇒ chạy bù trừ của CHÍNH lần thử đó rồi ném tiếp (retryAsync quyết thử lại hay không).
  const attemptOnce = async (): Promise<CommandResult<T>> => {
    const compensations: (() => Promise<void>)[] = [];
    const afterCommit: (() => void)[] = [];
    try {
      const result = await withTenant(
        db,
        { orgId: actor.orgId, actorId: actor.membershipId },
        async (trx) => {
          // D-043 (BE-API-008): lần đầu cùng key còn chạy (chưa commit) giữ khoá này tới hết transaction ⇒ request đồng
          // thời không chờ trên unique index (giữ kết nối CSDL) mà trả ngay 409 IDEMPOTENCY_IN_PROGRESS. Lần đầu đã commit
          // (khoá đã nhả) ⇒ lấy được khoá, `on conflict` thấy hàng đã commit ⇒ replay như cũ.
          const free = await sql<{ ok: boolean }>`
          select pg_try_advisory_xact_lock(hashtextextended(${`idem:${actor.orgId}:${commandId}`}, 0)) as ok`.execute(
            trx,
          );
          if (!free.rows[0]?.ok) throw idempotencyInProgress();
          if (req.bootstrap) {
            const known = await sql<{ one: number }>`
              select 1 as one from idempotency_keys where organization_id = ${actor.orgId} and key = ${commandId}`.execute(
              trx,
            );
            if (known.rows.length === 0) {
              try {
                await req.bootstrap(trx);
              } catch (err) {
                if (isTransientTxError(err)) throw err; // để retryAsync chạy lại cả lần thử
                throw new BootstrapFailure(err);
              }
            }
          }
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
              throw new CommandError("IDEMPOTENCY_CONFLICT", 422, t("http.idempotency_conflict"));
            }
            return replay<T>(commandId, row);
          }

          const ctx: CommandContext = {
            trx,
            actor,
            commandId,
            correlationId: req.correlationId,
            audit: (e) => auditRow(trx, actor, ids, e, "success", req.client),
            async emit(e) {
              await sql`
              insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload,
                                  correlation_id, command_id, dedupe_key, traceparent)
              values (${randomUUID()}, ${actor.orgId}, ${e.propertyId ?? null}, ${e.eventType}, ${e.aggregateType ?? null},
                      ${e.aggregateId ?? null}, ${JSON.stringify(e.payload)}::jsonb, ${req.correlationId}, ${commandId},
                      ${e.dedupeKey ?? null}, ${currentTraceparent()})`.execute(trx);
            },
            onRollback: (fn) => {
              compensations.push(fn);
            },
            security: (e) => {
              afterCommit.push(() =>
                emitSecurity({
                  ...e,
                  outcome: e.outcome ?? "success",
                  actor,
                  client: req.client ?? null,
                  correlationId: req.correlationId,
                }),
              );
            },
          };
          // F-015 (D-122): hỗ trợ nền tảng CHỈ ĐỌC — mọi lệnh ghi bị từ chối trước nghiệp vụ (kết quả `failed` + audit `denied` có
          // tham chiếu grant ở nhánh lỗi bên dưới). CSDL chặn thêm bằng policy `support_read_only_*` (migration 0071).
          if (actor.role === "platform_support")
            throw new CommandError("FORBIDDEN", 403, t("pipeline.support_read_only"));
          // T-2312 (D-121): tổ chức đang chờ xoá ⇒ chỉ đọc + xuất; lệnh ghi khác bị từ chối 423 trước nghiệp vụ (kết quả `failed` + audit).
          if (!PENDING_DELETION_ALLOWED.has(req.command)) {
            const st = await sql<{ pending: boolean }>`
              select deletion_requested_at is not null as pending from organizations where id = ${actor.orgId}`.execute(
              trx,
            );
            if (st.rows[0]?.pending)
              throw new CommandError("ORG_PENDING_DELETION", 423, t("pipeline.org_pending_deletion"));
          }
          const { data, httpStatus = 200 } = await handler(ctx);
          await sql`
          update idempotency_keys set status = 'committed', http_status = ${httpStatus},
                 response = ${JSON.stringify({ data: redact(data) })}::jsonb, completed_at = now()
          where organization_id = ${actor.orgId} and key = ${commandId}`.execute(trx);
          return { status: "committed", commandId, httpStatus, data, replayed: false } as CommandResult<T>;
        },
      );
      for (const fn of afterCommit) fn(); // emitSecurity không ném lỗi
      return result;
    } catch (err) {
      for (const r of await Promise.allSettled(compensations.map((fn) => fn()))) {
        // Không che lỗi gốc, nhưng không im lặng: tác dụng phụ còn sót cần người/job dọn.
        if (r.status === "rejected")
          appLogger().error(t("pipeline.log.compensation_failed"), {
            command: req.command,
            command_id: commandId,
            correlation_id: req.correlationId,
            err: r.reason,
          });
      }
      throw err;
    }
  };

  // DB-TX-002: 40001/40P01 ⇒ chạy lại toàn bộ lần thử (lùi mũ + jitter, trần số lần/thời gian); lỗi khác đi thẳng xuống xử lý bên dưới.
  try {
    return await retryAsync(attemptOnce, {
      policy: req.retry?.policy ?? REQUEST_TX_RETRY,
      classify: isTransientTxError,
      ...(req.retry?.random ? { random: req.retry.random } : {}),
      ...(req.retry?.sleep ? { sleep: req.retry.sleep } : {}),
      ...(req.retry?.now ? { now: req.retry.now } : {}),
      onRetry: ({ attempt, delayMs, error }) =>
        appLogger().warn(t("pipeline.log.tx_retry"), {
          command: req.command,
          command_id: commandId,
          correlation_id: req.correlationId,
          attempt,
          delay_ms: delayMs,
          err: error,
        }),
    });
  } catch (err) {
    if (err instanceof BootstrapFailure) throw err.original;
    // Lệnh cấp người dùng: tổ chức/person của actor chỉ tồn tại sau commit nên không có chỗ ghi kết quả `failed` — ném thẳng.
    if (req.bootstrap) throw err;
    if (
      err instanceof CommandError &&
      (err.code === "IDEMPOTENCY_CONFLICT" ||
        err.code === "IDEMPOTENCY_IN_PROGRESS" ||
        err.code === "MALFORMED_REQUEST")
    )
      throw err;
    const problem = toProblem(err, req.correlationId);
    if (problem.status >= 500) throw err;
    // Lỗi nghiệp vụ: transaction đã rollback (không audit/outbox nghiệp vụ). Ghi kết quả failed ở transaction riêng
    // để gửi lại cùng key trả cùng lỗi; lần bị từ chối được ghi audit outcome=denied.
    let finalProblem = problem;
    await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
      const ins = await sql<{ id: string }>`
          insert into idempotency_keys (id, organization_id, key, command, actor_person_id, request_hash, correlation_id,
                                        status, http_status, response, error_code, completed_at)
          values (${randomUUID()}, ${actor.orgId}, ${commandId}, ${req.command}, ${actor.personId}, ${hash}, ${req.correlationId},
                  'failed', ${problem.status}, ${JSON.stringify({ problem })}::jsonb, ${problem.code}, now())
          on conflict (organization_id, key) do nothing returning id`.execute(trx);
      if (ins.rows.length > 0) {
        if (err instanceof CommandError && err.persist) {
          finalProblem = {
            ...problem,
            ...(await err.persist(trx, (e) => auditRow(trx, actor, ids, e, "success", req.client))),
          };
          await sql`
              update idempotency_keys set response = ${JSON.stringify({ problem: finalProblem })}::jsonb
              where organization_id = ${actor.orgId} and key = ${commandId}`.execute(trx);
        }
        await auditRow(
          trx,
          actor,
          ids,
          { action: "command.denied", entityType: req.command, reason: problem.code },
          "denied",
          req.client,
        );
      } else {
        // Request song song cùng key đã ghi kết quả trước: trả đúng kết quả đã lưu.
        const stored = await sql<StoredRow>`
            select status, request_hash, http_status, response from idempotency_keys
            where organization_id = ${actor.orgId} and key = ${commandId}`.execute(trx);
        const p = stored.rows[0]?.response?.problem;
        if (p) finalProblem = p;
      }
    });
    // Từ chối do xác thực/quyền/giới hạn tần suất → sự kiện bảo mật (một lần cho mỗi Idempotency-Key; replay không vào đây).
    const securityEvent = securityEventForProblem(finalProblem);
    if (securityEvent)
      emitSecurity({
        event: securityEvent,
        outcome: "denied",
        actor,
        target: { type: "command", id: req.command },
        reason: finalProblem.code,
        client: req.client ?? null,
        correlationId: req.correlationId,
      });
    return {
      status: "failed",
      commandId,
      httpStatus: finalProblem.status,
      problem: finalProblem,
      replayed: false,
    };
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
  if (!UUID.test(commandId))
    throw new CommandError("COMMAND_NOT_FOUND", 404, t("pipeline.command_not_found"));
  const row = await withTenant(db, { orgId: actor.orgId }, async (trx) => {
    const r = await sql<StoredRow & { actor_person_id: string }>`
      select status, request_hash, http_status, response, actor_person_id from idempotency_keys
      where organization_id = ${actor.orgId} and key = ${commandId.toLowerCase()}`.execute(trx);
    return r.rows[0];
  });
  if (!row || (row.actor_person_id !== actor.personId && !MANAGER_ROLES.has(actor.role))) {
    throw new CommandError("COMMAND_NOT_FOUND", 404, t("pipeline.command_not_found"));
  }
  if (row.status === "in_progress") return { status: "in_progress" };
  if (row.status === "committed")
    return { status: "committed", data: row.response?.data, httpStatus: row.http_status ?? 200 };
  return { status: "failed", problem: row.response?.problem as Problem, httpStatus: row.http_status ?? 500 };
}
