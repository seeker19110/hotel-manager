// `property.create` / `property.update` (SPEC-access-and-property S-001…S-003, S-023; ERD `properties`).
// - Chỉ owner (`org.configure`). Mặc định múi giờ `Asia/Ho_Chi_Minh`, tiền tệ `VND`, giờ chốt ngày 00:00 (Q-01).
// - Múi giờ phải là tên IANA có trong `pg_timezone_names` (và có dấu `/`, như trigger 0001); giờ dạng HH:MM — sai ⇒ 422 chỉ đúng trường sai.
// - Mẫu `mixed` chỉ khi `organizations.settings.feature_flags.mixed_template_enabled` bật ⇒ không thì 409 FEATURE_DISABLED.
// - Đổi múi giờ/giờ chốt khi cơ sở đã có dữ liệu: trigger CSDL 0062 từ chối (PROPERTY_IN_USE) — không kiểm ở app thay trigger.
import { randomUUID } from "node:crypto";
import { authorize, keepIfUndefined } from "@hm/domain";
import { sql } from "kysely";
import { t } from "../i18n.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
export const DEFAULT_BUSINESS_DAY_CUTOFF = "00:00";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export type PropertyTemplate = "rental" | "hotel" | "mixed";

async function assertTimezone(ctx: CommandContext, tz: string): Promise<void> {
  const ok = tz.includes("/")
    ? await sql<{ n: number }>`select count(*)::int as n from pg_timezone_names where name = ${tz}`.execute(
        ctx.trx,
      )
    : null;
  if (!ok || (ok.rows[0]?.n ?? 0) === 0)
    throw fieldError("timezone", "INVALID", t("access.timezone_invalid"));
}

function assertClock(field: string, v: string): void {
  if (!CLOCK.test(v)) throw fieldError(field, "INVALID", t("access.time_format_invalid"));
}

async function assertTemplateAllowed(ctx: CommandContext, template: PropertyTemplate): Promise<void> {
  if (template !== "mixed") return;
  const r = await sql<{ on: boolean }>`
    select coalesce(settings #>> '{feature_flags,mixed_template_enabled}', 'false') = 'true' as on
    from organizations where id = ${ctx.actor.orgId}`.execute(ctx.trx);
  if (!r.rows[0]?.on) throw new CommandError("FEATURE_DISABLED", 409, t("access.mixed_template_unavailable"));
}

export async function createProperty(
  ctx: CommandContext,
  input: {
    name: string;
    template: PropertyTemplate;
    timezone?: string;
    businessDayCutoff?: string;
    checkInTime?: string;
    checkOutTime?: string;
  },
): Promise<{
  propertyId: string;
  name: string;
  template: PropertyTemplate;
  timezone: string;
  businessDayCutoff: string;
  currency: string;
}> {
  authorize(ctx.actor, "org.configure", {});
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200)
    throw fieldError("name", "INVALID", t("access.property_name_length"));
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const cutoff = input.businessDayCutoff ?? DEFAULT_BUSINESS_DAY_CUTOFF;
  await assertTimezone(ctx, timezone);
  assertClock("business_day_cutoff", cutoff);
  if (input.checkInTime !== undefined) assertClock("check_in_time", input.checkInTime);
  if (input.checkOutTime !== undefined) assertClock("check_out_time", input.checkOutTime);
  await assertTemplateAllowed(ctx, input.template);
  const propertyId = randomUUID();
  const r = await sql<{ currency: string; cutoff: string }>`
    insert into properties (id, organization_id, name, template, timezone, business_day_cutoff, check_in_time, check_out_time)
    values (${propertyId}, ${ctx.actor.orgId}, ${name}, ${input.template}, ${timezone}, ${cutoff}::time,
            ${input.checkInTime ?? null}::time, ${input.checkOutTime ?? null}::time)
    returning currency, to_char(business_day_cutoff, 'HH24:MI') as cutoff`.execute(ctx.trx);
  // Người tạo chưa có phạm vi "mọi cơ sở" (bản ghi cũ/seed) vẫn phải đọc được cơ sở vừa tạo.
  if (!ctx.actor.allProperties)
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${ctx.actor.orgId}, ${ctx.actor.membershipId}, ${propertyId})`.execute(
      ctx.trx,
    );
  await ctx.audit({
    action: "property.created",
    entityType: "property",
    entityId: propertyId,
    propertyId,
    after: { name, template: input.template, timezone, business_day_cutoff: cutoff },
  });
  await ctx.emit({
    eventType: "property.created",
    aggregateType: "property",
    aggregateId: propertyId,
    propertyId,
    payload: { property_id: propertyId },
  });
  ctx.security({
    event: "config.changed",
    target: { type: "property", id: propertyId },
    reason: "property.created",
  });
  return {
    propertyId,
    name,
    template: input.template,
    timezone,
    businessDayCutoff: r.rows[0]?.cutoff ?? cutoff,
    currency: r.rows[0]?.currency ?? "VND",
  };
}

export async function updateProperty(
  ctx: CommandContext,
  input: {
    propertyId: string;
    name?: string;
    template?: PropertyTemplate;
    timezone?: string;
    businessDayCutoff?: string;
    checkInTime?: string | null;
    checkOutTime?: string | null;
  },
): Promise<{ propertyId: string; changed: string[] }> {
  authorize(ctx.actor, "org.configure", {});
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, t("common.property_not_found"));
  const cur = await sql<{
    name: string;
    template: PropertyTemplate;
    timezone: string;
    cutoff: string;
    check_in: string | null;
    check_out: string | null;
  }>`
    select name, template, timezone, to_char(business_day_cutoff, 'HH24:MI') as cutoff,
           to_char(check_in_time, 'HH24:MI') as check_in, to_char(check_out_time, 'HH24:MI') as check_out
    from properties where organization_id = ${ctx.actor.orgId} and id = ${input.propertyId} and archived_at is null
    for update`.execute(ctx.trx);
  const before = cur.rows[0];
  if (!before) throw new CommandError("NOT_FOUND", 404, t("common.property_not_found"));
  if (input.name !== undefined && (input.name.trim().length < 1 || input.name.trim().length > 200))
    throw fieldError("name", "INVALID", t("access.property_name_length"));
  if (input.timezone !== undefined) await assertTimezone(ctx, input.timezone);
  if (input.businessDayCutoff !== undefined) assertClock("business_day_cutoff", input.businessDayCutoff);
  if (input.checkInTime !== undefined && input.checkInTime !== null)
    assertClock("check_in_time", input.checkInTime);
  if (input.checkOutTime !== undefined && input.checkOutTime !== null)
    assertClock("check_out_time", input.checkOutTime);
  if (input.template !== undefined && input.template !== before.template)
    await assertTemplateAllowed(ctx, input.template);

  const after = {
    name: input.name?.trim() ?? before.name,
    template: input.template ?? before.template,
    timezone: input.timezone ?? before.timezone,
    business_day_cutoff: input.businessDayCutoff ?? before.cutoff,
    check_in_time: keepIfUndefined(input.checkInTime, before.check_in),
    check_out_time: keepIfUndefined(input.checkOutTime, before.check_out),
  };
  const was = {
    name: before.name,
    template: before.template,
    timezone: before.timezone,
    business_day_cutoff: before.cutoff,
    check_in_time: before.check_in,
    check_out_time: before.check_out,
  };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== was[k]);
  if (changed.length === 0) return { propertyId: input.propertyId, changed };
  // Chỉ đặt cột ĐỔI THẬT: trigger PROPERTY_IN_USE (0062) cũng chỉ bắt khi giá trị khác, nhưng không đụng cột không đổi cho gọn.
  await sql`
    update properties set name = ${after.name}, template = ${after.template}, timezone = ${after.timezone},
           business_day_cutoff = ${after.business_day_cutoff}::time, check_in_time = ${after.check_in_time}::time,
           check_out_time = ${after.check_out_time}::time
    where organization_id = ${ctx.actor.orgId} and id = ${input.propertyId}`.execute(ctx.trx);
  await ctx.audit({
    action: "property.updated",
    entityType: "property",
    entityId: input.propertyId,
    propertyId: input.propertyId,
    before: Object.fromEntries(changed.map((k) => [k, was[k]])),
    after: Object.fromEntries(changed.map((k) => [k, after[k]])),
  });
  await ctx.emit({
    eventType: "property.updated",
    aggregateType: "property",
    aggregateId: input.propertyId,
    propertyId: input.propertyId,
    payload: { property_id: input.propertyId },
  });
  ctx.security({
    event: "config.changed",
    target: { type: "property", id: input.propertyId },
    reason: "property.updated",
  });
  return { propertyId: input.propertyId, changed };
}
