// Truy vấn danh mục truy cập (SPEC-access 5.2): `member.list` (thành viên + lời mời đang chờ) và `property.list` (cơ sở + cấu hình).
// - `member.list`: owner thấy mọi nhân viên; manager chỉ thấy nhân viên cấp thấp CÙNG cơ sở với mình (+ chính mình) — cùng phạm vi
//   mà manager được mời/thu hồi (ma trận 5.3). Người thuê (cổng riêng) và đã thu hồi không có trong danh sách. Không trả token/băm.
// - `property.list`: cơ sở chưa lưu trữ trong phạm vi của actor; mọi vai trò nhân viên đọc được (như lịch trạng thái phòng).
import { withTenant } from "@hm/db";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../actor-core/index.ts";

export interface MemberRow {
  membershipId: string;
  fullName: string;
  email: string | null;
  role: string;
  status: string;
  allProperties: boolean;
  properties: { id: string; name: string }[];
  isSelf: boolean;
}

export interface InvitationRow {
  invitationId: string;
  email: string;
  role: string;
  properties: { id: string; name: string }[];
  expiresAt: string;
}

const LOW = ["front_desk", "housekeeping", "maintenance"];

export async function listMembers(
  db: Kysely<unknown>,
  actor: Actor,
): Promise<{ members: MemberRow[]; invitations: InvitationRow[] }> {
  authorize(actor, "member.invite_staff", {});
  const isOwner = actor.role === "owner";
  const myProps = [...actor.propertyIds];
  // Cơ sở được HIỂN THỊ trong `properties` của từng dòng: actor không phải owner (và không có phạm vi "mọi cơ sở") chỉ thấy cơ sở
  // trong phạm vi của mình — không lộ tên cơ sở ngoài phạm vi qua thành viên/lời mời có phạm vi rộng hơn.
  const visible = isOwner || actor.allProperties ? null : myProps;
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const m = await sql<{
      id: string;
      full_name: string;
      email: string | null;
      role: string;
      status: string;
      all_properties: boolean;
      props: { id: string; name: string }[];
    }>`
      select m.id, p.full_name, p.email, m.role, m.status, m.all_properties,
             coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name) order by pr.name)
                       from property_scopes ps join properties pr on pr.organization_id = ps.organization_id and pr.id = ps.property_id
                       where ps.organization_id = m.organization_id and ps.membership_id = m.id
                         and (${visible}::uuid[] is null or pr.id = any(${visible}::uuid[]))), '[]'::jsonb) as props
      from memberships m join persons p on p.organization_id = m.organization_id and p.id = m.person_id
      where m.organization_id = ${actor.orgId} and m.status <> 'revoked' and m.role not in ('tenant', 'guest')
        and (${isOwner} or m.id = ${actor.membershipId}
             or (m.role = any(${LOW}::text[]) and exists (
                   select 1 from property_scopes ps where ps.organization_id = m.organization_id and ps.membership_id = m.id
                     and ps.property_id = any(${myProps}::uuid[]))))
      order by m.role, p.full_name, m.id
      limit 500`.execute(trx);
    const i = await sql<{
      id: string;
      email: string;
      role: string;
      expires_at: Date;
      props: { id: string; name: string }[];
    }>`
      select i.id, i.email, i.role, i.expires_at,
             coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name) order by pr.name)
                       from properties pr where pr.organization_id = i.organization_id and pr.id = any(i.property_ids)
                         and (${visible}::uuid[] is null or pr.id = any(${visible}::uuid[]))), '[]'::jsonb) as props
      from invitations i
      where i.organization_id = ${actor.orgId} and i.status = 'pending' and i.expires_at > now()
        and (${isOwner} or (i.role = any(${LOW}::text[]) and i.property_ids && ${myProps}::uuid[]))
      order by i.created_at desc, i.id
      limit 200`.execute(trx);
    return {
      members: m.rows.map((r) => ({
        membershipId: r.id,
        fullName: r.full_name,
        email: r.email,
        role: r.role,
        status: r.status,
        allProperties: r.all_properties,
        properties: r.props,
        isSelf: r.id === actor.membershipId,
      })),
      invitations: i.rows.map((r) => ({
        invitationId: r.id,
        email: r.email,
        role: r.role,
        properties: r.props,
        expiresAt: r.expires_at.toISOString(),
      })),
    };
  });
}

export interface PropertyRow {
  propertyId: string;
  name: string;
  template: "rental" | "hotel" | "mixed";
  timezone: string;
  businessDayCutoff: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  currency: string;
}

export async function listProperties(db: Kysely<unknown>, actor: Actor): Promise<PropertyRow[]> {
  authorize(actor, "calendar.read_status", {});
  const scope = actor.allProperties ? null : [...actor.propertyIds];
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      name: string;
      template: PropertyRow["template"];
      timezone: string;
      cutoff: string;
      check_in: string | null;
      check_out: string | null;
      currency: string;
    }>`
      select id, name, template, timezone, to_char(business_day_cutoff, 'HH24:MI') as cutoff,
             to_char(check_in_time, 'HH24:MI') as check_in, to_char(check_out_time, 'HH24:MI') as check_out, currency
      from properties
      where organization_id = ${actor.orgId} and archived_at is null
        and (${scope}::uuid[] is null or id = any(${scope}::uuid[]))
      order by name, id
      limit 200`.execute(trx);
    return r.rows.map((x) => ({
      propertyId: x.id,
      name: x.name,
      template: x.template,
      timezone: x.timezone,
      businessDayCutoff: x.cutoff,
      checkInTime: x.check_in,
      checkOutTime: x.check_out,
      currency: x.currency,
    }));
  });
}
