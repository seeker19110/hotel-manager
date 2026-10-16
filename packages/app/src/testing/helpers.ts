// Helper CHỈ cho test (*.db.test.ts): thành viên theo vai trò, chạy command qua pipeline thật. Không import từ mã chạy.
import { randomUUID } from "node:crypto";
import type { SeededOrg, TestDb } from "@hm/testkit";
import { seedAuthUser } from "@hm/testkit";
import { sql } from "kysely";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type CommandContext, type CommandResult, executeCommand } from "../pipeline/command.ts";

export interface MemberOptions {
  /** Cơ sở trong phạm vi (mặc định: cơ sở đầu của tổ chức); `all` = mọi cơ sở. */
  properties?: readonly string[] | "all";
  name?: string;
  limits?: Record<string, number>;
}

/** Tạo person + membership (+ phạm vi cơ sở) rồi trả Actor như request thật thấy (đã bật MFA). */
export async function seedMember(t: TestDb, org: SeededOrg, role: string, opts: MemberOptions = {}) {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 8)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  const props = opts.properties ?? [org.propertyId];
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${opts.name ?? role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties, limits)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role}, ${props === "all"},
                    ${JSON.stringify(opts.limits ?? {})}::jsonb)`.execute(t.admin);
  if (props !== "all") {
    for (const p of props) {
      await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
                values (${randomUUID()}, ${org.orgId}, ${membership}, ${p})`.execute(t.admin);
    }
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

/** Actor owner của tổ chức đã seed. */
export function ownerOf(t: TestDb, org: SeededOrg): Promise<Actor> {
  return resolveActor(t.runtime, {
    authUserId: org.ownerAuthUserId,
    orgId: org.orgId,
    twoFactorEnabled: true,
  });
}

/** Chạy handler trong pipeline thật (idempotency, audit, outbox, RLS theo actor). */
export function runAs<T>(
  t: TestDb,
  actor: Actor,
  fn: (ctx: CommandContext) => Promise<T>,
  opts: { command?: string; key?: string; payload?: unknown } = {},
): Promise<CommandResult<T>> {
  return executeCommand<T>(
    t.runtime,
    actor,
    {
      command: opts.command ?? "test.command",
      idempotencyKey: opts.key ?? randomUUID(),
      payload: opts.payload ?? { n: randomUUID() },
      correlationId: "test-corr",
    },
    async (ctx) => ({ data: await fn(ctx) }),
  );
}

/** Như runAs nhưng ném lỗi nếu không commit — trả data. */
export async function okAs<T>(t: TestDb, actor: Actor, fn: (ctx: CommandContext) => Promise<T>): Promise<T> {
  const r = await runAs(t, actor, fn);
  if (r.status !== "committed") throw new Error(`${r.problem.code}: ${r.problem.title}`);
  return r.data;
}

/** Mã lỗi của lệnh thất bại (hoặc "COMMITTED"). */
export async function codeOf<T>(p: Promise<CommandResult<T>>): Promise<string> {
  const r = await p;
  return r.status === "committed" ? "COMMITTED" : r.problem.code;
}
