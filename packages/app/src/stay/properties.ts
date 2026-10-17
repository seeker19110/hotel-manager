// Cơ sở trong phạm vi của người dùng cho màn vận hành (T-223): múi giờ, ngày kinh doanh hiện tại của từng cơ sở và ca tiền
// mặt của chính người xem. Không lọc theo mẫu (`hotel`/`rental`/`mixed`) — màn buồng phòng/sự cố dùng cho mọi cơ sở.
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/index.ts";

export interface OpsProperty {
  id: string;
  name: string;
  template: "rental" | "hotel" | "mixed";
  timezone: string;
  /** Ngày kinh doanh hiện tại của cơ sở (`YYYY-MM-DD`, theo múi giờ + giờ chốt ngày). */
  businessDate: string;
  /** Người xem đang mở ca tiền mặt ở cơ sở này (điều kiện nhận tiền mặt lúc trả phòng/xác nhận booking). */
  openShift: boolean;
}

/** Cơ sở chưa lưu trữ trong phạm vi actor, theo tên; vai trò không xem được lịch phòng → 403 (như `listRooms`). */
export async function opsProperties(
  db: Kysely<unknown>,
  actor: Actor,
  now = new Date(),
): Promise<OpsProperty[]> {
  authorize(actor, "calendar.read_status");
  const scope = actor.allProperties ? null : [...actor.propertyIds];
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      name: string;
      template: OpsProperty["template"];
      timezone: string;
      bd: string;
      open_shift: boolean;
    }>`
      select p.id, p.name, p.template, p.timezone, app.business_date(p.organization_id, p.id, ${now})::text as bd,
             exists (select 1 from shifts s where s.organization_id = p.organization_id and s.property_id = p.id
                       and s.opened_by = ${actor.membershipId} and s.status = 'open') as open_shift
      from properties p
      where p.organization_id = ${actor.orgId} and p.archived_at is null
        and (${scope}::uuid[] is null or p.id = any(${scope}::uuid[]))
      order by p.name, p.id`.execute(trx);
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      template: x.template,
      timezone: x.timezone,
      businessDate: x.bd,
      openShift: x.open_shift,
    }));
  });
}
