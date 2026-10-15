// Dịch vụ, đơn giá hiệu lực và công tơ (PLAN đợt 2 T-112; SPEC-metering-billing S-005…S-010, S-017; ERD `meters`,
// `meter_readings`, `meter_events`, `service_prices`). Chỉ số không giảm (trừ thay công tơ có quyền); lượng tiêu thụ kỳ đi
// qua chuỗi thay công tơ; bất thường (> 2 × trung bình 3 kỳ trước) phải được ghi nhận trước khi gửi duyệt kỳ (T-114).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, hasMaxDecimals } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/actor.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { CommandError, fieldError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type MeterKind = "electric" | "water";

/** Ngưỡng bất thường (đề xuất SPEC-metering S-008): tiêu thụ > HỆ SỐ × trung bình của tối đa 3 kỳ trước, cần đủ 3 kỳ. */
export const ANOMALY = { factor: 2, history: 3 } as const;

function assertDate(d: string, field: string): void {
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw fieldError(field, "INVALID_DATE", `${field}: ngày không hợp lệ (YYYY-MM-DD)`);
  }
}

/** Chỉ số: ≥ 0, tối đa 3 chữ số thập phân (numeric(14,3)). */
function assertReading(v: number, field: string): void {
  if (!Number.isFinite(v) || v < 0 || v >= 1e11 || !hasMaxDecimals(v, 3)) {
    throw fieldError(field, "INVALID", "Chỉ số ≥ 0, tối đa 3 chữ số thập phân");
  }
}

// ---------- Dịch vụ & đơn giá ----------

/** `service.setPrice`: đơn giá có hiệu lực từ ngày; giá mở cuối trước đó tự kết thúc hôm trước. Chồng ⇒ 422. */
export async function setServicePrice(
  ctx: CommandContext,
  input: {
    serviceId: string;
    unitPrice: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
    basisNote?: string;
  },
): Promise<{ priceId: string }> {
  if (!UUID.test(input.serviceId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dịch vụ");
  const s = await sql<{ property_id: string }>`
    select property_id from services where organization_id = ${ctx.actor.orgId} and id = ${input.serviceId} and archived_at is null`.execute(
    ctx.trx,
  );
  const svc = s.rows[0];
  if (!svc) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dịch vụ");
  authorize(ctx.actor, "pricing.manage", { propertyId: svc.property_id });
  assertDate(input.effectiveFrom, "effective_from");
  if (input.effectiveTo) {
    assertDate(input.effectiveTo, "effective_to");
    if (input.effectiveTo < input.effectiveFrom)
      throw fieldError("effective_to", "BEFORE_START", "Ngày kết thúc trước ngày bắt đầu");
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0 || !hasMaxDecimals(input.unitPrice, 4)) {
    throw fieldError("unit_price", "INVALID", "Đơn giá ≥ 0, tối đa 4 chữ số thập phân");
  }
  await sql`
    update service_prices set effective_to = ${input.effectiveFrom}::date - 1, version = version + 1
    where organization_id = ${ctx.actor.orgId} and service_id = ${input.serviceId} and effective_to is null
      and effective_from < ${input.effectiveFrom}::date`.execute(ctx.trx);
  const id = randomUUID();
  try {
    await sql`savepoint set_price`.execute(ctx.trx);
    await sql`
      insert into service_prices (id, organization_id, property_id, service_id, unit_price, effective_from, effective_to, basis_note,
                                  created_by)
      values (${id}, ${ctx.actor.orgId}, ${svc.property_id}, ${input.serviceId}, ${input.unitPrice}, ${input.effectiveFrom}::date,
              ${input.effectiveTo ?? null}::date, ${input.basisNote ?? null}, ${ctx.actor.membershipId})`.execute(
      ctx.trx,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23P01")
      throw fieldError("effective_from", "OVERLAP", "Trùng hiệu lực với đơn giá khác");
    throw e;
  }
  await ctx.audit({
    action: "service.price_set",
    entityType: "service",
    entityId: input.serviceId,
    propertyId: svc.property_id,
    after: {
      unit_price: input.unitPrice,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
    },
  });
  return { priceId: id };
}

/** Đơn giá dịch vụ có hiệu lực tại ngày (null = chưa có giá/chưa đến ngày hiệu lực — S-017). */
export async function priceAt(
  trx: Transaction<unknown>,
  orgId: string,
  serviceId: string,
  on: string,
): Promise<number | null> {
  const r = await sql<{ p: string }>`
    select unit_price::text as p from service_prices
    where organization_id = ${orgId} and service_id = ${serviceId}
      and effective_from <= ${on}::date and (effective_to is null or effective_to >= ${on}::date)`.execute(
    trx,
  );
  return r.rows[0] ? Number(r.rows[0].p) : null;
}

// ---------- Công tơ ----------

/** `meter.install`: công tơ mới cho phòng (một công tơ đang dùng mỗi loại). */
export async function installMeter(
  ctx: CommandContext,
  input: { unitId: string; kind: MeterKind; installedOn: string; initialValue: number; serial?: string },
): Promise<{ meterId: string }> {
  if (!UUID.test(input.unitId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  const u = await sql<{ property_id: string }>`
    select property_id from units where organization_id = ${ctx.actor.orgId} and id = ${input.unitId} and archived_at is null`.execute(
    ctx.trx,
  );
  const unit = u.rows[0];
  if (!unit) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy phòng");
  authorize(ctx.actor, "unit.manage", { propertyId: unit.property_id });
  assertDate(input.installedOn, "installed_on");
  assertReading(input.initialValue, "initial_value");
  const id = randomUUID();
  try {
    await sql`savepoint install_meter`.execute(ctx.trx);
    await sql`
      insert into meters (id, organization_id, property_id, unit_id, kind, serial, installed_on, initial_value)
      values (${id}, ${ctx.actor.orgId}, ${unit.property_id}, ${input.unitId}, ${input.kind}, ${input.serial ?? null},
              ${input.installedOn}::date, ${input.initialValue})`.execute(ctx.trx);
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw fieldError("kind", "DUPLICATE", "Phòng đã có công tơ loại này");
    throw e;
  }
  await ctx.audit({
    action: "meter.installed",
    entityType: "meter",
    entityId: id,
    propertyId: unit.property_id,
  });
  return { meterId: id };
}

interface MeterRow {
  id: string;
  property_id: string;
  unit_id: string;
  kind: MeterKind;
  installed_on: string;
  removed_on: string | null;
  initial_value: string;
}

async function readMeter(
  trx: Transaction<unknown>,
  orgId: string,
  meterId: string,
  lock = false,
): Promise<MeterRow> {
  if (!UUID.test(meterId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy công tơ");
  const r = await sql<MeterRow>`
    select id, property_id, unit_id, kind, installed_on::text, removed_on::text, initial_value::text from meters
    where organization_id = ${orgId} and id = ${meterId} ${lock ? sql`for update` : sql``}`.execute(trx);
  const m = r.rows[0];
  if (!m) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy công tơ");
  return m;
}

/** Chỉ số đã duyệt gần nhất của công tơ (trước `before` nếu có; bỏ qua chỉ số của kỳ `excludePeriodId`); không có ⇒ chỉ số lắp. */
export async function previousReading(
  trx: Transaction<unknown>,
  orgId: string,
  meterId: string,
  opts: { before?: string; excludePeriodId?: string } = {},
): Promise<{ value: number; readOn: string | null; photoFileId: string | null }> {
  const r = await sql<{ value: string; read_on: string; photo_file_id: string | null }>`
    select value::text, read_on::text, photo_file_id from meter_readings
    where organization_id = ${orgId} and meter_id = ${meterId} and status = 'approved'
      ${opts.before ? sql`and read_on <= ${opts.before}::date` : sql``}
      ${opts.excludePeriodId ? sql`and billing_period_id is distinct from ${opts.excludePeriodId}::uuid` : sql``}
    order by read_on desc, value desc, created_at desc limit 1`.execute(trx);
  const row = r.rows[0];
  if (row) return { value: Number(row.value), readOn: row.read_on, photoFileId: row.photo_file_id };
  const m = await sql<{
    v: string;
  }>`select initial_value::text as v from meters where organization_id = ${orgId} and id = ${meterId}`.execute(
    trx,
  );
  return { value: Number(m.rows[0]?.v ?? 0), readOn: null, photoFileId: null };
}

interface PeriodRow {
  id: string;
  property_id: string;
  period_start: string;
  period_end: string;
  status: "draft" | "reviewing" | "issued" | "locked";
}

export async function readPeriod(
  trx: Transaction<unknown>,
  orgId: string,
  periodId: string,
  lock = false,
): Promise<PeriodRow> {
  if (!UUID.test(periodId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy kỳ thu");
  const r = await sql<PeriodRow>`
    select id, property_id, period_start::text, period_end::text, status from billing_periods
    where organization_id = ${orgId} and id = ${periodId} ${lock ? sql`for update` : sql``}`.execute(trx);
  const p = r.rows[0];
  if (!p) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy kỳ thu");
  return p;
}

/**
 * `meter.recordReading` (S-005): chỉ số kỳ (bản nháp, nhập lại = cập nhật; `baseVersion` cũ ⇒ VERSION_CONFLICT); nhỏ hơn
 * chỉ số đã duyệt trước ⇒ 422 METER_READING_DECREASED kèm `previous_value`; kỳ đã phát hành ⇒ PERIOD_ISSUED.
 */
export async function recordReading(
  ctx: CommandContext,
  input: {
    meterId: string;
    billingPeriodId: string;
    value: number;
    readOn?: string;
    photoFileId?: string;
    baseVersion?: number;
  },
): Promise<{ readingId: string; version: number; consumption: number; anomaly: { average: number } | null }> {
  const m = await readMeter(ctx.trx, ctx.actor.orgId, input.meterId);
  authorize(ctx.actor, "meter.record", { propertyId: m.property_id });
  if (m.removed_on)
    throw new CommandError("INVALID_TRANSITION", 409, "Công tơ đã tháo — nhập vào công tơ đang dùng");
  const p = await readPeriod(ctx.trx, ctx.actor.orgId, input.billingPeriodId);
  if (p.property_id !== m.property_id) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy kỳ thu");
  if (p.status === "issued" || p.status === "locked") {
    throw new CommandError("PERIOD_ISSUED", 409, "Kỳ đã phát hành. Dùng chứng từ điều chỉnh.");
  }
  if (p.status !== "draft")
    throw new CommandError("INVALID_TRANSITION", 409, "Kỳ đang chờ duyệt — trả về nháp để sửa chỉ số");
  assertReading(input.value, "value");
  const readOn = input.readOn ?? p.period_end;
  assertDate(readOn, "read_on");
  if (input.photoFileId && !UUID.test(input.photoFileId))
    throw fieldError("photo_file_id", "INVALID", "Ảnh không hợp lệ");
  const prev = await previousReading(ctx.trx, ctx.actor.orgId, m.id, {
    before: readOn,
    excludePeriodId: p.id,
  });
  if (input.value < prev.value) {
    throw new CommandError(
      "METER_READING_DECREASED",
      422,
      `Chỉ số ${input.value} nhỏ hơn lần đọc trước ${prev.value}`,
      {
        extensions: {
          previous_value: prev.value,
          errors: [{ path: "value", field: "value", code: "DECREASED" }],
        },
      },
    );
  }
  const existing = await sql<{ id: string; version: number }>`
    select id, version from meter_readings
    where organization_id = ${ctx.actor.orgId} and meter_id = ${m.id} and billing_period_id = ${p.id} and source = 'period'
    for update`.execute(ctx.trx);
  let readingId: string;
  let version: number;
  const cur = existing.rows[0];
  if (cur) {
    if (input.baseVersion !== undefined && input.baseVersion !== cur.version) {
      throw new CommandError("VERSION_CONFLICT", 409, "Chỉ số vừa được người khác cập nhật — tải lại");
    }
    await sql`
      update meter_readings set value = ${input.value}, read_on = ${readOn}::date, photo_file_id = ${input.photoFileId ?? null},
             status = 'draft', approved_by = null, entered_by = ${ctx.actor.membershipId}, anomaly_note = null,
             anomaly_acknowledged_by = null, version = version + 1
      where id = ${cur.id}`.execute(ctx.trx);
    readingId = cur.id;
    version = cur.version + 1;
  } else {
    readingId = randomUUID();
    version = 1;
    await sql`
      insert into meter_readings (id, organization_id, property_id, meter_id, billing_period_id, read_on, value, photo_file_id,
                                  source, entered_by)
      values (${readingId}, ${ctx.actor.orgId}, ${m.property_id}, ${m.id}, ${p.id}, ${readOn}::date, ${input.value},
              ${input.photoFileId ?? null}, 'period', ${ctx.actor.membershipId})`.execute(ctx.trx);
  }
  const consumption = await periodConsumption(ctx.trx, ctx.actor.orgId, readingId);
  const avg = await historyAverage(ctx.trx, ctx.actor.orgId, m.unit_id, m.kind, p);
  const anomaly = avg !== null && consumption > ANOMALY.factor * avg ? { average: avg } : null;
  await ctx.audit({
    action: "meter.reading_recorded",
    entityType: "meter_reading",
    entityId: readingId,
    propertyId: m.property_id,
    after: { value: input.value, consumption, anomaly: anomaly !== null },
  });
  return { readingId, version, consumption, anomaly };
}

/**
 * Lượng tiêu thụ tới chỉ số `readingId`: lùi về chỉ số đã duyệt trước trên cùng công tơ; nếu công tơ là công tơ thay thế thì
 * cộng đoạn của công tơ cũ (S-006: (cuối cũ − đầu kỳ) + (cuối kỳ mới − đầu mới)). Không đoán quay vòng.
 */
export async function periodConsumption(
  trx: Transaction<unknown>,
  orgId: string,
  readingId: string,
): Promise<number> {
  const r = await sql<{ meter_id: string; value: string; read_on: string }>`
    select meter_id, value::text, read_on::text from meter_readings where organization_id = ${orgId} and id = ${readingId}`.execute(
    trx,
  );
  const end = r.rows[0];
  if (!end) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy chỉ số");
  let meterId = end.meter_id;
  let value = Number(end.value);
  let before = end.read_on;
  let excludeId: string | null = readingId;
  let total = 0;
  for (let hop = 0; hop < 5; hop++) {
    const prev = await sql<{ value: string }>`
      select value::text from meter_readings
      where organization_id = ${orgId} and meter_id = ${meterId} and status = 'approved' and read_on <= ${before}::date
        and id is distinct from ${excludeId}::uuid and source <> 'replacement'
      order by read_on desc, value desc, created_at desc limit 1`.execute(trx);
    if (prev.rows[0]) return total + value - Number(prev.rows[0].value);
    const ev = await sql<{
      meter_id: string;
      old_final_value: string;
      new_initial_value: string;
      occurred_on: string;
    }>`
      select meter_id, old_final_value::text, new_initial_value::text, occurred_on::text from meter_events
      where organization_id = ${orgId} and new_meter_id = ${meterId}`.execute(trx);
    const e = ev.rows[0];
    if (!e) {
      const m = await sql<{
        v: string;
      }>`select initial_value::text as v from meters where organization_id = ${orgId} and id = ${meterId}`.execute(
        trx,
      );
      return total + value - Number(m.rows[0]?.v ?? 0);
    }
    total += value - Number(e.new_initial_value);
    meterId = e.meter_id;
    value = Number(e.old_final_value);
    before = e.occurred_on;
    excludeId = null;
  }
  throw new Error("chuỗi thay công tơ quá dài");
}

/** Trung bình tiêu thụ của `ANOMALY.history` kỳ ngay trước (cùng phòng, cùng loại); thiếu dữ liệu ⇒ null (không cảnh báo). */
async function historyAverage(
  trx: Transaction<unknown>,
  orgId: string,
  unitId: string,
  kind: MeterKind,
  p: PeriodRow,
): Promise<number | null> {
  const r = await sql<{ id: string }>`
    select r.id from billing_periods bp
    join meter_readings r on r.organization_id = bp.organization_id and r.billing_period_id = bp.id and r.source = 'period'
      and r.status = 'approved'
    join meters m on m.organization_id = r.organization_id and m.id = r.meter_id and m.unit_id = ${unitId} and m.kind = ${kind}
    where bp.organization_id = ${orgId} and bp.property_id = ${p.property_id} and bp.period_start < ${p.period_start}::date
    order by bp.period_start desc limit ${ANOMALY.history}`.execute(trx);
  if (r.rows.length < ANOMALY.history) return null;
  let sum = 0;
  for (const x of r.rows) sum += await periodConsumption(trx, orgId, x.id);
  return sum / r.rows.length;
}

export interface AnomalyItem {
  [k: string]: string | number | null;
  reading_id: string;
  unit: string;
  meter: MeterKind;
  consumption: number;
  average: number;
}

/** Bất thường chưa ghi nhận của kỳ (S-008) — `billing.submitForReview` chặn khi danh sách khác rỗng. */
export async function unresolvedAnomalies(
  trx: Transaction<unknown>,
  orgId: string,
  periodId: string,
): Promise<AnomalyItem[]> {
  const p = await readPeriod(trx, orgId, periodId);
  const r = await sql<{ id: string; unit_id: string; code: string; kind: MeterKind }>`
    select r.id, m.unit_id, u.code, m.kind from meter_readings r
    join meters m on m.organization_id = r.organization_id and m.id = r.meter_id
    join units u on u.organization_id = m.organization_id and u.id = m.unit_id
    where r.organization_id = ${orgId} and r.billing_period_id = ${periodId} and r.source = 'period'
      and r.anomaly_acknowledged_by is null
    order by u.code, m.kind`.execute(trx);
  const out: AnomalyItem[] = [];
  for (const x of r.rows) {
    const avg = await historyAverage(trx, orgId, x.unit_id, x.kind, p);
    if (avg === null) continue;
    const c = await periodConsumption(trx, orgId, x.id);
    if (c > ANOMALY.factor * avg)
      out.push({ reading_id: x.id, unit: x.code, meter: x.kind, consumption: c, average: avg });
  }
  return out;
}

/** `meter.acknowledgeAnomaly` (S-008): người lập kỳ ghi nhận đã kiểm tra, kèm ghi chú. */
export async function acknowledgeAnomaly(
  ctx: CommandContext,
  input: { readingId: string; note: string },
): Promise<{ readingId: string }> {
  if (!UUID.test(input.readingId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy chỉ số");
  const r = await sql<{ property_id: string; source: string }>`
    select property_id, source from meter_readings where organization_id = ${ctx.actor.orgId} and id = ${input.readingId}`.execute(
    ctx.trx,
  );
  const row = r.rows[0];
  if (row?.source !== "period") throw new CommandError("NOT_FOUND", 404, "Không tìm thấy chỉ số");
  authorize(ctx.actor, "billing.prepare", { propertyId: row.property_id });
  const note = input.note.trim();
  if (!note || note.length > 1000) throw fieldError("note", "REQUIRED", "Cần ghi chú (≤ 1.000 ký tự)");
  await sql`
    update meter_readings set anomaly_note = ${note}, anomaly_acknowledged_by = ${ctx.actor.membershipId}, version = version + 1
    where organization_id = ${ctx.actor.orgId} and id = ${input.readingId}`.execute(ctx.trx);
  await ctx.audit({
    action: "meter.anomaly_acknowledged",
    entityType: "meter_reading",
    entityId: input.readingId,
    propertyId: row.property_id,
    reason: note,
  });
  return { readingId: input.readingId };
}

export interface MissingItem {
  [k: string]: string | number | null;
  unit_id: string;
  unit: string;
  meter: MeterKind | null;
  reason: "no_reading" | "readings_pending";
}

/**
 * Phòng có hợp đồng còn hiệu lực trong kỳ mà thiếu chỉ số kỳ của công tơ đang dùng, hoặc bàn giao nhập từ hệ thống cũ còn
 * `readings_pending` (S-009) — `billing.submitForReview` chặn khi khác rỗng.
 */
export async function missingReadings(
  trx: Transaction<unknown>,
  orgId: string,
  periodId: string,
): Promise<MissingItem[]> {
  const p = await readPeriod(trx, orgId, periodId);
  const r = await sql<MissingItem>`
    with leased as (
      select distinct l.unit_id, l.id as lease_id from leases l
      join lease_versions v on v.organization_id = l.organization_id and v.lease_id = l.id and v.signed_at is not null
      where l.organization_id = ${orgId} and l.property_id = ${p.property_id} and l.status in ('active','notice_given','settling')
        and v.effective_from <= ${p.period_end}::date and (v.effective_to is null or v.effective_to >= ${p.period_start}::date)
    )
    select u.id as unit_id, u.code as unit, m.kind as meter, 'no_reading' as reason
    from leased x join units u on u.organization_id = ${orgId} and u.id = x.unit_id
    join meters m on m.organization_id = u.organization_id and m.unit_id = u.id and m.installed_on <= ${p.period_end}::date
      and (m.removed_on is null or m.removed_on > ${p.period_end}::date)
    where not exists (select 1 from meter_readings r where r.organization_id = m.organization_id and r.meter_id = m.id
                        and r.billing_period_id = ${p.id} and r.source = 'period')
    union all
    select u.id, u.code, null, 'readings_pending' from leased x
    join handovers h on h.organization_id = ${orgId} and h.lease_id = x.lease_id and h.readings_pending
    join units u on u.organization_id = ${orgId} and u.id = x.unit_id
    order by unit, meter`.execute(trx);
  return r.rows;
}

/** `meter.replace` (S-006, S-007): chỉ owner/manager; chốt chỉ số cuối công tơ cũ, lắp công tơ mới, ghi sự kiện. */
export async function replaceMeter(
  ctx: CommandContext,
  input: {
    meterId: string;
    occurredOn: string;
    oldFinalValue: number;
    newInitialValue: number;
    newSerial?: string;
    oldPhotoFileId?: string;
    newPhotoFileId?: string;
  },
): Promise<{ newMeterId: string; eventId: string }> {
  const seen = await readMeter(ctx.trx, ctx.actor.orgId, input.meterId);
  authorize(ctx.actor, "meter.replace", { propertyId: seen.property_id });
  const m = await readMeter(ctx.trx, ctx.actor.orgId, input.meterId, true);
  if (m.removed_on) throw new CommandError("INVALID_TRANSITION", 409, "Công tơ đã được thay");
  assertDate(input.occurredOn, "occurred_on");
  if (input.occurredOn < m.installed_on)
    throw fieldError("occurred_on", "BEFORE_INSTALL", "Ngày thay trước ngày lắp");
  assertReading(input.oldFinalValue, "old_final_value");
  assertReading(input.newInitialValue, "new_initial_value");
  const prev = await previousReading(ctx.trx, ctx.actor.orgId, m.id, { before: input.occurredOn });
  if (input.oldFinalValue < prev.value) {
    throw new CommandError(
      "METER_READING_DECREASED",
      422,
      `Chỉ số cuối ${input.oldFinalValue} nhỏ hơn lần đọc trước ${prev.value}`,
      {
        extensions: {
          previous_value: prev.value,
          errors: [{ path: "old_final_value", field: "old_final_value", code: "DECREASED" }],
        },
      },
    );
  }
  for (const [f, id] of [
    ["old_photo_file_id", input.oldPhotoFileId],
    ["new_photo_file_id", input.newPhotoFileId],
  ] as const) {
    if (id !== undefined && !UUID.test(id)) throw fieldError(f, "INVALID", "Ảnh không hợp lệ");
  }
  await sql`
    insert into meter_readings (id, organization_id, property_id, meter_id, read_on, value, photo_file_id, status, source,
                                entered_by, approved_by)
    values (${randomUUID()}, ${ctx.actor.orgId}, ${m.property_id}, ${m.id}, ${input.occurredOn}::date, ${input.oldFinalValue},
            ${input.oldPhotoFileId ?? null}, 'approved', 'replacement', ${ctx.actor.membershipId}, ${ctx.actor.membershipId})`.execute(
    ctx.trx,
  );
  await sql`update meters set removed_on = ${input.occurredOn}::date, version = version + 1 where id = ${m.id}`.execute(
    ctx.trx,
  );
  const newMeterId = randomUUID();
  await sql`
    insert into meters (id, organization_id, property_id, unit_id, kind, serial, installed_on, initial_value)
    values (${newMeterId}, ${ctx.actor.orgId}, ${m.property_id}, ${m.unit_id}, ${m.kind}, ${input.newSerial ?? null},
            ${input.occurredOn}::date, ${input.newInitialValue})`.execute(ctx.trx);
  const eventId = randomUUID();
  await sql`
    insert into meter_events (id, organization_id, property_id, meter_id, kind, occurred_on, old_final_value, new_meter_id,
                              new_initial_value, old_photo_file_id, new_photo_file_id, approved_by, command_id)
    values (${eventId}, ${ctx.actor.orgId}, ${m.property_id}, ${m.id}, 'replacement', ${input.occurredOn}::date, ${input.oldFinalValue},
            ${newMeterId}, ${input.newInitialValue}, ${input.oldPhotoFileId ?? null}, ${input.newPhotoFileId ?? null},
            ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(ctx.trx);
  await ctx.audit({
    action: "meter.replaced",
    entityType: "meter",
    entityId: m.id,
    propertyId: m.property_id,
    after: {
      new_meter_id: newMeterId,
      old_final_value: input.oldFinalValue,
      new_initial_value: input.newInitialValue,
    },
  });
  return { newMeterId, eventId };
}

export interface RouteItem {
  floor: string;
  unit_id: string;
  unit: string;
  meters: {
    meter_id: string;
    kind: MeterKind;
    previous_value: number;
    previous_photo_file_id: string | null;
    reading_id: string | null;
    value: number | null;
    version: number | null;
    entered: boolean;
  }[];
}

/** `meter.getReadingRoute` (S-010): chốt chỉ số theo tầng (thứ tự tầng) rồi mã phòng; chỉ số/ảnh trước, cờ đã nhập. */
export async function readingRoute(
  db: Kysely<unknown>,
  actor: Actor,
  input: { billingPeriodId: string },
): Promise<RouteItem[]> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await readPeriod(trx, actor.orgId, input.billingPeriodId);
    authorize(actor, "meter.record", { propertyId: p.property_id });
    const rows = await sql<{
      floor: string;
      unit_id: string;
      unit: string;
      meter_id: string;
      kind: MeterKind;
      reading_id: string | null;
      value: string | null;
      version: number | null;
    }>`
      select f.name as floor, u.id as unit_id, u.code as unit, m.id as meter_id, m.kind,
             r.id as reading_id, r.value::text as value, r.version
      from units u
      join floors f on f.organization_id = u.organization_id and f.id = u.floor_id
      join meters m on m.organization_id = u.organization_id and m.unit_id = u.id and m.installed_on <= ${p.period_end}::date
        and (m.removed_on is null or m.removed_on > ${p.period_end}::date)
      left join meter_readings r on r.organization_id = m.organization_id and r.meter_id = m.id and r.billing_period_id = ${p.id}
        and r.source = 'period'
      where u.organization_id = ${actor.orgId} and u.property_id = ${p.property_id} and u.archived_at is null
      order by f.sort_order, f.name, u.code, m.kind`.execute(trx);
    const out: RouteItem[] = [];
    for (const x of rows.rows) {
      let item = out.at(-1);
      if (!item || item.unit_id !== x.unit_id) {
        item = { floor: x.floor, unit_id: x.unit_id, unit: x.unit, meters: [] };
        out.push(item);
      }
      const prev = await previousReading(trx, actor.orgId, x.meter_id, {
        before: p.period_end,
        excludePeriodId: p.id,
      });
      item.meters.push({
        meter_id: x.meter_id,
        kind: x.kind,
        previous_value: prev.value,
        previous_photo_file_id: prev.photoFileId,
        reading_id: x.reading_id,
        value: x.value === null ? null : Number(x.value),
        version: x.version,
        entered: x.reading_id !== null,
      });
    }
    return out;
  });
}
