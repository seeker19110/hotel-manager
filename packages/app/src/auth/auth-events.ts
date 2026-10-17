// Sự kiện xác thực (T-405; SEC-LOG-001, CMP-AUDIT-002, IND-SAAS-009): đăng nhập thành công/thất bại, đăng xuất, bật/tắt MFA,
// khoá tài khoản, đổi mật khẩu — phát từ hook Better Auth (`auth.ts`).
// Mỗi sự kiện:
//  1. `logger.security` đúng hình dạng chuẩn (event/actor/target/outcome/source_ip/user_agent) — luôn phát, kể cả khi không có
//     tổ chức ngữ cảnh. KHÔNG ghi mật khẩu, OTP, mã TOTP, email (định danh chỉ là UUID người dùng).
//  2. Audit (`audit_events`, cột `source_ip`/`user_agent`) ở MỖI tổ chức mà người dùng đang có membership hiệu lực — owner của
//     tổ chức thấy ai đăng nhập/đổi bảo mật ở đâu (IND-SAAS-009). Quyết định có chủ ý: chỉ ghi audit cho sự kiện đã xác thực
//     hoặc chuyển trạng thái (đăng nhập OK, đăng xuất, bật/tắt MFA, đổi mật khẩu, khoá tài khoản) — KHÔNG ghi từng lần đăng nhập
//     sai: ai biết email cũng gây được chúng, bảng audit append-only nên sẽ bị làm đầy vĩnh viễn. Lần sai vẫn có ở log bảo mật.
//  3. (`app_runtime` chỉ có INSERT trên outbox ⇒ không dùng ON CONFLICT, vốn đòi SELECT; khoá dedupe chứa correlation_id mới.)
//     Đổi mật khẩu / tắt MFA → sự kiện outbox `member.*` ⇒ thông báo `account_security` cho chính người đó (notifications/dispatch.ts).
// Lỗi ghi audit/outbox KHÔNG làm hỏng đăng nhập (đã xác thực xong rồi): ghi `error` để người vận hành thấy.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import type pg from "pg";
import { currentTraceparent } from "../logging/index.ts";
import type { Logger } from "../logging/logger.ts";
import { appLogger } from "../logging/runtime.ts";
import {
  auditSource,
  emitSecurity,
  type SecurityClient,
  type SecurityEventName,
  type SecurityOutcome,
} from "../logging/security-events.ts";

export type AuthEventName = Extract<SecurityEventName, `auth.${string}`>;

export interface AuthEventInput {
  event: AuthEventName;
  outcome: SecurityOutcome;
  /** UUID người dùng (auth.user.id); null khi không xác định (đăng nhập sai email lạ…). */
  userId: string | null;
  /** Mã lý do ngắn (không văn bản tự do, không dữ liệu người dùng nhập). */
  reason?: string;
  client: SecurityClient;
  correlationId: string;
  /** Ghi audit ở các tổ chức của người dùng (chỉ sự kiện đã xác thực/chuyển trạng thái). */
  audit?: boolean;
  /** Báo cho chính người dùng (account_security) qua outbox — chỉ `password_changed`, `mfa_disabled`. */
  notify?: boolean;
}

/** Sự kiện xác thực cần báo người dùng → event_type outbox (consumer: `notifications/dispatch.ts`). */
export const AUTH_NOTIFY_EVENT: Readonly<Partial<Record<AuthEventName, string>>> = {
  "auth.password_changed": "member.password_changed",
  "auth.mfa_disabled": "member.mfa_disabled",
};

const CORRELATION_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** `x-correlation-id` của request nếu hợp lệ, không thì mã mới (không tin header: chỉ nhận ký tự an toàn, ≤ 64). */
export function correlationFrom(headers: Headers | undefined): string {
  const v = headers?.get("x-correlation-id");
  return v && CORRELATION_RE.test(v) ? v : randomUUID();
}

export interface AuthEvents {
  record(e: AuthEventInput): Promise<void>;
  /** UUID người dùng theo email (để gắn đích cho lần đăng nhập sai/khoá); không có → null. Email không bao giờ vào log. */
  userIdByEmail(email: string): Promise<string | null>;
}

/**
 * `pool`: kết nối vai trò app_runtime của Better Auth (search_path=auth) ⇒ bảng nghiệp vụ gọi bằng tên có schema `public.`.
 * `log`: logger cho sự kiện bảo mật (mặc định logger của tiến trình).
 */
export function createAuthEvents(pool: pg.Pool, log?: () => Logger): AuthEvents {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  async function auditAndNotify(e: AuthEventInput): Promise<void> {
    if (!e.userId) return;
    const src = auditSource(e.client);
    const orgs = await sql<{ organization_id: string; membership_id: string }>`
      select organization_id, membership_id from app.list_my_organizations(${e.userId}::uuid)`.execute(db);
    for (const o of orgs.rows) {
      await withTenant(db, { orgId: o.organization_id, actorId: o.membership_id }, async (trx) => {
        const m = await sql<{ person_id: string }>`
          select person_id from public.memberships where organization_id = ${o.organization_id} and id = ${o.membership_id}`.execute(
          trx,
        );
        const personId = m.rows[0]?.person_id;
        if (!personId) return;
        await sql`
          insert into public.audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id,
                                           reason, correlation_id, outcome, source_ip, user_agent)
          values (${randomUUID()}, ${o.organization_id}, 'user', ${personId}, ${e.event}, 'membership', ${o.membership_id},
                  ${e.reason ?? null}, ${e.correlationId}, ${e.outcome === "success" ? "success" : "denied"}, ${src.sourceIp},
                  ${src.userAgent})`.execute(trx);
        const eventType = e.notify ? AUTH_NOTIFY_EVENT[e.event] : undefined;
        if (eventType && e.outcome === "success") {
          await sql`
            insert into public.outbox (id, organization_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                                       dedupe_key, traceparent)
            values (${randomUUID()}, ${o.organization_id}, ${eventType}, 'membership', ${o.membership_id},
                    ${JSON.stringify({ membership_id: o.membership_id })}::jsonb, ${e.correlationId},
                    ${`${eventType}:${e.correlationId}:${o.membership_id}`}, ${currentTraceparent()})`.execute(
            trx,
          );
        }
      });
    }
  }

  return {
    async record(e) {
      const logger = log?.() ?? appLogger();
      emitSecurity({
        event: e.event,
        outcome: e.outcome,
        actor: e.userId ? { authUserId: e.userId } : null,
        target: { type: "account", id: e.userId },
        ...(e.reason ? { reason: e.reason } : {}),
        client: e.client,
        correlationId: e.correlationId,
        log: logger,
      });
      if (!e.audit) return;
      try {
        await auditAndNotify(e);
      } catch (err) {
        logger.error("ghi audit sự kiện xác thực thất bại", {
          event: e.event,
          correlation_id: e.correlationId,
          err,
        });
      }
    },
    async userIdByEmail(email) {
      const v = email.trim();
      if (!v || v.length > 320) return null;
      const r = await pool.query<{ id: string }>(
        'select id from auth."user" where lower(email) = lower($1)',
        [v],
      );
      return r.rows[0]?.id ?? null;
    },
  };
}
