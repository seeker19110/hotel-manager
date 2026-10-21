// Dịch vụ, đơn giá hiệu lực và công tơ (PLAN đợt 2 T-112; SPEC-metering-billing S-005…S-010, S-017; ERD `meters`,
// `meter_readings`, `meter_events`, `service_prices`). Chỉ số không giảm (trừ thay công tơ có quyền); lượng tiêu thụ kỳ đi
// qua chuỗi thay công tơ; bất thường (> 2 × trung bình 3 kỳ trước) phải được ghi nhận trước khi gửi duyệt kỳ (T-114).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { authorize, decimalSub, hasMaxDecimals } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { type CommandContext, CommandError, fieldError } from "../pipeline/index.ts";

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

/**
 * `priceAt` theo lô (AUD-PERF-001): đơn giá hiệu lực cho nhiều cặp (dịch vụ, ngày) bằng MỘT truy vấn. Khoá kết quả
 * `priceKey(serviceId, on)`; cùng điều kiện hiệu lực với `priceAt` (ràng buộc không chồng ⇒ tối đa một giá mỗi cặp).
 */
export async function pricesAt(
  trx: Transaction<unknown>,
  orgId: string,
  wanted: { serviceId: string; on: string }[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const w of wanted) out.set(priceKey(w.serviceId, w.on), null);
  const pairs = [...out.keys()].map((k) => k.split("|") as [string, string]);
  if (pairs.length === 0) return out;
  const r = await sql<{ i: number; p: string }>`
    select x.i::int as i, sp.unit_price::text as p
    from unnest(${pairs.map((x) => x[0])}::uuid[], ${pairs.map((x) => x[1])}::date[]) with ordinality as x(service_id, on_date, i)
    join service_prices sp on sp.organization_id = ${orgId} and sp.service_id = x.service_id
      and sp.effective_from <= x.on_date and (sp.effective_to is null or sp.effective_to >= x.on_date)`.execute(
    trx,
  );
  const seen = new Set<number>();
  for (const row of r.rows) {
    if (seen.has(row.i)) continue;
    seen.add(row.i);
    const [serviceId, on] = pairs[row.i - 1] as [string, string];
    out.set(priceKey(serviceId, on), Number(row.p));
  }
  return out;
}

export const priceKey = (serviceId: string, on: string): string => `${serviceId}|${on}`;

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
  // Ngày đọc nằm trong kỳ: lùi ngày ra ngoài kỳ từng né được kiểm chỉ số giảm và tính lại lượng của kỳ đã thu (review lát 3).
  if (readOn < p.period_start || readOn > p.period_end || readOn < m.installed_on)
    throw fieldError(
      "read_on",
      "OUT_OF_PERIOD",
      `Ngày đọc phải trong kỳ ${p.period_start} – ${p.period_end}`,
    );
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
  // Không lớn hơn chỉ số đã duyệt đọc SAU ngày này (vd bàn giao nhận phòng của người kế tiếp) — chỉ số chỉ tăng theo thời gian.
  const later = await sql<{ v: string }>`
    select min(value)::text as v from meter_readings
    where organization_id = ${ctx.actor.orgId} and meter_id = ${m.id} and status = 'approved' and read_on > ${readOn}::date
      and billing_period_id is distinct from ${p.id}::uuid`.execute(ctx.trx);
  const next = later.rows[0]?.v;
  if (next != null && input.value > Number(next)) {
    throw fieldError("value", "EXCEEDS_LATER_READING", `Chỉ số lớn hơn lần đọc sau (${Number(next)})`);
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
  return Number(await periodConsumptionText(trx, orgId, readingId));
}

/** Như `periodConsumption` nhưng chính xác thập phân (chuỗi) — dùng cho dòng phiếu (112,7 − 100,5 = 12,2, không sai số thực). */
export async function periodConsumptionText(
  trx: Transaction<unknown>,
  orgId: string,
  readingId: string,
): Promise<string> {
  return (await periodConsumptionTexts(trx, orgId, [readingId])).get(readingId) as string;
}

/**
 * `periodConsumptionText` theo lô (AUD-PERF-001): lượng tiêu thụ của nhiều chỉ số bằng số truy vấn KHÔNG phụ thuộc số chỉ số —
 * 1 truy vấn đọc chỉ số cuối + mỗi bước lùi (≤ 5, theo chuỗi thay công tơ) tối đa 3 truy vấn cho mọi chỉ số còn dở. Cùng quy
 * tắc với bản đơn lẻ: lùi về chỉ số đã duyệt trước trên cùng công tơ (bỏ chỉ số tháo công tơ); không có thì qua sự kiện thay
 * công tơ sang công tơ cũ; không có sự kiện thì từ chỉ số lắp.
 */
export async function periodConsumptionTexts(
  trx: Transaction<unknown>,
  orgId: string,
  readingIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(readingIds)];
  if (ids.length === 0) return out;
  const r = await sql<{ id: string; meter_id: string; value: string; read_on: string }>`
    select id, meter_id, value::text, read_on::text from meter_readings
    where organization_id = ${orgId} and id = any(${ids}::uuid[])`.execute(trx);
  const ends = new Map(r.rows.map((x) => [x.id, x]));
  interface Walk {
    readingId: string;
    meterId: string;
    value: string;
    before: string;
    excludeId: string | null;
    total: string;
  }
  let pending: Walk[] = ids.map((id) => {
    const end = ends.get(id);
    if (!end) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy chỉ số");
    return {
      readingId: id,
      meterId: end.meter_id,
      value: end.value,
      before: end.read_on,
      excludeId: id,
      total: "0",
    };
  });
  // total + (value − prev) viết bằng phép trừ thập phân: total − (prev − value).
  const add = (w: Walk, prev: string) => decimalSub(w.total, decimalSub(prev, w.value));
  for (let hop = 0; hop < 5 && pending.length > 0; hop++) {
    const prev = await sql<{ i: number; value: string }>`
      select x.i::int as i, p.value
      from unnest(${pending.map((w) => w.meterId)}::uuid[], ${pending.map((w) => w.before)}::date[],
                  ${pending.map((w) => w.excludeId)}::uuid[]) with ordinality as x(meter_id, before, exclude_id, i)
      cross join lateral (
        select r.value::text as value from meter_readings r
        where r.organization_id = ${orgId} and r.meter_id = x.meter_id and r.status = 'approved' and r.read_on <= x.before
          and r.id is distinct from x.exclude_id and r.source <> 'replacement'
        order by r.read_on desc, r.value desc, r.created_at desc limit 1) p`.execute(trx);
    const prevBy = new Map(prev.rows.map((x) => [x.i - 1, x.value]));
    const rest: Walk[] = [];
    for (const [i, w] of pending.entries()) {
      const v = prevBy.get(i);
      if (v !== undefined) out.set(w.readingId, add(w, v));
      else rest.push(w);
    }
    pending = rest;
    if (rest.length === 0) break;
    const ev = await sql<{
      new_meter_id: string;
      meter_id: string;
      old_final_value: string;
      new_initial_value: string;
      occurred_on: string;
    }>`
      select new_meter_id, meter_id, old_final_value::text, new_initial_value::text, occurred_on::text from meter_events
      where organization_id = ${orgId} and new_meter_id = any(${[...new Set(rest.map((w) => w.meterId))]}::uuid[])`.execute(
      trx,
    );
    const evBy = new Map<string, (typeof ev.rows)[number]>();
    for (const e of ev.rows) if (!evBy.has(e.new_meter_id)) evBy.set(e.new_meter_id, e);
    const noEvent = [...new Set(rest.filter((w) => !evBy.has(w.meterId)).map((w) => w.meterId))];
    const initial = new Map<string, string>();
    if (noEvent.length > 0) {
      const m = await sql<{ id: string; v: string }>`
        select id, initial_value::text as v from meters where organization_id = ${orgId} and id = any(${noEvent}::uuid[])`.execute(
        trx,
      );
      for (const x of m.rows) initial.set(x.id, x.v);
    }
    pending = [];
    for (const w of rest) {
      const e = evBy.get(w.meterId);
      if (!e) {
        out.set(w.readingId, add(w, initial.get(w.meterId) ?? "0"));
        continue;
      }
      pending.push({
        readingId: w.readingId,
        total: add(w, e.new_initial_value),
        meterId: e.meter_id,
        value: e.old_final_value,
        before: e.occurred_on,
        excludeId: null,
      });
    }
  }
  if (pending.length > 0) throw new Error("chuỗi thay công tơ quá dài");
  return out;
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
        and v.effective_from <= ${p.period_end}::date and (v.effective_until is null or v.effective_until >= ${p.period_start}::date)
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
  // Không lùi ngày thay vào trước lần đọc đã duyệt cuối hoặc vào kỳ đã phát hành (lượng của kỳ đã thu không đổi được).
  const latest = await sql<{ read_on: string }>`
    select max(read_on)::text as read_on from meter_readings
    where organization_id = ${ctx.actor.orgId} and meter_id = ${m.id} and status = 'approved'`.execute(
    ctx.trx,
  );
  const lastOn = latest.rows[0]?.read_on;
  if (lastOn && input.occurredOn < lastOn)
    throw fieldError(
      "occurred_on",
      "BEFORE_LAST_READING",
      `Ngày thay trước lần đọc đã duyệt cuối (${lastOn})`,
    );
  const issued = await sql<{ period_end: string }>`
    select max(period_end)::text as period_end from billing_periods
    where organization_id = ${ctx.actor.orgId} and property_id = ${m.property_id} and status in ('issued','locked')`.execute(
    ctx.trx,
  );
  const issuedEnd = issued.rows[0]?.period_end;
  if (issuedEnd && input.occurredOn <= issuedEnd)
    throw new CommandError(
      "PERIOD_ISSUED",
      409,
      `Ngày thay thuộc kỳ đã phát hành (đến ${issuedEnd}). Dùng điều chỉnh.`,
    );
  const prev = await previousReading(ctx.trx, ctx.actor.orgId, m.id);
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

/**
 * Chỉ số đầu từ lô nhập chuyển đổi (SPEC-import S-010): nguồn `import`, đã duyệt ngay (người xác nhận lô chịu trách nhiệm),
 * không thuộc kỳ thu. Phòng chưa có công tơ loại này ⇒ lắp công tơ với chỉ số đầu = giá trị nhập. Chỉ số phải không nhỏ hơn
 * và không lớn hơn các lần đọc đã duyệt trước/sau ngày đọc; kỳ đã phát hành phủ ngày đọc ⇒ PERIOD_ISSUED.
 */
export async function importReading(
  ctx: CommandContext,
  input: { unitId: string; kind: MeterKind; value: string; readOn: string },
): Promise<{ readingId: string; meterId: string; installed: boolean }> {
  assertDate(input.readOn, "read_on");
  const value = Number(input.value);
  assertReading(value, "value");
  const found = await sql<{ id: string; property_id: string }>`
    select id, property_id from meters where organization_id = ${ctx.actor.orgId} and unit_id = ${input.unitId}
      and kind = ${input.kind} and removed_on is null for update`.execute(ctx.trx);
  let meterId = found.rows[0]?.id;
  let installed = false;
  if (!meterId) {
    meterId = (
      await installMeter(ctx, {
        unitId: input.unitId,
        kind: input.kind,
        installedOn: input.readOn,
        initialValue: value,
      })
    ).meterId;
    installed = true;
  }
  const m = await readMeter(ctx.trx, ctx.actor.orgId, meterId);
  authorize(ctx.actor, "meter.record", { propertyId: m.property_id });
  if (input.readOn < m.installed_on)
    throw fieldError("read_on", "BEFORE_INSTALL", "Ngày đọc trước ngày lắp công tơ");
  const issued = await sql`
    select 1 from billing_periods where organization_id = ${ctx.actor.orgId} and property_id = ${m.property_id}
      and status in ('issued','locked') and period_end >= ${input.readOn}::date limit 1`.execute(ctx.trx);
  if (issued.rows.length > 0) throw new CommandError("PERIOD_ISSUED", 409, "Ngày đọc thuộc kỳ đã phát hành");
  const prev = await previousReading(ctx.trx, ctx.actor.orgId, m.id, { before: input.readOn });
  if (value < prev.value) {
    throw new CommandError(
      "METER_READING_DECREASED",
      422,
      `Chỉ số ${value} nhỏ hơn lần đọc trước ${prev.value}`,
      {
        extensions: { previous_value: prev.value },
      },
    );
  }
  const later = await sql<{ v: string | null }>`
    select min(value)::text as v from meter_readings where organization_id = ${ctx.actor.orgId} and meter_id = ${m.id}
      and status = 'approved' and read_on > ${input.readOn}::date`.execute(ctx.trx);
  const next = later.rows[0]?.v;
  if (next != null && value > Number(next))
    throw fieldError("value", "EXCEEDS_LATER_READING", `Chỉ số lớn hơn lần đọc sau (${Number(next)})`);
  const readingId = randomUUID();
  await sql`
    insert into meter_readings (id, organization_id, property_id, meter_id, read_on, value, status, source, entered_by, approved_by)
    values (${readingId}, ${ctx.actor.orgId}, ${m.property_id}, ${m.id}, ${input.readOn}::date, ${input.value}, 'approved', 'import',
            ${ctx.actor.membershipId}, ${ctx.actor.membershipId})`.execute(ctx.trx);
  await ctx.audit({
    action: "meter.reading_imported",
    entityType: "meter_reading",
    entityId: readingId,
    propertyId: m.property_id,
    after: { meter_id: m.id, value: input.value, read_on: input.readOn },
  });
  return { readingId, meterId: m.id, installed };
}
