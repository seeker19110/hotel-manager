// Nhận phòng (PLAN đợt 3 T-205; SPEC-reservation-stay §5 `stay.checkIn`/`stay.walkIn`, S-012…S-016, S-025, Q-08, Q-11; ERD `stays`,
// `identity_documents`; DOMAIN-MODEL §4). Mọi lệnh chạy trong pipeline (idempotency, audit, outbox).
// - Bất biến ở CSDL: bảng chuyển trạng thái booking/lượt ở (0025), một lượt `in_house` mỗi phòng + một khoản tiền phòng mỗi đêm +
//   giấy tờ không trùng (0026), chồng phòng (EXCLUDE ở `allocations`, INV-I1). Code phối hợp, kiểm sớm để trả đúng mã lỗi SPEC.
// - PII tối thiểu (Q-08, D-002): người lưu trú = `persons` (họ tên, SĐT người đại diện, quốc tịch nếu có) + `identity_documents` (loại
//   + số giấy tờ). KHÔNG lưu ảnh giấy tờ trừ khi cơ sở bật `properties.settings.store_id_images`. Số đầy đủ không bao giờ vào audit,
//   outbox, kết quả lệnh/API — chỉ `doc_number_masked`.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, stayMachine } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import { alternativeUnits, createStayAllocation, resizeAllocation } from "../inventory/inventory.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import { assertDate, quoteRoomType } from "./rates.ts";
import {
  assertBooking,
  type BookingPaymentInput,
  businessDateAt,
  loadItems,
  loadStays,
  lockReservation,
  MAX_BOOKING_NIGHTS,
  snapshotOf,
  stayInterval,
  takeBookingPayment,
  transitionError,
} from "./reservation.ts";
import { createResidenceNotice } from "./residence.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9 .()-]{6,20}$/;
const CCCD = /^(?:[0-9]{9}|[0-9]{12})$/;
const PASSPORT = /^[A-Za-z0-9]{6,20}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: loại ký tự điều khiển khỏi số giấy tờ
const OTHER_DOC = /^[^\u0000-\u001f\u007f]{5,30}$/;

/** Số người lưu trú tối đa mỗi lệnh (trần chống lạm dụng; sức chứa thật là `room_types.capacity`, S-014). */
export const MAX_GUESTS = 20;
export type DocType = "cccd" | "passport" | "other";

export interface GuestDocumentInput {
  type: DocType;
  /** Số đầy đủ — chỉ ghi vào `identity_documents`, không bao giờ trả lại/ghi log. */
  number: string;
  /** Ảnh giấy tờ (file riêng tư đã tải lên): chỉ khi cơ sở bật `store_id_images`. */
  fileId?: string;
}

export interface GuestInput {
  /** Người đã có trong tổ chức (vd. người đặt) — hoặc `fullName` (+ `phone`) để tạo mới. */
  personId?: string;
  fullName?: string;
  phone?: string;
  /** ISO 3166-1 alpha-2; khác `VN` = khách nước ngoài (bắt buộc hộ chiếu, Q-08). */
  nationality?: string;
  document?: GuestDocumentInput;
}

export interface GuestRecord {
  person_id: string;
  doc_type: DocType;
  doc_number_masked: string;
}

// ---------- người lưu trú + giấy tờ ----------

async function storeIdImages(trx: Transaction<unknown>, orgId: string, propertyId: string): Promise<boolean> {
  const r = await sql<{ v: boolean }>`
    select coalesce(settings ->> 'store_id_images', 'false') = 'true' as v
    from properties where organization_id = ${orgId} and id = ${propertyId}`.execute(trx);
  return r.rows[0]?.v ?? false;
}

/**
 * Ghi người lưu trú (`persons`) và giấy tờ (`identity_documents`), trả danh sách người theo thứ tự đầu vào (người đầu = đại diện).
 * Mỗi người cần giấy tờ (loại + số; trẻ không có CCCD dùng loại `other`); đại diện cần SĐT; khách nước ngoài cần quốc tịch + hộ chiếu.
 * Người đã có kèm giấy tờ còn hiệu lực (đúng loại) thì không phải nhập lại. Lỗi theo trường: `guests[i].…`.
 */
async function recordGuests(
  ctx: CommandContext,
  propertyId: string,
  guests: readonly GuestInput[],
): Promise<{ personIds: string[]; records: GuestRecord[]; foreign: boolean }> {
  const { trx } = ctx;
  const orgId = ctx.actor.orgId;
  const images = await storeIdImages(trx, orgId, propertyId);
  const personIds: string[] = [];
  const records: GuestRecord[] = [];
  const seenPersons = new Set<string>();
  const seenDocs = new Set<string>();
  let foreign = false;
  for (const [i, g] of guests.entries()) {
    const at = (f: string) => `guests[${i}].${f}`;
    if ((g.personId !== undefined) === (g.fullName !== undefined))
      throw fieldError(at("person_id"), "PERSON_OR_NAME", "Mỗi người lưu trú cần person_id hoặc full_name");
    let nationality = g.nationality ? g.nationality.trim().toUpperCase() : null;
    if (nationality !== null && !/^[A-Z]{2}$/.test(nationality))
      throw fieldError(at("nationality"), "INVALID", "Quốc tịch theo mã 2 chữ cái (ISO 3166-1)");
    let personId: string;
    let existingDocs: { id: string; doc_type: DocType; masked: string }[] = [];
    if (g.personId !== undefined) {
      personId = g.personId;
      if (!UUID.test(personId)) throw fieldError(at("person_id"), "INVALID", "Người lưu trú không hợp lệ");
      const p = await sql<{ phone: string | null; nationality: string | null }>`
        select phone, nationality from persons
        where organization_id = ${orgId} and id = ${personId} and anonymized_at is null`.execute(trx);
      const row = p.rows[0];
      if (!row) throw fieldError(at("person_id"), "NOT_FOUND", "Không tìm thấy người lưu trú");
      if (i === 0 && !row.phone)
        throw fieldError(at("phone"), "REQUIRED", "Người đại diện cần số điện thoại (Q-08)");
      const known = row.nationality?.trim() ?? null;
      if (nationality !== null && known !== null && nationality !== known)
        throw fieldError(at("nationality"), "MISMATCH", "Quốc tịch khác với hồ sơ người này");
      if (nationality !== null && known === null) {
        await sql`update persons set nationality = ${nationality}
                  where organization_id = ${orgId} and id = ${personId}`.execute(trx);
      }
      nationality = nationality ?? known;
      existingDocs = (
        await sql<{ id: string; doc_type: DocType; masked: string }>`
          select id, doc_type, doc_number_masked as masked from identity_documents
          where organization_id = ${orgId} and person_id = ${personId} and anonymized_at is null
          order by created_at desc`.execute(trx)
      ).rows;
    } else {
      const fullName = (g.fullName ?? "").trim();
      const phone = g.phone?.trim();
      if (fullName.length < 1 || fullName.length > 200)
        throw fieldError(at("full_name"), "INVALID", "Họ tên 1–200 ký tự");
      if (i === 0 && !phone)
        throw fieldError(at("phone"), "REQUIRED", "Người đại diện cần số điện thoại (Q-08)");
      if (phone !== undefined && !PHONE.test(phone))
        throw fieldError(at("phone"), "INVALID", "Số điện thoại không hợp lệ");
      personId = randomUUID();
      await sql`insert into persons (id, organization_id, full_name, phone, nationality)
                values (${personId}, ${orgId}, ${fullName}, ${phone ?? null}, ${nationality})`.execute(trx);
      await ctx.audit({ action: "person.created", entityType: "person", entityId: personId, propertyId });
    }
    if (seenPersons.has(personId))
      throw fieldError(at("person_id"), "DUPLICATE_GUEST", "Một người chỉ xuất hiện một lần");
    seenPersons.add(personId);
    const isForeign = nationality !== null && nationality !== "VN";
    foreign = foreign || isForeign;

    const doc = g.document;
    if (!doc) {
      const usable = existingDocs.find((d) => !isForeign || d.doc_type === "passport");
      if (!usable)
        throw fieldError(
          at("document"),
          "REQUIRED",
          isForeign
            ? "Khách nước ngoài cần hộ chiếu (Q-08)"
            : "Cần loại và số giấy tờ của người lưu trú (Q-08)",
        );
      records.push({ person_id: personId, doc_type: usable.doc_type, doc_number_masked: usable.masked });
      personIds.push(personId);
      continue;
    }
    if (!["cccd", "passport", "other"].includes(doc.type))
      throw fieldError(at("document.type"), "INVALID", "Loại giấy tờ: cccd, passport hoặc other");
    if (isForeign && doc.type !== "passport")
      throw fieldError(at("document.type"), "PASSPORT_REQUIRED", "Khách nước ngoài cần hộ chiếu (Q-08)");
    const number = doc.number.trim();
    const okNumber =
      doc.type === "cccd"
        ? CCCD.test(number)
        : doc.type === "passport"
          ? PASSPORT.test(number)
          : OTHER_DOC.test(number);
    if (!okNumber) throw fieldError(at("document.number"), "INVALID", "Số giấy tờ không hợp lệ");
    const docKey = `${doc.type}:${number.toUpperCase()}`;
    if (seenDocs.has(docKey))
      throw fieldError(at("document.number"), "DUPLICATE_GUEST", "Hai người dùng cùng một giấy tờ");
    seenDocs.add(docKey);
    if (doc.fileId !== undefined) {
      if (!images)
        throw fieldError(
          at("document.file_id"),
          "ID_IMAGE_NOT_ALLOWED",
          "Cơ sở không lưu ảnh giấy tờ (properties.settings.store_id_images)",
        );
      const f = await sql<{ id: string }>`
        select id from files where organization_id = ${orgId} and id = ${doc.fileId}
          and owner_type = 'identity_document' and status = 'ready'`.execute(trx);
      if (!f.rows[0]) throw fieldError(at("document.file_id"), "NOT_FOUND", "Không tìm thấy ảnh giấy tờ");
    }
    const saved = await sql<{ masked: string }>`
      insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number, file_id)
      values (${randomUUID()}, ${orgId}, ${propertyId}, ${personId}, ${doc.type}, ${number}, ${doc.fileId ?? null})
      on conflict (organization_id, person_id, doc_type, doc_number) where doc_number is not null
      do update set file_id = coalesce(excluded.file_id, identity_documents.file_id)
      returning doc_number_masked as masked`.execute(trx);
    records.push({
      person_id: personId,
      doc_type: doc.type,
      doc_number_masked: (saved.rows[0] as { masked: string }).masked,
    });
    personIds.push(personId);
  }
  return { personIds, records, foreign };
}

// ---------- phòng sẵn sàng ----------

/**
 * Phòng nhận khách được không (S-013, S-015): không còn lượt `in_house` khác hoặc allocation ở/hợp đồng đang phủ thời điểm này
 * (`ROOM_OCCUPIED`), không bị block (`ROOM_UNAVAILABLE`), vệ sinh đạt (`inspected`, hoặc `clean` khi cơ sở không bật
 * `require_inspected`; `ROOM_NOT_READY` kèm phòng cùng loại đã sẵn sàng để gợi ý đổi phòng). Gọi SAU khi đã khoá phòng.
 */
async function assertRoomReady(
  ctx: CommandContext,
  p: {
    unitId: string;
    propertyId: string;
    stayId: string | null;
    ownAllocationId: string;
    now: Date;
    endsAt: Date;
  },
): Promise<void> {
  const { trx } = ctx;
  const orgId = ctx.actor.orgId;
  const nobody = "00000000-0000-0000-0000-000000000000";
  const inHouse = await sql<{ id: string }>`
    select id from stays where organization_id = ${orgId} and unit_id = ${p.unitId} and status = 'in_house'
      and id <> ${p.stayId ?? nobody}::uuid limit 1`.execute(trx);
  if (inHouse.rows[0])
    throw new CommandError("ROOM_OCCUPIED", 409, "Phòng vẫn còn khách chưa trả.", {
      extensions: { alternatives: await readyAlternatives(trx, orgId, p) },
    });
  const covering = await sql<{ kind: string }>`
    select kind from allocations
    where organization_id = ${orgId} and unit_id = ${p.unitId} and active and id <> ${p.ownAllocationId}::uuid
      and kind in ('stay', 'lease', 'block') and during @> ${p.now}::timestamptz limit 1`.execute(trx);
  const other = covering.rows[0];
  if (other?.kind === "block")
    throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đang bị khoá, chưa thể nhận khách.", {
      extensions: { alternatives: await readyAlternatives(trx, orgId, p) },
    });
  if (other)
    throw new CommandError("ROOM_OCCUPIED", 409, "Phòng vẫn còn khách chưa trả.", {
      extensions: { alternatives: await readyAlternatives(trx, orgId, p) },
    });
  const hk = await sql<{ ok: boolean }>`
    select (case when pr.require_inspected then u.housekeeping_status = 'inspected'
                 else u.housekeeping_status in ('clean', 'inspected') end) as ok
    from units u join properties pr on pr.organization_id = u.organization_id and pr.id = u.property_id
    where u.organization_id = ${orgId} and u.id = ${p.unitId}`.execute(trx);
  if (!hk.rows[0]?.ok)
    throw new CommandError("ROOM_NOT_READY", 409, "Phòng chưa dọn xong, chưa thể nhận khách.", {
      extensions: { alternatives: await readyAlternatives(trx, orgId, p) },
    });
}

/** Phòng cùng loại, trống trong khoảng và đã sẵn sàng (vệ sinh đạt) — gợi ý đổi phòng (S-013). */
async function readyAlternatives(
  trx: Transaction<unknown>,
  orgId: string,
  p: { unitId: string; now: Date; endsAt: Date },
): Promise<{ unit_id: string; code: string }[]> {
  const range = `[${p.now.toISOString()},${p.endsAt.toISOString()})`;
  const free = await alternativeUnits(trx, orgId, p.unitId, range, p.now, 50);
  if (free.length === 0) return [];
  const ok = await sql<{ id: string }>`
    select u.id from units u join properties pr on pr.organization_id = u.organization_id and pr.id = u.property_id
    where u.organization_id = ${orgId} and u.id = any(${free.map((f) => f.unit_id)}::uuid[])
      and (case when pr.require_inspected then u.housekeeping_status = 'inspected'
                else u.housekeeping_status in ('clean', 'inspected') end)`.execute(trx);
  const set = new Set(ok.rows.map((r) => r.id));
  return free.filter((f) => set.has(f.unit_id)).slice(0, 10);
}

function capacityExceeded(): CommandError {
  return new CommandError("CAPACITY_EXCEEDED", 422, "Số khách vượt sức chứa của phòng.", {
    extensions: { errors: [{ path: "guests", field: "guests", code: "CAPACITY_EXCEEDED" }] },
  });
}

function assertGuestCount(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_GUESTS)
    throw fieldError("guests", "COUNT", `Cần 1–${MAX_GUESTS} người lưu trú`);
}

/** Tiền phòng từng đêm theo ảnh chụp giá của booking (INV-G3, Q-11): mỗi đêm một khoản, không ghi hai lần (chỉ mục duy nhất 0026). */
async function postRoomCharges(
  ctx: CommandContext,
  p: {
    propertyId: string;
    stayId: string;
    number: string;
    nights: { business_date: string; amount: number }[];
  },
): Promise<number> {
  for (const n of p.nights) {
    await sql`
      insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date,
                           quantity, unit_price, amount, created_by, command_id)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${p.propertyId}, 'stay', ${p.stayId}, 'room', 'REV_ROOM',
              ${`Tiền phòng đêm ${n.business_date} (${p.number})`}, ${n.business_date}::date, 1, ${n.amount}, ${n.amount},
              ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  }
  return p.nights.length;
}

function roomOccupiedOnDuplicate(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "uq_stays_unit_in_house")
    throw new CommandError("ROOM_OCCUPIED", 409, "Phòng vẫn còn khách chưa trả.");
  throw err;
}

// ---------- stay.checkIn ----------

export interface CheckInResult {
  reservation_id: string;
  stay_id: string;
  status: "in_house";
  unit_id: string;
  checked_in_at: string;
  business_date: string;
  allocation_id: string;
  guests: GuestRecord[];
  is_foreign: boolean;
  room_charges: number;
  room_total: number;
}

/**
 * `stay.checkIn` (S-012, S-013, S-014; Q-08, Q-11): booking `confirmed` → lượt ở `expected → in_house` (booking `in_house`), giờ nhận
 * thực tế = `now`. Một transaction, khoá booking rồi phòng: hai lễ tân cùng lúc → một bên thắng, bên kia `409 INVALID_TRANSITION`.
 * Chặn: lượt ở/booking không ở trạng thái cho phép (kể cả `no_show`), ngoài khoảng ngày (trước ngày đến / từ ngày đi), vượt sức chứa
 * (`CAPACITY_EXCEEDED`), phòng còn khách (`ROOM_OCCUPIED`) hoặc chưa sạch (`ROOM_NOT_READY`). Allocation `stay` giữ liên tục: đến sớm
 * hơn giờ nhận thì kéo đầu về giờ thực tế (EXCLUDE chặn chồng). Ghi tiền phòng từng đêm theo ảnh chụp giá. Booking nhiều phòng:
 * nhận từng lượt ở bằng `stayId`.
 */
export async function checkIn(
  ctx: CommandContext,
  input: { reservationId: string; stayId?: string; guests: readonly GuestInput[]; now?: Date },
): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  assertGuestCount(input.guests.length);
  const res = await lockReservation(ctx, input.reservationId);
  if (res.status !== "in_house") assertBooking(res.status, "in_house");
  const items = await loadItems(ctx, res.id, true);
  const stays = await loadStays(
    ctx,
    items.map((i) => i.id),
    true,
  );
  if (input.stayId !== undefined && !UUID.test(input.stayId))
    throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  const target =
    input.stayId !== undefined
      ? stays.find((s) => s.id === input.stayId)
      : stays.length === 1
        ? stays[0]
        : undefined;
  if (input.stayId === undefined && stays.length > 1)
    throw fieldError("stay_id", "REQUIRED", "Booking nhiều phòng: chọn lượt ở cần nhận");
  if (!target) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  if (res.status === "in_house" && target.status !== "expected")
    throw transitionError(target.status, "in_house", "Lượt ở này đã nhận phòng");
  stayMachine.assertTransition(target.status as Parameters<typeof stayMachine.canTransition>[0], "in_house");
  const item = items.find((i) => i.id === target.reservation_item_id);
  if (!item) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");

  const today = await businessDateAt(ctx, res.property_id, now);
  if (today < item.arrival_date)
    throw transitionError("expected", "in_house", "Chưa tới ngày đến — chưa thể nhận phòng");
  if (today >= item.departure_date)
    throw transitionError("expected", "in_house", "Đã qua ngày đi — không nhận phòng được nữa");

  const cap = await sql<{ capacity: number | null }>`
    select rt.capacity from room_types rt
    where rt.organization_id = ${ctx.actor.orgId} and rt.id = ${item.room_type_id}`.execute(ctx.trx);
  const capacity = cap.rows[0]?.capacity;
  if (capacity != null && input.guests.length > capacity) throw capacityExceeded();

  // Khoá phòng (cùng thứ tự với giữ phòng: booking → phòng) rồi đọc allocation của lượt ở.
  const own = await sql<{ unit_id: string }>`
    select unit_id from stays where organization_id = ${ctx.actor.orgId} and id = ${target.id}`.execute(
    ctx.trx,
  );
  await sql`select 1 from units where organization_id = ${ctx.actor.orgId} and id = ${own.rows[0]?.unit_id as string}
            for update`.execute(ctx.trx);
  const al = await sql<{ id: string; unit_id: string; lo: Date; hi: Date }>`
    select id, unit_id, lower(during) as lo, upper(during) as hi from allocations
    where organization_id = ${ctx.actor.orgId} and source_type = 'stay' and source_id = ${target.id} and active and kind = 'stay'`.execute(
    ctx.trx,
  );
  const alloc = al.rows[0];
  if (!alloc) throw transitionError("expected", "in_house", "Lượt ở không còn giữ phòng");
  await assertRoomReady(ctx, {
    unitId: alloc.unit_id,
    propertyId: res.property_id,
    stayId: target.id,
    ownAllocationId: alloc.id,
    now,
    endsAt: new Date(alloc.hi),
  });
  if (now.getTime() < new Date(alloc.lo).getTime()) {
    await resizeAllocation(ctx, { allocationId: alloc.id, start: now, now });
  }

  const g = await recordGuests(ctx, res.property_id, input.guests);
  try {
    await sql`
      update stays set status = 'in_house', checked_in_at = ${now}, primary_guest_person_id = ${g.personIds[0] as string},
             additional_guest_person_ids = ${g.personIds.slice(1)}::uuid[]
      where organization_id = ${ctx.actor.orgId} and id = ${target.id} and status = 'expected'`.execute(
      ctx.trx,
    );
  } catch (err) {
    roomOccupiedOnDuplicate(err);
  }
  if (res.status === "confirmed") {
    await sql`update reservations set status = 'in_house'
              where organization_id = ${ctx.actor.orgId} and id = ${res.id} and status = 'confirmed'`.execute(
      ctx.trx,
    );
  }
  const charged = await postRoomCharges(ctx, {
    propertyId: res.property_id,
    stayId: target.id,
    number: res.number,
    nights: item.nightly_prices,
  });
  // S-028: thông báo lưu trú `pending` cùng transaction với việc lượt ở thành `in_house` (T-207).
  await createResidenceNotice(ctx, {
    propertyId: res.property_id,
    stayId: target.id,
    isForeign: g.foreign,
    checkedInAt: now,
  });
  await ctx.audit({
    action: "stay.checked_in",
    entityType: "stay",
    entityId: target.id,
    propertyId: res.property_id,
    before: { status: "expected" },
    after: {
      status: "in_house",
      reservation_id: res.id,
      checked_in_at: now.toISOString(),
      guests: g.records,
      is_foreign: g.foreign,
      room_charges: charged,
    },
  });
  await ctx.emit({
    eventType: "stay.checked_in",
    aggregateType: "stay",
    aggregateId: target.id,
    propertyId: res.property_id,
    payload: { stay_id: target.id, reservation_id: res.id, is_foreign: g.foreign },
  });
  return {
    reservation_id: res.id,
    stay_id: target.id,
    status: "in_house",
    unit_id: alloc.unit_id,
    checked_in_at: now.toISOString(),
    business_date: today,
    allocation_id: alloc.id,
    guests: g.records,
    is_foreign: g.foreign,
    room_charges: charged,
    room_total: Number(item.room_total),
  };
}

// ---------- stay.walkIn ----------

export interface WalkInResult extends Omit<CheckInResult, "business_date"> {
  /** Ngày kinh doanh của đêm đầu (trước giờ chốt → hôm trước, S-016 b). */
  business_date: string;
  departure_date: string;
  nights: number;
  number: string;
  payment_id: string | null;
  deposit_id: string | null;
}

/**
 * `stay.walkIn` (S-015, S-016 b): MỘT transaction báo giá + booking nguồn `walk_in` khởi tạo thẳng `in_house` + lượt ở `in_house` +
 * allocation `stay` [giờ nhận thực tế, ngày đi + giờ trả) + tiền phòng từng đêm; ứng trước/cọc (tuỳ chọn) qua `payments`/`deposits`.
 * Không có bước trung gian `draft/held/confirmed/expected`; đêm đầu theo ngày kinh doanh (walk-in 01:30 với giờ chốt 04:00 → hôm
 * trước, không báo "ngày đi phải sau ngày đến"). Phòng bị chiếm → `409 ROOM_UNAVAILABLE`, không tạo gì.
 */
export async function walkIn(
  ctx: CommandContext,
  input: {
    unitId: string;
    departureDate: string;
    guests: readonly GuestInput[];
    payment?: BookingPaymentInput;
    now?: Date;
  },
): Promise<WalkInResult> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  assertDate(input.departureDate, "departure_date");
  assertGuestCount(input.guests.length);
  const u = await sql<{ property_id: string; room_type_id: string | null; capacity: number | null }>`
    select u.property_id, u.room_type_id, rt.capacity
    from units u left join room_types rt on rt.organization_id = u.organization_id and rt.id = u.room_type_id
    where u.organization_id = ${ctx.actor.orgId} and u.id = ${input.unitId} and u.archived_at is null`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "reservation.manage", { propertyId: unit.property_id });
  if (!unit.room_type_id || unit.capacity === null)
    throw fieldError("unit_id", "UNIT_NO_ROOM_TYPE", "Phòng chưa gán loại phòng nên không báo giá được");
  if (input.guests.length > unit.capacity) throw capacityExceeded();

  const businessDate = await businessDateAt(ctx, unit.property_id, now);
  const quote = await quoteRoomType(ctx.trx, {
    orgId: ctx.actor.orgId,
    roomTypeId: unit.room_type_id,
    arrivalDate: businessDate,
    departureDate: input.departureDate,
    maxNights: MAX_BOOKING_NIGHTS,
  });
  const interval = await stayInterval(
    ctx.trx,
    ctx.actor.orgId,
    unit.property_id,
    businessDate,
    input.departureDate,
  );
  const endsAt = interval.end as Date;

  const reservationId = randomUUID();
  const itemId = randomUUID();
  const stayId = randomUUID();
  // Allocation trước (khoá phòng + EXCLUDE quyết người thắng); phòng bận → ROOM_UNAVAILABLE, cả lệnh rollback.
  const alloc = await createStayAllocation(ctx, {
    unitId: input.unitId,
    during: { start: now, end: endsAt },
    stayId,
    now,
  });
  await assertRoomReady(ctx, {
    unitId: input.unitId,
    propertyId: unit.property_id,
    stayId: null,
    ownAllocationId: alloc.allocationId,
    now,
    endsAt,
  });
  const g = await recordGuests(ctx, unit.property_id, input.guests);
  const primary = g.personIds[0] as string;

  const n = await sql<{
    n: string;
  }>`select app.next_number(${ctx.actor.orgId}, ${unit.property_id}, 'reservation')::text as n`.execute(
    ctx.trx,
  );
  const number = `R-${n.rows[0]?.n}`;
  const policy = { cancellation: { automatic_fee: 0, manual_fee: "within_limit_with_reason" } };
  const nightly = snapshotOf(quote);
  await sql`
    insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, policy_snapshot, created_by)
    values (${reservationId}, ${ctx.actor.orgId}, ${unit.property_id}, ${number}, 'in_house', 'walk_in', ${primary},
            ${JSON.stringify(policy)}::jsonb, ${ctx.actor.membershipId})`.execute(ctx.trx);
  await sql`
    insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date,
                                   departure_date, guests, nightly_prices, room_total)
    values (${itemId}, ${ctx.actor.orgId}, ${unit.property_id}, ${reservationId}, ${input.unitId}, ${unit.room_type_id},
            ${businessDate}::date, ${input.departureDate}::date, ${input.guests.length}, ${JSON.stringify(nightly)}::jsonb,
            ${quote.total})`.execute(ctx.trx);
  try {
    await sql`
      insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                         additional_guest_person_ids, checked_in_at)
      values (${stayId}, ${ctx.actor.orgId}, ${unit.property_id}, ${itemId}, ${input.unitId}, 'in_house', ${primary},
              ${g.personIds.slice(1)}::uuid[], ${now})`.execute(ctx.trx);
  } catch (err) {
    roomOccupiedOnDuplicate(err);
  }
  let paid: { paymentId: string; depositId: string | null } | null = null;
  if (input.payment) {
    paid = await takeBookingPayment(
      ctx,
      {
        id: reservationId,
        property_id: unit.property_id,
        number,
        status: "in_house",
        source: "walk_in",
        booker_person_id: primary,
      },
      input.payment,
    );
  }
  const charged = await postRoomCharges(ctx, {
    propertyId: unit.property_id,
    stayId,
    number,
    nights: nightly,
  });
  await createResidenceNotice(ctx, {
    propertyId: unit.property_id,
    stayId,
    isForeign: g.foreign,
    checkedInAt: now,
  });
  // Một sự kiện tạo duy nhất (không có `stay.checkIn` riêng): lịch sử trạng thái và audit của walk-in chỉ có "tạo ở in_house".
  await ctx.audit({
    action: "stay.walk_in",
    entityType: "stay",
    entityId: stayId,
    propertyId: unit.property_id,
    after: {
      status: "in_house",
      reservation_id: reservationId,
      number,
      business_date: businessDate,
      departure_date: input.departureDate,
      nights: quote.nightCount,
      room_total: quote.total,
      guests: g.records,
      is_foreign: g.foreign,
      payment_id: paid?.paymentId ?? null,
    },
  });
  await ctx.emit({
    eventType: "stay.checked_in",
    aggregateType: "stay",
    aggregateId: stayId,
    propertyId: unit.property_id,
    payload: { stay_id: stayId, reservation_id: reservationId, is_foreign: g.foreign, walk_in: true },
  });
  return {
    reservation_id: reservationId,
    stay_id: stayId,
    status: "in_house",
    unit_id: input.unitId,
    checked_in_at: now.toISOString(),
    business_date: businessDate,
    departure_date: input.departureDate,
    nights: quote.nightCount,
    number,
    allocation_id: alloc.allocationId,
    guests: g.records,
    is_foreign: g.foreign,
    room_charges: charged,
    room_total: quote.total,
    payment_id: paid?.paymentId ?? null,
    deposit_id: paid?.depositId ?? null,
  };
}

// ---------- stay.get (query) ----------

export interface StayView {
  id: string;
  status: string;
  reservation_id: string;
  reservation_item_id: string;
  property_id: string;
  unit_id: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  guests: {
    person_id: string;
    full_name: string;
    phone: string | null;
    nationality: string | null;
    is_primary: boolean;
    /** Chỉ số đã che (`doc_number_masked`); số đầy đủ không bao giờ ra API. Rỗng với vai trò không đọc giấy tờ. */
    documents: { id: string; doc_type: string; doc_number_masked: string; has_image: boolean }[];
  }[];
}

/**
 * `stay.get` (query, S-025): RLS quyết ai đọc được (buồng phòng/bảo trì, khác tổ chức → 404). Giấy tờ chỉ trả `doc_number_masked`;
 * kế toán đọc được lượt ở nhưng RLS `identity_documents` không cho đọc giấy tờ nên `documents` rỗng.
 */
export async function getStay(db: Kysely<unknown>, actor: Actor, stayId: string): Promise<StayView> {
  if (!UUID.test(stayId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      status: string;
      property_id: string;
      unit_id: string;
      reservation_item_id: string;
      reservation_id: string;
      checked_in_at: Date | null;
      checked_out_at: Date | null;
      primary_guest_person_id: string;
      additional_guest_person_ids: string[];
    }>`
      select s.id, s.status, s.property_id, s.unit_id, s.reservation_item_id, i.reservation_id, s.checked_in_at, s.checked_out_at,
             s.primary_guest_person_id, s.additional_guest_person_ids
      from stays s join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
      where s.organization_id = ${actor.orgId} and s.id = ${stayId}`.execute(trx);
    const s = r.rows[0];
    if (!s) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lượt ở");
    authorize(actor, "calendar.read_guests", { propertyId: s.property_id });
    const ids = [s.primary_guest_person_id, ...s.additional_guest_person_ids];
    const people = await sql<{
      id: string;
      full_name: string;
      phone: string | null;
      nationality: string | null;
    }>`
      select id, full_name, phone, nationality from persons
      where organization_id = ${actor.orgId} and id = any(${ids}::uuid[])`.execute(trx);
    const docs = await sql<{
      id: string;
      person_id: string;
      doc_type: string;
      doc_number_masked: string;
      has_image: boolean;
    }>`
      select id, person_id, doc_type, doc_number_masked, file_id is not null as has_image from identity_documents
      where organization_id = ${actor.orgId} and person_id = any(${ids}::uuid[]) and anonymized_at is null
      order by created_at, id`.execute(trx);
    return {
      id: s.id,
      status: s.status,
      reservation_id: s.reservation_id,
      reservation_item_id: s.reservation_item_id,
      property_id: s.property_id,
      unit_id: s.unit_id,
      checked_in_at: s.checked_in_at ? new Date(s.checked_in_at).toISOString() : null,
      checked_out_at: s.checked_out_at ? new Date(s.checked_out_at).toISOString() : null,
      guests: ids.flatMap((pid) => {
        const p = people.rows.find((x) => x.id === pid);
        if (!p) return [];
        return [
          {
            person_id: pid,
            full_name: p.full_name,
            phone: p.phone,
            nationality: p.nationality?.trim() ?? null,
            is_primary: pid === s.primary_guest_person_id,
            documents: docs.rows
              .filter((d) => d.person_id === pid)
              .map((d) => ({
                id: d.id,
                doc_type: d.doc_type,
                doc_number_masked: d.doc_number_masked,
                has_image: d.has_image,
              })),
          },
        ];
      }),
    };
  });
}
