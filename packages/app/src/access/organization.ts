// `org.create` (SPEC-access S-001): người dùng đã đăng nhập tạo tổ chức và trở thành owner (membership `owner`, mọi cơ sở).
// Tổ chức + person + membership + audit `organization.created` + outbox cùng MỘT transaction (INV-G6); cùng Idempotency-Key ⇒ cùng
// tổ chức (id suy ra từ người dùng + key, xem `provision.ts`). Owner cần MFA (Q-06) nên lệnh kế tiếp bị `MFA_REQUIRED` tới khi bật.
import { SECONDS_PER_HOUR } from "@hm/domain";
import { sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import { CommandError, type CommandResult, rateLimited, rateLimitHit } from "../pipeline/index.ts";
import { deriveUuid, readAuthUser, runUserCommand, type UserCommandRequest } from "./provision.ts";

/**
 * Hạn mức `org.create` theo NGƯỜI DÙNG (IND-SAAS-008): tối đa chừng này tổ chức MỚI/giờ/tài khoản. Hạn mức lệnh của pipeline đếm
 * theo tổ chức/person suy ra từ (người dùng, Idempotency-Key) nên mỗi key mới có bộ đếm 0 — không chặn được script tạo hàng
 * loạt tổ chức (làm phình bảng, nhiễu tenant). 10/giờ vượt xa nhu cầu thật (một chủ trọ lập vài tổ chức), chỉ chặn lạm dụng.
 * Chỉ lượt THÀNH CÔNG tính: đếm chạy trong `bootstrap` (cùng transaction — lệnh lỗi/rollback thì bộ đếm cũng rollback; replay cùng
 * key không chạy `bootstrap` nên không tốn thêm). Cố định theo mã (không biến môi trường).
 */
export const ORG_CREATE_PER_USER_PER_HOUR = 10;
const ORG_CREATE_WINDOW_SECONDS = SECONDS_PER_HOUR;

export interface CreatedOrganization {
  organizationId: string;
  membershipId: string;
}

export function createOrganization(
  req: UserCommandRequest,
  input: { name: string },
): Promise<CommandResult<CreatedOrganization>> {
  const name = input.name.trim();
  const orgId = deriveUuid("org.create:org", req.userId, req.key);
  const membershipId = deriveUuid("org.create:membership", req.userId, req.key);
  const personId = deriveUuid("org.create:person", req.userId, req.key);
  const actor: Actor = {
    authUserId: req.userId,
    orgId,
    membershipId,
    personId,
    role: "owner",
    allProperties: true,
    propertyIds: [],
    limits: {},
    mfaRequired: true,
  };
  return runUserCommand<CreatedOrganization>(req, {
    command: "org.create",
    actor,
    bootstrap: async (trx) => {
      const user = await readAuthUser(trx, req.userId);
      if (!user) throw new CommandError("UNAUTHENTICATED", 401, "Cần đăng nhập");
      const hit = await rateLimitHit(trx, {
        scope: "org.create:user",
        subject: req.userId,
        limit: ORG_CREATE_PER_USER_PER_HOUR,
        windowSeconds: ORG_CREATE_WINDOW_SECONDS,
      });
      if (!hit.allowed) {
        throw rateLimited("Bạn tạo quá nhiều tổ chức trong một giờ. Vui lòng thử lại sau.", hit.retryAfter);
      }
      await sql`insert into organizations (id, name, created_by) values (${orgId}, ${name}, ${req.userId})`.execute(
        trx,
      );
      await sql`insert into persons (id, organization_id, full_name, email)
                values (${personId}, ${orgId}, ${user.name.trim().slice(0, 200) || user.email}, ${user.email})`.execute(
        trx,
      );
      await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
                values (${membershipId}, ${orgId}, ${req.userId}, ${personId}, 'owner', true)`.execute(trx);
    },
    handler: async (ctx) => {
      await ctx.audit({
        action: "organization.created",
        entityType: "organization",
        entityId: orgId,
        after: { name, owner_membership_id: membershipId },
      });
      await ctx.emit({
        eventType: "organization.created",
        aggregateType: "organization",
        aggregateId: orgId,
        payload: { organization_id: orgId, membership_id: membershipId },
      });
      return { data: { organizationId: orgId, membershipId }, httpStatus: 201 };
    },
  });
}
