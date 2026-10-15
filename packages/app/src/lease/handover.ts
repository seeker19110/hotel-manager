// Bàn giao, kích hoạt, phụ lục hợp đồng (PLAN đợt 2 T-110; SPEC-lease S-005…S-007, S-011, S-013; INV-G4, INV-I1).
// Biên bản bàn giao bắt buộc đủ chỉ số mọi công tơ đang dùng của phòng và sinh `meter_readings` nguồn `handover` đã duyệt
// (chỉ số đầu của kỳ thu sau). Ảnh là file riêng tư (`files.owner_type='handover'`), biên bản lưu id.
import { createHash, randomUUID } from "node:crypto";
import { hasMaxDecimals } from "@hm/domain";
import { sql } from "kysely";
import { type CommandContext, canonicalJson } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";
import {
  type LeaseStatus,
  type LeaseTerms,
  leaseAllocations,
  leaseInterval,
  lockLease,
  originalVersion,
  servicesJson,
  transition,
  validateTerms,
} from "./lease.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const HANDOVER_LIMITS = { assets: 50, photos: 20, filesPerAsset: 20, note: 2000 } as const;

export interface HandoverAsset {
  name: string;
  quantity: number;
  condition: string;
  fileIds?: readonly string[];
}

export interface RecordHandoverInput {
  leaseId: string;
  kind: "move_in" | "move_out";
  handedOverOn: string;
  /** Chỉ số theo loại công tơ (`electric`, `water`); bắt buộc cho mọi công tơ đang dùng của phòng. */
  readings: Partial<Record<"electric" | "water", number>>;
  assets: readonly HandoverAsset[];
  keysCount: number;
  photoFileIds: readonly string[];
  note?: string;
  /** Người thuê xác nhận (tại chỗ/portal) — chưa có ký điện tử ở V1 (SPEC-lease mục 10). */
  tenantConfirmation?: { method: "in_person" | "portal" };
  now?: Date;
}

function assertDate(d: string, field: string): void {
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw fieldError(field, "INVALID_DATE", `${field}: ngày không hợp lệ (YYYY-MM-DD)`);
  }
}

function validateAssets(assets: readonly HandoverAsset[], photos: readonly string[]): string[] {
  if (assets.length > HANDOVER_LIMITS.assets)
    throw fieldError("assets", "TOO_MANY", `Tối đa ${HANDOVER_LIMITS.assets} tài sản`);
  if (photos.length > HANDOVER_LIMITS.photos) {
    throw fieldError("photo_file_ids", "TOO_MANY", `Tối đa ${HANDOVER_LIMITS.photos} ảnh`);
  }
  const files: string[] = [];
  assets.forEach((a, i) => {
    if (!a.name.trim() || a.name.length > 100)
      throw fieldError(`assets[${i}].name`, "INVALID", "Tên tài sản 1–100 ký tự");
    if (!Number.isInteger(a.quantity) || a.quantity < 1 || a.quantity > 1000) {
      throw fieldError(`assets[${i}].quantity`, "INVALID", "Số lượng 1–1000");
    }
    if (!a.condition.trim() || a.condition.length > 200) {
      throw fieldError(`assets[${i}].condition`, "INVALID", "Tình trạng 1–200 ký tự");
    }
    const ids = a.fileIds ?? [];
    if (ids.length > HANDOVER_LIMITS.filesPerAsset)
      throw fieldError(`assets[${i}].file_ids`, "TOO_MANY", "Quá nhiều ảnh");
    ids.forEach((id, j) => {
      if (!UUID.test(id)) throw fieldError(`assets[${i}].file_ids[${j}]`, "INVALID", "Ảnh không hợp lệ");
      files.push(id);
    });
  });
  photos.forEach((id, j) => {
    if (!UUID.test(id)) throw fieldError(`photo_file_ids[${j}]`, "INVALID", "Ảnh không hợp lệ");
    files.push(id);
  });
  return [...new Set(files)];
}

/** `lease.recordHandover` (S-006, S-007): biên bản đủ mục bắt buộc; thiếu → 422 theo trường, không lưu biên bản dở. */
export async function recordHandover(
  ctx: CommandContext,
  input: RecordHandoverInput,
): Promise<{ handoverId: string; readingIds: string[] }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.handover");
  const okStatus: LeaseStatus[] =
    input.kind === "move_in" ? ["signed_awaiting_handover"] : ["active", "notice_given", "settling"];
  if (!okStatus.includes(lease.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, "Trạng thái hợp đồng không cho lập biên bản này", {
      extensions: { from: lease.status },
    });
  }
  assertDate(input.handedOverOn, "handed_over_on");
  // Ngày bàn giao hợp lệ với hợp đồng (review lát 2 🟠2, 🟠3): nhận phòng không sau ngày hết hạn phiên bản 1; trả phòng
  // không trước ngày nhận phòng.
  if (input.kind === "move_in") {
    const v1 = await originalVersion(ctx, lease.id);
    if (v1.effective_to !== null && input.handedOverOn > v1.effective_to) {
      throw fieldError("handed_over_on", "AFTER_END", "Ngày nhận phòng sau ngày hết hạn hợp đồng");
    }
  } else {
    const mi = await sql<{ d: string }>`
      select handed_over_on::text as d from handovers
      where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id} and kind = 'move_in'`.execute(
      ctx.trx,
    );
    const moveIn = mi.rows[0]?.d;
    if (moveIn && input.handedOverOn < moveIn) {
      throw fieldError("handed_over_on", "BEFORE_MOVE_IN", "Ngày trả phòng trước ngày nhận phòng");
    }
  }
  if (!Number.isInteger(input.keysCount) || input.keysCount < 0 || input.keysCount > 100) {
    throw fieldError("keys_count", "INVALID", "Số chìa khoá 0–100");
  }
  if (input.note && input.note.length > HANDOVER_LIMITS.note)
    throw fieldError("note", "TOO_LONG", "Ghi chú tối đa 2.000 ký tự");
  const fileIds = validateAssets(input.assets, input.photoFileIds);
  if (fileIds.length > 0) {
    const f = await sql<{ id: string }>`
      select id from files where organization_id = ${ctx.actor.orgId} and owner_type = 'handover'
        and (property_id is null or property_id = ${lease.property_id}) and id = any(${fileIds}::uuid[])`.execute(
      ctx.trx,
    );
    const found = new Set(f.rows.map((r) => r.id));
    const missing = fileIds.find((id) => !found.has(id));
    if (missing) throw fieldError("photo_file_ids", "NOT_FOUND", "Ảnh bàn giao không tồn tại hoặc sai loại");
  }

  // Chỉ số: đủ mọi công tơ đang dùng của phòng tại ngày bàn giao; không nhỏ hơn lần đọc đã duyệt trước.
  const meters = await sql<{ id: string; kind: "electric" | "water"; last: string }>`
    select m.id, m.kind,
           coalesce((select r.value from meter_readings r where r.organization_id = m.organization_id and r.meter_id = m.id
                       and r.status = 'approved' order by r.read_on desc, r.created_at desc limit 1), m.initial_value)::text as last
    from meters m
    where m.organization_id = ${ctx.actor.orgId} and m.unit_id = ${lease.unit_id} and m.installed_on <= ${input.handedOverOn}::date
      and (m.removed_on is null or m.removed_on > ${input.handedOverOn}::date)
    order by m.kind`.execute(ctx.trx);
  for (const m of meters.rows) {
    const v = input.readings[m.kind];
    const field = `readings.${m.kind}`;
    if (v === undefined || v === null)
      throw fieldError(field, "REQUIRED", `Thiếu chỉ số ${m.kind === "electric" ? "điện" : "nước"}`);
    if (!Number.isFinite(v) || v < 0 || !hasMaxDecimals(v, 3) || v >= 1e11) {
      throw fieldError(field, "INVALID", "Chỉ số không hợp lệ (≥ 0, tối đa 3 chữ số thập phân)");
    }
    if (v < Number(m.last)) {
      throw new CommandError("METER_READING_DECREASED", 422, `Chỉ số ${v} nhỏ hơn lần đọc trước ${m.last}`, {
        extensions: { errors: [{ path: field, field, code: "DECREASED" }] },
      });
    }
  }
  for (const k of Object.keys(input.readings) as ("electric" | "water")[]) {
    if (input.readings[k] !== undefined && !meters.rows.some((m) => m.kind === k)) {
      throw fieldError(`readings.${k}`, "NO_METER", "Phòng không có công tơ loại này");
    }
  }

  const now = input.now ?? new Date();
  const handoverId = randomUUID();
  try {
    await sql`savepoint handover_insert`.execute(ctx.trx);
    await sql`
      insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, assets, keys_count, photo_file_ids,
                             note, staff_confirmed_by, confirmed_at, confirmed_by_tenant_at, confirmation_method, command_id)
      values (${handoverId}, ${ctx.actor.orgId}, ${lease.property_id}, ${lease.id}, ${input.kind}, ${input.handedOverOn}::date,
              ${JSON.stringify(
                input.assets.map((a) => ({
                  name: a.name.trim(),
                  quantity: a.quantity,
                  condition: a.condition.trim(),
                  file_ids: a.fileIds ?? [],
                })),
              )}::jsonb,
              ${input.keysCount}, ${[...input.photoFileIds]}::uuid[], ${input.note ?? null}, ${ctx.actor.membershipId}, ${now},
              ${input.tenantConfirmation ? now : null}, ${input.tenantConfirmation?.method ?? null}, ${ctx.commandId})`.execute(
      ctx.trx,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw new CommandError("INVALID_TRANSITION", 409, "Hợp đồng đã có biên bản loại này");
    }
    throw e;
  }
  if (input.kind === "move_out") {
    // Trả phòng: hợp đồng sang `settling`, ghi ngày thực trả (mốc thứ tư, S-017); allocation kết thúc khi đóng hợp đồng.
    await sql`update leases set status = 'settling', moved_out_on = ${input.handedOverOn}::date, version = version + 1
              where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  }
  const readingIds: string[] = [];
  for (const m of meters.rows) {
    const id = randomUUID();
    readingIds.push(id);
    await sql`
      insert into meter_readings (id, organization_id, property_id, meter_id, handover_id, read_on, value, status, source,
                                  entered_by, approved_by)
      values (${id}, ${ctx.actor.orgId}, ${lease.property_id}, ${m.id}, ${handoverId}, ${input.handedOverOn}::date,
              ${input.readings[m.kind] as number}, 'approved', 'handover', ${ctx.actor.membershipId}, ${ctx.actor.membershipId})`.execute(
      ctx.trx,
    );
  }
  await ctx.audit({
    action: "lease.handover_recorded",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    after: {
      handover_id: handoverId,
      kind: input.kind,
      readings: readingIds.length,
      tenant_confirmed: !!input.tenantConfirmation,
    },
  });
  return { handoverId, readingIds };
}

/**
 * `lease.activate` (S-005, S-006): signed_awaiting_handover → active khi có biên bản nhận phòng đã xác nhận; allocation bắt
 * đầu lại từ 00:00 giờ cơ sở của ngày bàn giao (mục 10 SPEC-lease) — chồng phòng ⇒ ROOM_UNAVAILABLE.
 */
export async function activateLease(
  ctx: CommandContext,
  input: { leaseId: string },
): Promise<{ status: LeaseStatus }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  transition(lease, "active");
  const h = await sql<{ handed_over_on: string }>`
    select handed_over_on::text from handovers
    where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id} and kind = 'move_in' and confirmed_at is not null`.execute(
    ctx.trx,
  );
  const handover = h.rows[0];
  if (!handover) throw new CommandError("HANDOVER_REQUIRED", 409, "Cần hoàn tất biên bản bàn giao trước.");
  const alloc = (await leaseAllocations(ctx, lease.id)).find((a) => a.active && a.kind === "lease");
  if (alloc) {
    const start = await leaseInterval(
      ctx.trx,
      ctx.actor.orgId,
      lease.property_id,
      handover.handed_over_on,
      null,
    );
    try {
      await sql`savepoint activate_alloc`.execute(ctx.trx);
      await sql`
        update allocations set during = tstzrange(${start.start}, upper(during), '[)')
        where organization_id = ${ctx.actor.orgId} and id = ${alloc.id} and lower(during) <> ${start.start}`.execute(
        ctx.trx,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") {
        throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đã có người trong khoảng từ ngày bàn giao");
      }
      throw e;
    }
  }
  await sql`update leases set status = 'active', version = version + 1
            where organization_id = ${ctx.actor.orgId} and id = ${lease.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "lease.activated",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    before: { status: lease.status },
    after: { status: "active", handed_over_on: handover.handed_over_on },
  });
  await ctx.emit({
    eventType: "lease.activated",
    aggregateType: "lease",
    aggregateId: lease.id,
    propertyId: lease.property_id,
    payload: { lease_id: lease.id },
  });
  return { status: "active" };
}

/**
 * `lease.renew` (S-011, S-013): phụ lục = phiên bản mới (bất biến ngay khi lập), giữ nguyên lịch sử giá; chồng hiệu lực ⇒
 * LEASE_VERSION_OVERLAP. Allocation của hợp đồng kéo dài tới hết phụ lục (chồng phòng ⇒ ROOM_UNAVAILABLE).
 */
export async function renewLease(
  ctx: CommandContext,
  input: { leaseId: string; terms: LeaseTerms; now?: Date },
): Promise<{ versionNo: number; termsHash: string }> {
  const lease = await lockLease(ctx, input.leaseId, "lease.manage");
  if (!["active", "notice_given"].includes(lease.status)) {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ lập phụ lục cho hợp đồng đang hiệu lực", {
      extensions: { from: lease.status },
    });
  }
  await validateTerms(ctx, lease.property_id, input.terms);
  const v1 = await originalVersion(ctx, lease.id);
  if (input.terms.effectiveFrom <= v1.effective_from) {
    throw new CommandError("LEASE_VERSION_OVERLAP", 409, "Thời gian hiệu lực trùng với phiên bản khác.");
  }
  const n = await sql<{ n: number }>`
    select coalesce(max(version_no), 0)::int + 1 as n from lease_versions
    where organization_id = ${ctx.actor.orgId} and lease_id = ${lease.id}`.execute(ctx.trx);
  const versionNo = n.rows[0]?.n as number;
  const snapshot = {
    lease_id: lease.id,
    number: lease.number,
    version_no: versionNo,
    kind: "appendix",
    effective_from: input.terms.effectiveFrom,
    effective_to: input.terms.effectiveTo,
    rent_amount: input.terms.rentAmount,
    deposit_amount: input.terms.depositAmount,
    billing_cycle: "monthly",
    services: JSON.parse(servicesJson(input.terms.services)),
  };
  const termsHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  try {
    await sql`savepoint renew_version`.execute(ctx.trx);
    await sql`
      insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, effective_to,
                                  rent_amount, deposit_amount, services, terms_snapshot, terms_hash, signed_at, created_by, command_id)
      values (${randomUUID()}, ${ctx.actor.orgId}, ${lease.property_id}, ${lease.id}, ${versionNo}, 'appendix',
              ${input.terms.effectiveFrom}::date, ${input.terms.effectiveTo}::date, ${input.terms.rentAmount},
              ${input.terms.depositAmount}, ${servicesJson(input.terms.services)}::jsonb, ${canonicalJson(snapshot)}::jsonb,
              ${termsHash}, ${input.now ?? new Date()}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
      ctx.trx,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") {
      throw new CommandError("LEASE_VERSION_OVERLAP", 409, "Thời gian hiệu lực trùng với phiên bản khác.");
    }
    throw e;
  }
  const alloc = (await leaseAllocations(ctx, lease.id)).find((a) => a.active && a.kind === "lease");
  if (alloc) {
    const end = await leaseInterval(
      ctx.trx,
      ctx.actor.orgId,
      lease.property_id,
      input.terms.effectiveFrom,
      input.terms.effectiveTo,
    );
    try {
      await sql`savepoint renew_alloc`.execute(ctx.trx);
      await sql`
        update allocations set during = tstzrange(lower(during), ${end.end}, '[)')
        where organization_id = ${ctx.actor.orgId} and id = ${alloc.id}
          and upper(during) is not null and (${end.end}::timestamptz is null or upper(during) < ${end.end})`.execute(
        ctx.trx,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") {
        throw new CommandError("ROOM_UNAVAILABLE", 409, "Phòng đã có người trong thời gian gia hạn");
      }
      throw e;
    }
  }
  await ctx.audit({
    action: "lease.renewed",
    entityType: "lease",
    entityId: lease.id,
    propertyId: lease.property_id,
    after: {
      version_no: versionNo,
      rent_amount: input.terms.rentAmount,
      effective_from: input.terms.effectiveFrom,
    },
  });
  await ctx.emit({
    eventType: "lease.renewed",
    aggregateType: "lease",
    aggregateId: lease.id,
    propertyId: lease.property_id,
    payload: { lease_id: lease.id, version_no: versionNo },
  });
  return { versionNo, termsHash };
}
