// Outbox relay (INV-G6, ARCHITECTURE bước 8): hàng outbox chưa phát → job pg-boss (mỗi event_type một queue)
// → handler. Job mang organization_id (IND-SAAS-003); retry có backoff; quá giới hạn → dead letter; lỗi vĩnh viễn
// (payload sai, lỗi nghiệp vụ 4xx) → dead letter ngay, không retry (BE-JOB-003).

import { runJobWithTrace } from "@hm/app/logging";
import { SECONDS_PER_DAY } from "@hm/app/units";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";

export const DEAD_LETTER_QUEUE = "outbox.dead_letter";

export interface OutboxJob {
  organization_id: string;
  outbox_id: string;
  event_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string;
  /**
   * W3C `traceparent` của span đã ghi sự kiện (`outbox.traceparent`, migration 0054): consumer chạy job như span con của nó nên log
   * của request và của job cùng `trace_id`. Thiếu/không hợp lệ ⇒ job mở trace mới. Job cũ trong queue chưa có trường này.
   */
  traceparent?: string | null;
}

/**
 * event_type được khai TƯỜNG MINH là "chỉ để audit" (D-026, sửa theo review lát 7): hiện chưa có consumer và không cần có —
 * dữ liệu nguồn nằm ở bảng nghiệp vụ + `audit_events`. Relay đánh dấu đã phát mà không sinh job. Một event_type KHÔNG có
 * consumer và KHÔNG nằm ở đây thì KHÔNG bị đánh dấu đã phát (ghi `last_error = 'no_consumer'`, lùi lần thử, log
 * `outbox.no_consumer`) để worker có consumer (hoặc bản triển khai sau) vẫn nhận được và cảnh báo `hm_outbox_*` thấy.
 * Thêm event_type mới vào outbox ⇒ thêm consumer HOẶC thêm vào đây (có test chặn quên: `outbox-event-types.test.ts`).
 */
export const AUDIT_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "allocation.confirmed",
  "allocation.held",
  "allocation.hold_expired",
  "allocation.moved",
  "allocation.released",
  "allocation.resized",
  "approval.requested",
  "block.approved",
  "block.ended",
  "block.requested",
  "exception.opened",
  "exception.resolved",
  "housekeeping.task_created",
  "housekeeping.task_done",
  "housekeeping.task_verified",
  "lease.activated",
  "lease.closed",
  "lease.created",
  "lease.expiring",
  "lease.renewed",
  "lease.settled",
  "lease.signed",
  "member.accepted",
  "member.role_changed",
  "member.scope_changed",
  "organization.created",
  "payment.confirmed",
  "payment_claim.submitted",
  "period.locked",
  "period.unlocked",
  "property.created",
  "property.updated",
  "reconciliation.break_opened",
  "reservation.cancelled",
  "reservation.confirmed",
  "reservation.held",
  "reservation.no_show",
  "session.revoked",
  "stay.checked_in",
  "stay.checked_out",
  "stay.notice_exported",
  "stay.notice_submitted",
  "unit.availability_changed",
  "work_order.created",
]);

export const NO_CONSUMER_ERROR = "no_consumer";

/**
 * Fair-share theo tổ chức (IND-SAAS-008, D-130). Relay: mỗi lượt claim lấy tối đa chừng này sự kiện của MỘT tổ chức (lô 100 ⇒ ≥ 10
 * tổ chức được phục vụ mỗi lượt khi cùng có backlog). Consumer: mỗi queue chạy `CONSUMER_CONCURRENCY` job song song nhưng tối đa
 * `CONSUMER_GROUP_CONCURRENCY` job của CÙNG một tổ chức trong một tiến trình worker (pg-boss `localGroupConcurrency`) ⇒
 * backlog của A chỉ chiếm một suất, job của B lấy suất còn lại; job cùng tổ chức vẫn chạy tuần tự như trước.
 */
export const RELAY_PER_ORG = 10;
export const CONSUMER_CONCURRENCY = 2;
export const CONSUMER_GROUP_CONCURRENCY = 1;

export interface QueuePolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  /** Trần (giây) của thời gian chờ giữa hai lần thử khi backoff mũ — tường minh, không để mặc định "không giới hạn". */
  retryDelayMax?: number;
}

/** BE-JOB-003: 5 lần thử, chờ 5 s · 2^n có jitter (công thức pg-boss), trần 5 phút. */
export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
};

/** Dead letter giữ lâu hơn queue gốc (mặc định pg-boss: 14 ngày chờ, 7 ngày sau khi xong) để người kịp xử lý (BE-JOB-004). */
export const DEAD_LETTER_RETENTION_SECONDS = 30 * SECONDS_PER_DAY;

/** pg-boss queue name: chữ thường, số, `.`/`_`/`-` — event_type đã đúng dạng `a.b`. */
export async function ensureQueues(
  boss: PgBoss,
  eventTypes: readonly string[],
  policy = DEFAULT_QUEUE_POLICY,
): Promise<void> {
  await boss.createQueue(DEAD_LETTER_QUEUE, {
    retentionSeconds: DEAD_LETTER_RETENTION_SECONDS,
    deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
  });
  for (const name of eventTypes) {
    await boss.createQueue(name, { ...policy, deadLetter: DEAD_LETTER_QUEUE });
  }
}

/**
 * `true` khi chạy lại không khỏi: payload sai schema, hoặc lỗi nghiệp vụ 4xx — trừ 408/429 (quá hạn/giới hạn tần suất) và 409
 * (VERSION_CONFLICT/tranh chấp ghi tạm thời: lần chạy sau đọc lại phiên bản mới nên có thể thành công ⇒ retry theo backoff).
 */
export function isPermanentJobError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { permanent?: unknown; status?: unknown };
  if (e.permanent === true) return true;
  return (
    typeof e.status === "number" &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 409 &&
    e.status !== 429
  );
}

/**
 * Chuyển tối đa `batch` hàng chưa phát sang pg-boss — claim → commit → gửi → đánh dấu (T-401, ARC-INT-003, DB-TX-003):
 *  1. `app.outbox_claim` (FOR UPDATE SKIP LOCKED) đặt lease 60 giây cho hàng lấy được trong MỘT câu lệnh tự commit nên
 *     nhiều relay song song không phát trùng và KHÔNG giữ transaction/khoá trong lúc gọi mạng;
 *  2. `boss.send` NGOÀI transaction, job id = outbox.id (khoá chính (name, id) của pg-boss: gửi lại là no-op, trả null);
 *  3. `app.outbox_mark` đánh dấu đã phát, hoặc ghi `last_error` + lùi lần thử (backoff) khi lỗi.
 * Sập giữa 2 và 3 ⇒ hết lease hàng được claim lại, `send` trùng không tạo job thứ hai ⇒ không mất, không trùng.
 * `opts.consumed`: tập event_type có consumer ở worker này. Loại khác: nằm trong `opts.auditOnly` (mặc định
 * `AUDIT_ONLY_EVENT_TYPES`) ⇒ đánh dấu đã phát không sinh job; không nằm trong đó ⇒ KHÔNG đánh dấu đã phát, ghi
 * `no_consumer`, log `outbox.no_consumer`, lùi lần thử (không kẹt đầu hàng; worker khác có consumer vẫn nhận được).
 * Fair-share (IND-SAAS-008, D-130, migration 0073): claim lấy theo VÒNG TRÒN — mỗi tổ chức tối đa `opts.perOrg` (mặc định
 * `RELAY_PER_ORG`) hàng mỗi lượt, trả theo thứ tự vòng ⇒ tổ chức dồn hàng nghìn sự kiện không chặn tổ chức khác (sự kiện của B vào
 * pg-boss ngay lượt đầu). Job mang `group.id = organization_id` để consumer giới hạn đồng thời theo tổ chức (`startConsumers`).
 * Trả số hàng đã claim.
 */
export async function relayOutbox(
  workerDb: Kysely<unknown>,
  boss: PgBoss,
  batch = 100,
  opts: {
    /** Trần hàng mỗi tổ chức mỗi lượt claim (mặc định `RELAY_PER_ORG`). */
    perOrg?: number;
    consumed?: ReadonlySet<string>;
    auditOnly?: ReadonlySet<string>;
    log?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<number> {
  const auditOnly = opts.auditOnly ?? AUDIT_ONLY_EVENT_TYPES;
  // (1) Một câu lệnh = một transaction tự commit: lease đã bền trước khi gọi pg-boss.
  const claimed = await sql<{
    id: string;
    organization_id: string;
    event_type: string;
    aggregate_id: string | null;
    payload: Record<string, unknown>;
    correlation_id: string;
    traceparent: string | null;
  }>`select * from app.outbox_claim(${batch}, ${opts.perOrg ?? RELAY_PER_ORG})`.execute(workerDb);
  for (const r of claimed.rows) {
    let error: string | null = null;
    if (opts.consumed && !opts.consumed.has(r.event_type)) {
      if (!auditOnly.has(r.event_type)) {
        opts.log?.("outbox.no_consumer", { event_type: r.event_type, outbox_id: r.id });
        error = NO_CONSUMER_ERROR;
      }
    } else {
      const job: OutboxJob = {
        organization_id: r.organization_id,
        outbox_id: r.id,
        event_type: r.event_type,
        aggregate_id: r.aggregate_id,
        payload: r.payload,
        correlation_id: r.correlation_id,
        traceparent: r.traceparent,
      };
      try {
        await boss.send(r.event_type, job, { id: r.id, group: { id: r.organization_id } });
      } catch (err) {
        error = String((err as Error).message);
      }
    }
    try {
      await sql`select app.outbox_mark(${r.id}::uuid, ${error})`.execute(workerDb);
    } catch (err) {
      // Không đánh dấu được (CSDL chập chờn): hàng được claim lại khi hết lease, gửi lại là no-op ở pg-boss.
      opts.log?.("outbox.mark_failed", { outbox_id: r.id, error: String((err as Error).message) });
    }
  }
  return claimed.rows.length;
}

export type EventHandler = (job: OutboxJob) => Promise<void>;

/**
 * Đăng ký handler cho từng event_type. Handler phải idempotent theo `outbox_id` (job có thể chạy lại khi retry).
 * Lỗi VĨNH VIỄN (`isPermanentJobError`) không retry: job được chép sang dead letter (cùng id, kèm `dead_letter` lý do)
 * rồi hoàn tất ở queue gốc, log `job.permanent_failure`. Lỗi khác ném lại cho pg-boss retry theo chính sách queue.
 */
export async function startConsumers(
  boss: PgBoss,
  handlers: Readonly<Record<string, EventHandler>>,
  opts: {
    pollingIntervalSeconds?: number;
    /** Số job song song mỗi queue (mặc định `CONSUMER_CONCURRENCY`); tối đa `CONSUMER_GROUP_CONCURRENCY` job mỗi tổ chức. */
    concurrency?: number;
    log?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  for (const [name, handler] of Object.entries(handlers)) {
    await boss.work<OutboxJob>(
      name,
      {
        pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
        localConcurrency: opts.concurrency ?? CONSUMER_CONCURRENCY,
        // `localGroupConcurrency` (pg-boss chỉ cho chọn MỘT trong hai kiểu): chặn CHẮC trong một tiến trình — job vượt được trả lại
        // hàng đợi, lượt lấy sau bỏ qua nhóm đang đầy. `groupConcurrency` (đếm qua CSDL) bị loại: hai worker cùng lấy một lúc đều
        // thấy nhóm rảnh ⇒ chạy khoá bước A,A (đo ở relay-fair-share.db.test.ts). Nhiều tiến trình worker ⇒ A tối đa 1 suất/tiến trình.
        localGroupConcurrency: CONSUMER_GROUP_CONCURRENCY,
      },
      async (jobs) => {
        for (const j of jobs) {
          // Mỗi job một span riêng, nối tiếp trace của request sinh ra sự kiện: mọi log trong handler và log
          // "job.permanent_failure" bên dưới mang cùng `trace_id`/`span_id`.
          await runJobWithTrace(j.data?.traceparent, async () => {
            try {
              await handler(j.data);
            } catch (err) {
              if (!isPermanentJobError(err)) throw err;
              const message = String((err as Error).message).slice(0, 500);
              // Gửi dead letter TRƯỚC khi hoàn tất job gốc: gửi lỗi ⇒ ném ⇒ pg-boss retry; id cố định ⇒ gửi lại là no-op.
              await boss.send(
                DEAD_LETTER_QUEUE,
                { ...j.data, dead_letter: { kind: "permanent", message } },
                { id: j.id },
              );
              opts.log?.("job.permanent_failure", {
                event_type: name,
                outbox_id: j.data?.outbox_id,
                reason: message,
              });
            }
          });
        }
      },
    );
  }
}
