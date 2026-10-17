// `org.create` (SPEC-access S-001): người dùng đã đăng nhập tạo tổ chức và trở thành owner (membership `owner`, mọi cơ sở).
// Tổ chức + person + membership + audit `organization.created` + outbox cùng MỘT transaction (INV-G6); cùng Idempotency-Key ⇒ cùng
// tổ chức (id suy ra từ người dùng + key, xem `provision.ts`). Owner cần MFA (Q-06) nên lệnh kế tiếp bị `MFA_REQUIRED` tới khi bật.
import { sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import { CommandError, type CommandResult } from "../pipeline/index.ts";
import { deriveUuid, readAuthUser, runUserCommand, type UserCommandRequest } from "./provision.ts";

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
