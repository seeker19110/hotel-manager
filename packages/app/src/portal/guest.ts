// PLAN đợt 3 T-218 — liên kết khách (SPEC-portal S-016…S-020; D-006, Q-02, Q-03).
// - Lễ tân/quản lý/owner tạo link cho một lượt ở (hoặc booking): token 256 bit trả về MỘT lần, CSDL chỉ giữ SHA-256;
//   hạn = giờ trả phòng dự kiến (giờ cơ sở) + `properties.settings.guest_link_hours_after_checkout` (mặc định 48 giờ).
// - Khách mở link (không phiên): giới hạn theo IP (10 lần sai/phút ⇒ 429, cả lần đúng sau đó trong phút), token sai/không
//   tồn tại ⇒ 404 cùng thông điệp; thu hồi ⇒ 410 LINK_REVOKED; hết hạn ⇒ 410 LINK_EXPIRED; bước hai 4 số cuối SĐT người
//   đặt (tắt được theo cơ sở) — sai 5 lần ⇒ khoá link; id lượt ở khác ⇒ 404 (S-018).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import { emitSecurity, type SecurityClient, type SecurityEventName } from "../logging/index.ts";
import { type CommandContext, CommandError, rateLimited } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const GUEST_RATE_LIMIT_PER_MINUTE = 10;
/** Độ dài cửa sổ đếm của `app.guest_link_rate` (phút nguyên) — dùng cho `Retry-After`. */
const GUEST_RATE_WINDOW_SECONDS = 60;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** `portal.createGuestLink` (S-016): trả token đúng một lần. */
export async function createGuestLink(
  ctx: CommandContext,
  input: { stayId: string; now?: Date },
): Promise<{ linkId: string; token: string; expiresAt: Date }> {
  if (!UUID.test(input.stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  const r = await sql<{ property_id: string; status: string; expires_at: Date; factor_ok: boolean }>`
    select s.property_id, s.status,
           (not coalesce((p.settings ->> 'guest_link_second_factor')::boolean, true)
             or length(regexp_replace(coalesce(bp.phone, ''), '[^0-9]', '', 'g')) >= 4) as factor_ok,
           ((ri.departure_date + coalesce(p.check_out_time, '12:00'::time)) at time zone p.timezone)
             + make_interval(hours => coalesce((p.settings ->> 'guest_link_hours_after_checkout')::int, 48)) as expires_at
    from stays s
    join reservation_items ri on ri.organization_id = s.organization_id and ri.id = s.reservation_item_id
    join properties p on p.organization_id = s.organization_id and p.id = s.property_id
    join reservations rv on rv.organization_id = ri.organization_id and rv.id = ri.reservation_id
    left join persons bp on bp.organization_id = rv.organization_id and bp.id = rv.booker_person_id
    where s.organization_id = ${ctx.actor.orgId} and s.id = ${input.stayId}`.execute(ctx.trx);
  const s = r.rows[0];
  if (!s) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  authorize(ctx.actor, "portal.guest_link", { propertyId: s.property_id });
  if (s.status === "cancelled" || s.status === "no_show")
    throw new CommandError("INVALID_TRANSITION", 409, "Lượt ở đã huỷ — không tạo liên kết", {
      extensions: { from: s.status, to: s.status },
    });
  const now = input.now ?? new Date();
  if (s.expires_at.getTime() <= now.getTime())
    throw new CommandError("VALIDATION_FAILED", 422, "Lượt ở đã quá hạn xem lại — không tạo liên kết", {
      extensions: { errors: [{ path: "stay_id", field: "stay_id", code: "expired" }] },
    });
  // Bước hai bật mà người đặt không có SĐT đủ 4 số ⇒ link không bao giờ mở được — từ chối ngay (review lát 4).
  if (!s.factor_ok)
    throw new CommandError(
      "VALIDATION_FAILED",
      422,
      "Người đặt chưa có số điện thoại — bổ sung trước khi tạo liên kết",
      {
        extensions: { errors: [{ path: "stay_id", field: "booker_phone", code: "required" }] },
      },
    );
  const token = randomBytes(32).toString("base64url");
  const linkId = randomUUID();
  await sql`
    insert into guest_access_links (id, organization_id, property_id, stay_id, token_hash, expires_at, created_by, created_at)
    values (${linkId}, ${ctx.actor.orgId}, ${s.property_id}, ${input.stayId}, ${sha256(token)}, ${s.expires_at},
            ${ctx.actor.membershipId}, ${now})`.execute(ctx.trx);
  await ctx.audit({
    action: "portal.guest_link_created",
    entityType: "guest_access_link",
    entityId: linkId,
    propertyId: s.property_id,
    after: { stay_id: input.stayId, expires_at: s.expires_at.toISOString() },
  });
  return { linkId, token, expiresAt: s.expires_at };
}

/** `portal.revokeGuestLink` (S-019): request kế tiếp với token đó → 410 LINK_REVOKED; audit người thu hồi. */
export async function revokeGuestLink(ctx: CommandContext, input: { linkId: string }) {
  if (!UUID.test(input.linkId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy liên kết");
  const r = await sql<{ property_id: string; revoked_at: Date | null }>`
    select property_id, revoked_at from guest_access_links
    where organization_id = ${ctx.actor.orgId} and id = ${input.linkId} for update`.execute(ctx.trx);
  const l = r.rows[0];
  if (!l) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy liên kết");
  authorize(ctx.actor, "portal.guest_link", { propertyId: l.property_id });
  if (l.revoked_at) return { linkId: input.linkId, revoked: true as const };
  await sql`update guest_access_links set revoked_at = now(), revoked_by = ${ctx.actor.membershipId}
            where organization_id = ${ctx.actor.orgId} and id = ${input.linkId}`.execute(ctx.trx);
  await ctx.audit({
    action: "portal.guest_link_revoked",
    entityType: "guest_access_link",
    entityId: input.linkId,
    propertyId: l.property_id,
  });
  ctx.security({ event: "guest_link.revoked", target: { type: "guest_access_link", id: input.linkId } });
  return { linkId: input.linkId, revoked: true as const };
}

export interface GuestView {
  stay: {
    id: string;
    status: string;
    arrivalDate: string;
    departureDate: string;
    unitCode: string;
    reservationNumber: string;
  };
  folio: {
    charges: { description: string; businessDate: string; amount: number }[];
    total: number;
    paid: number;
    balance: number;
  };
}

const invalidLink = () => new CommandError("NOT_FOUND", 404, "Liên kết hoặc mã xác minh không đúng.");

/** `portal.guestGetStay` + folio (S-016…S-020). `ip` dùng để giới hạn tần suất (băm, không lưu IP thô). */
export async function guestGetStay(
  db: Kysely<unknown>,
  input: {
    token: string;
    stayId: string;
    phoneLast4?: string;
    ip: string;
    userAgent?: string | null;
    correlationId?: string;
    now?: Date;
  },
): Promise<GuestView> {
  const now = input.now ?? new Date();
  const ipHash = sha256(`guest-link:${input.ip}`);
  // Sự kiện bảo mật (SEC-LOG-001): IP ghi log đã cắt /24 (xem logging/security-events.ts), token KHÔNG bao giờ vào log.
  const client: SecurityClient = { ip: input.ip, userAgent: input.userAgent ?? null };
  const secure = (event: SecurityEventName, reason: string, linkId?: string) =>
    emitSecurity({
      event,
      outcome: "denied",
      target: linkId ? { type: "guest_access_link", id: linkId } : { type: "guest_access_link" },
      reason,
      client,
      correlationId: input.correlationId ?? null,
    });
  const rate = async (record: boolean) =>
    (await sql<{ n: number }>`select app.guest_link_rate(${ipHash}, ${now}, ${record}) as n`.execute(db))
      .rows[0]?.n ?? 0;
  if ((await rate(false)) >= GUEST_RATE_LIMIT_PER_MINUTE) {
    secure("rate_limit.exceeded", "RATE_LIMITED");
    // Cửa sổ đếm là 1 phút (app.guest_link_rate) ⇒ sau tối đa 60 giây hết giới hạn.
    throw rateLimited("Bạn thử quá nhiều lần. Vui lòng đợi ít phút.", GUEST_RATE_WINDOW_SECONDS);
  }
  const fail = async (err: CommandError, reason = "INVALID_LINK", linkId?: string): Promise<never> => {
    secure("guest_link.denied", reason, linkId);
    await rate(true);
    throw err;
  };
  if (!TOKEN.test(input.token)) return fail(invalidLink());
  const r = await sql<{
    id: string;
    stay_id: string | null;
    expires_at: Date;
    revoked_at: Date | null;
    locked_at: Date | null;
    phone_last4: string;
    second_factor: boolean;
  }>`select id, stay_id, expires_at, revoked_at, locked_at, phone_last4, second_factor
     from app.resolve_guest_link(${sha256(input.token)})`.execute(db);
  const link = r.rows[0];
  if (!link) return fail(invalidLink());
  if (link.revoked_at || link.locked_at) {
    secure("guest_link.denied", "LINK_REVOKED", link.id);
    throw new CommandError("LINK_REVOKED", 410, "Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân.");
  }
  if (link.expires_at.getTime() <= now.getTime())
    throw new CommandError(
      "LINK_EXPIRED",
      410,
      "Liên kết đã hết hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới.",
    );
  if (link.second_factor) {
    const ok = link.phone_last4.length === 4 && input.phoneLast4 === link.phone_last4;
    if (!ok) {
      const locked = await sql<{ locked: boolean }>`
        select app.guest_link_attempt(${link.id}::uuid, false, ${now}) as locked`.execute(db);
      if (locked.rows[0]?.locked) {
        secure("guest_link.locked", "SECOND_FACTOR_ATTEMPTS", link.id);
        await rate(true);
        throw new CommandError("LINK_REVOKED", 410, "Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân.");
      }
      return fail(invalidLink(), "SECOND_FACTOR_MISMATCH", link.id);
    }
  }
  // Token hợp lệ nhưng hỏi lượt ở khác → 404 (S-018), không tính là đoán token.
  if (!UUID.test(input.stayId) || link.stay_id !== input.stayId)
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  const used = await sql<{ locked: boolean }>`
    select app.guest_link_attempt(${link.id}::uuid, true, ${now}) as locked`.execute(db);
  if (used.rows[0]?.locked)
    throw new CommandError("LINK_REVOKED", 410, "Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân.");
  const v = await sql<{ v: GuestViewRaw | null }>`select app.guest_stay_view(${link.id}::uuid) as v`.execute(
    db,
  );
  const raw = v.rows[0]?.v;
  if (!raw) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu.");
  const charges = raw.charges.map((c) => ({
    description: c.description,
    businessDate: c.businessDate,
    amount: Number(c.amount),
  }));
  const total = raw.invoice ? Number(raw.invoice.total) : charges.reduce((s, c) => s + c.amount, 0);
  const paid = raw.invoice ? Number(raw.invoice.allocated) : Number(raw.advancePaid);
  return {
    stay: {
      id: raw.stay.id,
      status: raw.stay.status,
      arrivalDate: raw.stay.arrivalDate,
      departureDate: raw.stay.departureDate,
      unitCode: raw.stay.unitCode,
      reservationNumber: raw.stay.reservationNumber,
    },
    folio: { charges, total, paid, balance: total - paid },
  };
}

interface GuestViewRaw {
  stay: GuestView["stay"];
  charges: { description: string; businessDate: string; amount: number | string }[];
  invoice: { total: number | string; allocated: number | string } | null;
  advancePaid: number | string;
}
