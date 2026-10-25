// Kiểm hạn mức gói trong command tạo cơ sở/phòng/mời thành viên (IND-SAAS-008, D-123). Bằng hạn mức vẫn được; vượt một ⇒
// 409 PLAN_LIMIT_REACHED. Chỉ chặn TẠO MỚI: dữ liệu sẵn có vẫn đọc/sửa được (hạ gói không khoá dữ liệu — IND-SAAS-017).
// Khoá advisory theo (tổ chức, loại) tuần tự hoá hai lệnh tạo song song để không cùng lọt qua mốc cuối.
import { sql } from "kysely";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";
import { type PlanLimits, planFor } from "./plans.ts";

export type PlanResource = "properties" | "rooms" | "members";

const MESSAGE: Record<PlanResource, (limit: number) => string> = {
  properties: (limit) => t("plans.limit_reached.properties", { limit }),
  rooms: (limit) => t("plans.limit_reached.rooms", { limit }),
  members: (limit) => t("plans.limit_reached.members", { limit }),
};

async function currentCount(ctx: CommandContext, resource: PlanResource): Promise<number> {
  const org = ctx.actor.orgId;
  const r =
    resource === "properties"
      ? await sql<{ n: number }>`select count(*)::int as n from properties
          where organization_id = ${org} and archived_at is null`.execute(ctx.trx)
      : resource === "rooms"
        ? await sql<{ n: number }>`select count(*)::int as n from units
          where organization_id = ${org} and archived_at is null`.execute(ctx.trx)
        : await sql<{ n: number }>`select (
            (select count(*) from memberships where organization_id = ${org}
               and status in ('invited','active','suspended'))
            + (select count(*) from invitations where organization_id = ${org}
               and status = 'pending' and expires_at > now()))::int as n`.execute(ctx.trx);
  return r.rows[0]?.n ?? 0;
}

/** Ném 409 PLAN_LIMIT_REACHED nếu thêm `adding` bản ghi nữa sẽ vượt hạn mức của gói. */
export async function assertWithinPlan(
  ctx: CommandContext,
  resource: PlanResource,
  adding = 1,
): Promise<void> {
  const plan: PlanLimits = planFor(ctx.actor.orgId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`plan:${ctx.actor.orgId}:${resource}`}, 0))`.execute(
    ctx.trx,
  );
  const limit = plan[resource];
  const used = await currentCount(ctx, resource);
  if (used + adding <= limit) return;
  throw new CommandError("PLAN_LIMIT_REACHED", 409, MESSAGE[resource](limit));
}
