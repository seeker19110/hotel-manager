// Vòng đời kỳ thu nhà trọ (PLAN đợt 2 T-114; SPEC-metering-billing S-001…S-004, S-011…S-015; DOMAIN-MODEL §4, §5).
// Tạo kỳ (job theo ngày địa phương, chạy lại không trùng) → xem trước (engine thuần, có `preview_hash`) → gửi duyệt (đủ chỉ
// số, không còn bất thường) → phát hành (hash phải khớp số hiện tại; phiếu + charges snapshot + bút toán AR/REV; một phiếu mỗi
// hợp đồng mỗi kỳ) → khoá/mở khoá qua cùng cơ chế `period_locks` của sổ.
import { createHash, randomUUID } from "node:crypto";
import { withTenant, withTenantRetry } from "@hm/db";
import {
  authorize,
  type BillingLine,
  billingPeriodMachine,
  computeLeaseInvoice,
  type FixedServiceInput,
  generateMemoRef,
  type MeteredInput,
  type ProrataMode,
  type RevenueAccount,
  type RoundingRule,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { lockPeriod, postEntry, unlockPeriod } from "../ledger/index.ts";
import {
  missingReadings,
  periodConsumptionTexts,
  priceKey,
  pricesAt,
  readPeriod,
  unresolvedAnomalies,
} from "../metering/index.ts";
import { type CommandContext, CommandError, canonicalJson, fieldError } from "../pipeline/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Tạo kỳ ----------

/** `billing.createPeriod`: kỳ theo tháng dương lịch; đã có thì trả kỳ hiện có (S-013). */
export async function createPeriod(
  ctx: CommandContext,
  input: { propertyId: string; month: string },
): Promise<{ billingPeriodId: string; created: boolean }> {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(ctx.actor, "billing.prepare", { propertyId: input.propertyId });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))
    throw fieldError("month", "INVALID", "Tháng dạng YYYY-MM");
  const id = randomUUID();
  const ins = await sql<{ id: string }>`
    insert into billing_periods (id, organization_id, property_id, period_start, period_end)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${`${input.month}-01`}::date,
            (${`${input.month}-01`}::date + interval '1 month' - interval '1 day')::date)
    on conflict (organization_id, property_id, period_start) do nothing returning id`.execute(ctx.trx);
  if (ins.rows[0]) {
    await ctx.audit({
      action: "billing.period_created",
      entityType: "billing_period",
      entityId: id,
      propertyId: input.propertyId,
    });
    return { billingPeriodId: id, created: true };
  }
  const r = await sql<{ id: string }>`
    select id from billing_periods where organization_id = ${ctx.actor.orgId} and property_id = ${input.propertyId}
      and period_start = ${`${input.month}-01`}::date`.execute(ctx.trx);
  return { billingPeriodId: r.rows[0]?.id as string, created: false };
}

/** Job `billing.generatePeriods` (S-013, S-014): tháng hiện tại theo giờ cơ sở; nhiều worker song song vẫn một kỳ. */
export async function generatePeriods(workerDb: Kysely<unknown>, now: Date): Promise<number> {
  const due = await sql<{
    organization_id: string;
    property_id: string;
    period_start: string;
    period_end: string;
  }>`
    select organization_id, property_id, period_start::text, period_end::text from app.properties_due_period(${now})`.execute(
    workerDb,
  );
  let created = 0;
  for (const d of due.rows) {
    const r = await withTenantRetry(workerDb, { orgId: d.organization_id }, (trx) =>
      sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end)
          values (${randomUUID()}, ${d.organization_id}, ${d.property_id}, ${d.period_start}::date, ${d.period_end}::date)
          on conflict (organization_id, property_id, period_start) do nothing`.execute(trx),
    );
    created += Number(r.numAffectedRows ?? 0);
  }
  return created;
}

// ---------- Xem trước ----------

export interface PreviewItem {
  lease_id: string;
  unit: string;
  payer_person_id: string;
  lines: (BillingLine & { readingIds?: string[] })[];
  total: number;
  /** Loại công tơ còn thiếu chỉ số kỳ (gửi duyệt sẽ bị chặn). */
  missing: string[];
}

export interface Preview {
  billing_period_id: string;
  period_start: string;
  period_end: string;
  status: string;
  items: PreviewItem[];
  total: number;
  preview_hash: string;
}

interface LeaseSvc {
  service_id: string;
  quantity: number;
  unit_price?: number;
}

interface LeaseVersionRow {
  id: string;
  from: string;
  to: string | null;
  rent: string;
  services: LeaseSvc[];
}

interface ServiceRow {
  id: string;
  name: string;
  kind: string;
  revenue_account: RevenueAccount;
  meter_kind: string | null;
}

/** Ảnh chụp số liệu kỳ → engine thuần. Cùng số liệu ⇒ cùng `preview_hash` (S-004). */
export async function buildPreview(
  trx: Transaction<unknown>,
  orgId: string,
  periodId: string,
): Promise<Preview> {
  const p = await readPeriod(trx, orgId, periodId);
  const settings = await sql<{ rounding: string | null; prorata: string | null }>`
    select settings->>'rounding' as rounding, settings->>'prorata' as prorata from properties
    where organization_id = ${orgId} and id = ${p.property_id}`.execute(trx);
  const rounding: RoundingRule = settings.rows[0]?.rounding === "HALF_UP_1000" ? "HALF_UP_1000" : "HALF_UP_1";
  const prorata: ProrataMode = settings.rows[0]?.prorata === "fixed_30" ? "fixed_30" : "actual_days";
  const leases = await sql<{
    id: string;
    unit_id: string;
    unit: string;
    billing_start_on: string;
    moved_out_on: string | null;
    payer: string;
  }>`
    select l.id, l.unit_id, u.code as unit, l.billing_start_on::text, l.moved_out_on::text, l.representative_person_id as payer
    from leases l join units u on u.organization_id = l.organization_id and u.id = l.unit_id
    where l.organization_id = ${orgId} and l.property_id = ${p.property_id}
      and l.status in ('active','notice_given','settling','closed')
      and l.billing_start_on <= ${p.period_end}::date and (l.moved_out_on is null or l.moved_out_on >= ${p.period_start}::date)
    order by u.code, l.id`.execute(trx);
  // AUD-PERF-001: số liệu của MỌI hợp đồng trong kỳ đọc theo lô (số truy vấn cố định, không theo số hợp đồng/công tơ) rồi
  // tính trong bộ nhớ — cùng điều kiện lọc/thứ tự như bản đọc từng hợp đồng trước đây; tiền vẫn do engine thuần tính.
  const lastDayOf = (l: (typeof leases.rows)[number]) =>
    l.moved_out_on && l.moved_out_on < p.period_end ? l.moved_out_on : p.period_end;
  const leaseIds = leases.rows.map((l) => l.id);
  const versionsBy = new Map<string, LeaseVersionRow[]>();
  if (leaseIds.length > 0) {
    const versions = await sql<LeaseVersionRow & { lease_id: string }>`
      -- Ngày cuối hiệu lực THỰC (phiên bản không thời hạn bị phụ lục thay — D-007).
      select lease_id, id, effective_from::text as "from", effective_until::text as "to", rent_amount::text as rent, services
      from lease_versions where organization_id = ${orgId} and lease_id = any(${leaseIds}::uuid[]) and signed_at is not null
      order by lease_id, version_no`.execute(trx);
    for (const { lease_id, ...v } of versions.rows) {
      const list = versionsBy.get(lease_id) ?? [];
      list.push(v);
      versionsBy.set(lease_id, list);
    }
  }
  const billed = leases.rows.flatMap((l) => {
    const versions = versionsBy.get(l.id);
    if (!versions || versions.length === 0) return [];
    const lastDay = lastDayOf(l);
    const atEnd =
      [...versions].reverse().find((v) => v.from <= lastDay && (v.to === null || v.to >= lastDay)) ??
      (versions.at(-1) as LeaseVersionRow);
    return [{ l, versions, lastDay, atEnd }];
  });
  const svcIds = [...new Set(billed.flatMap((b) => b.atEnd.services.map((s) => s.service_id)))];
  const svcById = new Map<string, ServiceRow>();
  if (svcIds.length > 0) {
    const svcRows = await sql<ServiceRow>`
      select id, name, kind, revenue_account, meter_kind from services
      where organization_id = ${orgId} and id = any(${svcIds}::uuid[])`.execute(trx);
    for (const s of svcRows.rows) svcById.set(s.id, s);
  }
  const prices = await pricesAt(
    trx,
    orgId,
    billed.flatMap((b) =>
      b.atEnd.services
        .filter((term) => term.unit_price === undefined && svcById.has(term.service_id))
        .map((term) => ({ serviceId: term.service_id, on: b.lastDay })),
    ),
  );
  const hasMetered = billed.some((b) =>
    b.atEnd.services.some((term) => svcById.get(term.service_id)?.kind === "metered"),
  );
  // Lượng theo khoảng của TỪNG hợp đồng (review lát 3 🔴1): trả phòng trong kỳ mà biên bản trả có chỉ số ⇒ cuối = chỉ số
  // bàn giao trả (phần sau đó là của phòng trống/người kế tiếp); còn lại cuối = chỉ số kỳ. Đầu luôn là chỉ số đã duyệt liền
  // trước điểm cuối (gồm chỉ số bàn giao nhận phòng nếu vào giữa kỳ) — periodConsumptionTexts.
  const movedOutIds = billed
    .filter((b) => b.l.moved_out_on && b.l.moved_out_on <= p.period_end)
    .map((b) => b.l.id);
  const moveOutReading = new Map<string, string>();
  if (hasMetered && movedOutIds.length > 0) {
    const r = await sql<{ lease_id: string; kind: string; id: string }>`
      select distinct on (h.lease_id, m.kind) h.lease_id, m.kind, r.id from meter_readings r
      join handovers h on h.organization_id = r.organization_id and h.id = r.handover_id
      join meters m on m.organization_id = r.organization_id and m.id = r.meter_id
      where r.organization_id = ${orgId} and h.lease_id = any(${movedOutIds}::uuid[]) and h.kind = 'move_out' and r.status = 'approved'
      order by h.lease_id, m.kind, (m.removed_on is null) desc, r.read_on desc, r.created_at desc`.execute(
      trx,
    );
    for (const x of r.rows) moveOutReading.set(`${x.lease_id}|${x.kind}`, x.id);
  }
  const periodReading = new Map<string, string>();
  if (hasMetered) {
    const unitIds = [...new Set(billed.map((b) => b.l.unit_id))];
    const r = await sql<{ unit_id: string; kind: string; id: string }>`
      select distinct on (m.unit_id, m.kind) m.unit_id, m.kind, r.id
      from meter_readings r join meters m on m.organization_id = r.organization_id and m.id = r.meter_id
      where r.organization_id = ${orgId} and r.billing_period_id = ${p.id} and r.source = 'period'
        and m.unit_id = any(${unitIds}::uuid[])
      order by m.unit_id, m.kind, (m.removed_on is null) desc, r.read_on desc, r.created_at desc`.execute(
      trx,
    );
    for (const x of r.rows) periodReading.set(`${x.unit_id}|${x.kind}`, x.id);
  }
  const readingFor = (b: (typeof billed)[number], s: ServiceRow): string | undefined => {
    if (s.meter_kind === null) return undefined;
    const out =
      b.l.moved_out_on && b.l.moved_out_on <= p.period_end
        ? moveOutReading.get(`${b.l.id}|${s.meter_kind}`)
        : undefined;
    return out ?? periodReading.get(`${b.l.unit_id}|${s.meter_kind}`);
  };
  const consumption = await periodConsumptionTexts(
    trx,
    orgId,
    billed.flatMap((b) =>
      b.atEnd.services.flatMap((term) => {
        const s = svcById.get(term.service_id);
        const rid = s?.kind === "metered" ? readingFor(b, s) : undefined;
        return rid ? [rid] : [];
      }),
    ),
  );
  // Phí một lần (S-016): đúng một lần — ở kỳ chứa ngày bắt đầu áp dụng = max(ngày bắt đầu tính tiền, hiệu lực của phiên bản
  // đầu tiên có dịch vụ này) — nên phí thêm bằng phụ lục cũng được tính (review lát 3 🟠5); đã có khoản phải thu (chưa huỷ)
  // cho hợp đồng + dịch vụ ở kỳ khác thì bỏ qua.
  const oneTimeDue = (b: (typeof billed)[number], s: ServiceRow): boolean => {
    const intro =
      b.versions.find((v) => v.services.some((x) => x.service_id === s.id))?.from ?? b.l.billing_start_on;
    const startOn = intro > b.l.billing_start_on ? intro : b.l.billing_start_on;
    return startOn >= p.period_start && startOn <= p.period_end;
  };
  const oneTime = billed.flatMap((b) =>
    b.atEnd.services.flatMap((term) => {
      const s = svcById.get(term.service_id);
      return s?.kind === "one_time" && oneTimeDue(b, s) ? [{ leaseId: b.l.id, serviceId: s.id }] : [];
    }),
  );
  const charged = new Set<string>();
  if (oneTime.length > 0) {
    const r = await sql<{ lease_id: string; service_id: string }>`
      select distinct lease_id, service_id from charges
      where organization_id = ${orgId} and lease_id = any(${[...new Set(oneTime.map((x) => x.leaseId))]}::uuid[])
        and service_id = any(${[...new Set(oneTime.map((x) => x.serviceId))]}::uuid[])
        and voided_at is null and billing_period_id is distinct from ${p.id}::uuid`.execute(trx);
    for (const x of r.rows) charged.add(`${x.lease_id}|${x.service_id}`);
  }
  const occupants = new Map<string, number>();
  if (billed.length > 0) {
    const r = await sql<{ i: number; n: number }>`
      select x.i::int as i, (
        select count(*)::int from lease_occupants o
        where o.organization_id = ${orgId} and o.lease_id = x.lease_id
          and o.from_on <= x.last_day and (o.to_on is null or o.to_on >= x.last_day)) as n
      from unnest(${billed.map((b) => b.l.id)}::uuid[], ${billed.map((b) => b.lastDay)}::date[])
        with ordinality as x(lease_id, last_day, i)`.execute(trx);
    for (const x of r.rows) occupants.set((billed[x.i - 1] as (typeof billed)[number]).l.id, x.n);
  }

  const items: PreviewItem[] = [];
  for (const b of billed) {
    const { l, versions, lastDay, atEnd } = b;
    const metered: MeteredInput[] = [];
    const fixed: FixedServiceInput[] = [];
    const readingBySvc = new Map<string, string>();
    const missing: string[] = [];
    for (const term of atEnd.services) {
      const s = svcById.get(term.service_id);
      if (!s) continue;
      const priceNum = term.unit_price !== undefined ? undefined : prices.get(priceKey(s.id, lastDay));
      const price =
        term.unit_price !== undefined ? String(term.unit_price) : priceNum == null ? null : String(priceNum);
      if (s.kind === "metered") {
        const readingId = readingFor(b, s);
        if (!readingId) {
          missing.push(s.meter_kind as string);
          continue;
        }
        readingBySvc.set(s.id, readingId);
        metered.push({
          serviceId: s.id,
          name: s.name,
          revenueAccount: s.revenue_account,
          quantity: consumption.get(readingId) as string,
          unitPrice: price,
        });
      } else {
        if (s.kind === "one_time" && (!oneTimeDue(b, s) || charged.has(`${l.id}|${s.id}`))) continue;
        fixed.push({
          serviceId: s.id,
          name: s.name,
          kind: s.kind as FixedServiceInput["kind"],
          revenueAccount: s.revenue_account,
          quantity: term.quantity,
          unitPrice: price,
        });
      }
    }
    const r = computeLeaseInvoice({
      periodStart: p.period_start,
      periodEnd: p.period_end,
      billingStartOn: l.billing_start_on,
      movedOutOn: l.moved_out_on,
      versions: versions.map((v) => ({ id: v.id, from: v.from, to: v.to, rentAmount: Number(v.rent) })),
      metered,
      services: fixed,
      occupantsAtEnd: occupants.get(l.id) ?? 0,
      rounding,
      prorata,
    });
    items.push({
      lease_id: l.id,
      unit: l.unit,
      payer_person_id: l.payer,
      lines: r.lines.map((x) => {
        const rid = x.serviceId ? readingBySvc.get(x.serviceId) : undefined;
        return rid ? { ...x, readingIds: [rid] } : x;
      }),
      total: r.total,
      missing,
    });
  }
  const total = items.reduce((s, i) => s + i.total, 0);
  const preview_hash = createHash("sha256")
    .update(canonicalJson({ period: p.id, items }))
    .digest("hex");
  return {
    billing_period_id: p.id,
    period_start: p.period_start,
    period_end: p.period_end,
    status: p.status,
    items,
    total,
    preview_hash,
  };
}

/** `billing.previewPeriod` (S-001): xem trước kỳ — chỉ đọc. */
export async function previewPeriod(
  db: Kysely<unknown>,
  actor: Actor,
  input: { billingPeriodId: string },
): Promise<Preview> {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await readPeriod(trx, actor.orgId, input.billingPeriodId);
    authorize(actor, "billing.prepare", { propertyId: p.property_id });
    return buildPreview(trx, actor.orgId, p.id);
  });
}

async function lockedPeriod(
  ctx: CommandContext,
  periodId: string,
  action: "billing.prepare" | "billing.issue",
) {
  const seen = await readPeriod(ctx.trx, ctx.actor.orgId, periodId);
  authorize(ctx.actor, action, { propertyId: seen.property_id });
  return readPeriod(ctx.trx, ctx.actor.orgId, periodId, true);
}

/** `billing.submitForReview` (S-008, S-009): draft → reviewing khi đủ chỉ số và không còn bất thường chưa ghi nhận. */
/**
 * Kỳ phải duyệt/phát hành theo thứ tự (review lát 3 🔴2): lượng tiêu thụ lùi về chỉ số đã DUYỆT gần nhất, nên phát hành kỳ
 * sau khi kỳ trước còn nháp sẽ tính trùng phần của kỳ trước. Trigger CSDL chặn tương tự ở bước `issued`.
 */
async function assertEarlierPeriodsIssued(
  ctx: CommandContext,
  p: { id: string; property_id: string; period_start: string },
) {
  const r = await sql<{ period_start: string; status: string }>`
    select period_start::text, status from billing_periods
    where organization_id = ${ctx.actor.orgId} and property_id = ${p.property_id} and period_start < ${p.period_start}::date
      and status in ('draft','reviewing')
    order by period_start limit 1`.execute(ctx.trx);
  const e = r.rows[0];
  if (e) {
    throw new CommandError(
      "INVALID_TRANSITION",
      409,
      `Còn kỳ ${e.period_start.slice(0, 7)} chưa phát hành — phát hành theo thứ tự.`,
      {
        extensions: { items: [{ period_start: e.period_start, status: e.status }] },
      },
    );
  }
}

/** Hợp đồng được tính tiền mà thiếu chỉ số (vd dịch vụ theo công tơ nhưng phòng chưa lắp công tơ) ⇒ không duyệt/phát hành. */
function assertNoMissing(preview: Preview) {
  const items = preview.items.flatMap((i) =>
    i.missing.map((meter) => ({ unit: i.unit, meter, reason: "no_reading" })),
  );
  if (items.length > 0)
    throw new CommandError("READINGS_INCOMPLETE", 409, "Còn phòng chưa nhập chỉ số.", {
      extensions: { items },
    });
}

export async function submitForReview(
  ctx: CommandContext,
  input: { billingPeriodId: string },
): Promise<{ status: string; previewHash: string }> {
  const p = await lockedPeriod(ctx, input.billingPeriodId, "billing.prepare");
  billingPeriodMachine.assertTransition(p.status, "reviewing");
  await assertEarlierPeriodsIssued(ctx, p);
  const missing = await missingReadings(ctx.trx, ctx.actor.orgId, p.id);
  if (missing.length > 0) {
    throw new CommandError("READINGS_INCOMPLETE", 409, "Còn phòng chưa nhập chỉ số.", {
      extensions: { items: missing },
    });
  }
  const anomalies = await unresolvedAnomalies(ctx.trx, ctx.actor.orgId, p.id);
  if (anomalies.length > 0) {
    throw new CommandError("UNRESOLVED_ANOMALIES", 409, "Còn chỉ số bất thường chưa kiểm tra.", {
      extensions: { items: anomalies },
    });
  }
  const preview = await buildPreview(ctx.trx, ctx.actor.orgId, p.id);
  assertNoMissing(preview);
  await sql`update billing_periods set status = 'reviewing', preview_hash = ${preview.preview_hash}
            where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "billing.submitted",
    entityType: "billing_period",
    entityId: p.id,
    propertyId: p.property_id,
    after: { preview_hash: preview.preview_hash, total: preview.total },
  });
  return { status: "reviewing", previewHash: preview.preview_hash };
}

/** `billing.returnToDraft`: reviewing → draft để sửa chỉ số, có lý do. */
export async function returnToDraft(ctx: CommandContext, input: { billingPeriodId: string; reason: string }) {
  const p = await lockedPeriod(ctx, input.billingPeriodId, "billing.prepare");
  billingPeriodMachine.assertTransition(p.status, "draft");
  const reason = input.reason.trim();
  if (!reason) throw fieldError("reason", "REQUIRED", "Cần lý do trả về");
  await sql`update billing_periods set status = 'draft', preview_hash = null
            where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "billing.returned",
    entityType: "billing_period",
    entityId: p.id,
    propertyId: p.property_id,
    reason,
  });
  return { status: "draft" };
}

/**
 * `billing.issuePeriod` (S-002…S-004, S-015): reviewing → issued. Tính lại xem trước, hash khác ⇒ BILLING_PREVIEW_STALE,
 * không tạo phiếu nào. Mỗi hợp đồng có tiền: phiếu `periodic` + charges snapshot + dòng phiếu + bút toán Nợ AR / Có REV_*
 * ghi ngày cuối kỳ (kỳ đã khoá ⇒ PERIOD_LOCKED). Chỉ số kỳ được duyệt (khoá sửa).
 */
export async function issuePeriod(
  ctx: CommandContext,
  input: { billingPeriodId: string; previewHash: string },
): Promise<{ invoiceIds: string[]; journalEntryIds: string[]; total: number }> {
  const p = await lockedPeriod(ctx, input.billingPeriodId, "billing.issue");
  billingPeriodMachine.assertTransition(p.status, "issued");
  await assertEarlierPeriodsIssued(ctx, p);
  // Khoá chỉ số kỳ trước khi chụp số liệu: sửa chỉ số song song phải chờ rồi gặp PERIOD_ISSUED, không lọt giữa xem trước và
  // duyệt. Chỉ duyệt đúng các chỉ số đã khoá (chỉ số chèn sau không thuộc lần phát hành này).
  const locked = await sql<{ id: string }>`
    select id from meter_readings where organization_id = ${ctx.actor.orgId} and billing_period_id = ${p.id} and status = 'draft'
    order by id for update`.execute(ctx.trx);
  const readingIds = locked.rows.map((r) => r.id);
  const preview = await buildPreview(ctx.trx, ctx.actor.orgId, p.id);
  if (preview.preview_hash !== input.previewHash) {
    throw new CommandError(
      "BILLING_PREVIEW_STALE",
      409,
      "Số liệu đã thay đổi sau khi bạn xem trước. Hãy xem lại.",
    );
  }
  assertNoMissing(preview);
  const invoiceIds: string[] = [];
  const journalEntryIds: string[] = [];
  for (const item of preview.items) {
    if (item.total <= 0) continue;
    const invoiceId = randomUUID();
    const n = await sql<{
      n: string;
    }>`select app.next_number(${ctx.actor.orgId}, ${p.property_id}, 'invoice')::text as n`.execute(ctx.trx);
    const number = `PTT-${String(n.rows[0]?.n).padStart(6, "0")}`;
    let memo = generateMemoRef();
    for (let i = 0; i < 5; i++) {
      const used =
        await sql`select 1 from invoices where organization_id = ${ctx.actor.orgId} and memo_ref = ${memo}`.execute(
          ctx.trx,
        );
      if (used.rows.length === 0) break;
      memo = generateMemoRef();
    }
    await sql`
      insert into invoices (id, organization_id, property_id, kind, billing_period_id, lease_id, number, memo_ref, payer_person_id,
                            business_date, total, rounding_rule, formula_version, created_by, command_id)
      values (${invoiceId}, ${ctx.actor.orgId}, ${p.property_id}, 'periodic', ${p.id}, ${item.lease_id}, ${number}, ${memo},
              ${item.payer_person_id}, ${p.period_end}::date, ${item.total}, ${item.lines[0]?.roundingRule ?? "HALF_UP_1"},
              ${item.lines[0]?.formulaVersion ?? 1}, ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
      ctx.trx,
    );
    const credits: {
      account: RevenueAccount;
      debit: 0;
      credit: number;
      invoiceId: string;
      invoiceLineId: string;
    }[] = [];
    for (const [i, line] of item.lines.entries()) {
      const chargeId = randomUUID();
      const lineId = randomUUID();
      await sql`
        insert into charges (id, organization_id, property_id, source_type, billing_period_id, lease_id, lease_version_id, service_id,
                             kind, revenue_account, description, business_date, period_from, period_to, quantity, unit_price,
                             denominator, amount, rounding_rule, formula_version, reading_ids, created_by, command_id)
        values (${chargeId}, ${ctx.actor.orgId}, ${p.property_id}, 'billing_period', ${p.id}, ${item.lease_id},
                ${line.leaseVersionId ?? null}, ${line.serviceId ?? null}, ${line.kind}, ${line.revenueAccount},
                ${line.description}, ${p.period_end}::date, ${line.periodFrom}::date, ${line.periodTo}::date, ${line.quantity},
                ${line.unitPrice}, ${line.denominator ?? null}, ${line.amount}, ${line.roundingRule}, ${line.formulaVersion},
                ${line.readingIds ?? null}::uuid[], ${ctx.actor.membershipId}, ${ctx.commandId})`.execute(
        ctx.trx,
      );
      await sql`
        insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, charge_id, kind, description, revenue_account,
                                   quantity, unit_price, amount, rounding_rule, formula_version, lease_version_id, period_from, period_to)
        values (${lineId}, ${ctx.actor.orgId}, ${p.property_id}, ${invoiceId}, ${i + 1}, ${chargeId}, ${line.kind}, ${line.description},
                ${line.revenueAccount}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, ${line.roundingRule}, ${line.formulaVersion},
                ${line.leaseVersionId ?? null}, ${line.periodFrom}::date, ${line.periodTo}::date)`.execute(
        ctx.trx,
      );
      if (line.amount > 0) {
        credits.push({
          account: line.revenueAccount,
          debit: 0,
          credit: line.amount,
          invoiceId,
          invoiceLineId: lineId,
        });
      }
    }
    const entryId = await postEntry(ctx.trx, {
      orgId: ctx.actor.orgId,
      propertyId: p.property_id,
      entryType: "invoice_issued",
      businessDate: p.period_end,
      sourceDocType: "invoice",
      sourceDocId: invoiceId,
      createdBy: ctx.actor.membershipId,
      commandId: ctx.commandId,
      lines: [
        { account: "AR", debit: item.total, credit: 0, invoiceId, personId: item.payer_person_id },
        ...credits,
      ],
    });
    invoiceIds.push(invoiceId);
    journalEntryIds.push(entryId);
    await ctx.emit({
      eventType: "invoice.issued",
      aggregateType: "invoice",
      aggregateId: invoiceId,
      propertyId: p.property_id,
      payload: { invoice_id: invoiceId, lease_id: item.lease_id, total: item.total },
    });
  }
  const approved = await sql`
    update meter_readings set status = 'approved', approved_by = ${ctx.actor.membershipId}
    where organization_id = ${ctx.actor.orgId} and id = any(${readingIds}::uuid[]) and status = 'draft'`.execute(
    ctx.trx,
  );
  if (Number(approved.numAffectedRows ?? 0) !== readingIds.length) {
    throw new Error(`Duyệt chỉ số kỳ ${p.id}: ${approved.numAffectedRows}/${readingIds.length}`);
  }
  await sql`
    update billing_periods set status = 'issued', issued_at = now(), issued_by = ${ctx.actor.membershipId}
    where organization_id = ${ctx.actor.orgId} and id = ${p.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "billing.issued",
    entityType: "billing_period",
    entityId: p.id,
    propertyId: p.property_id,
    after: { invoices: invoiceIds.length, total: preview.total, preview_hash: preview.preview_hash },
  });
  return { invoiceIds, journalEntryIds, total: preview.total };
}

/** `billing.lockPeriod`: lớp bọc `ledger.lockPeriod` tới ngày cuối kỳ (một cơ chế khoá). */
export async function lockBillingPeriod(
  ctx: CommandContext,
  input: { billingPeriodId: string; reason: string },
) {
  const p = await readPeriod(ctx.trx, ctx.actor.orgId, input.billingPeriodId);
  if (p.status !== "issued") {
    throw new CommandError("INVALID_TRANSITION", 409, "Chỉ khoá kỳ đã phát hành", {
      extensions: { from: p.status, to: "locked" },
    });
  }
  return lockPeriod(ctx, { propertyId: p.property_id, lockedThrough: p.period_end, reason: input.reason });
}

/** `billing.reopenPeriod` (S-012): chỉ owner, có lý do; `locked → issued` qua `ledger.unlockPeriod` từ ngày đầu kỳ. */
export async function reopenPeriod(ctx: CommandContext, input: { billingPeriodId: string; reason: string }) {
  const p = await readPeriod(ctx.trx, ctx.actor.orgId, input.billingPeriodId);
  authorize(ctx.actor, "period.unlock", { propertyId: p.property_id });
  if (!input.reason.trim()) throw fieldError("reason", "REQUIRED", "Mở khoá kỳ cần lý do");
  if (p.status !== "locked") {
    throw new CommandError("INVALID_TRANSITION", 409, "Kỳ không ở trạng thái khoá", {
      extensions: { from: p.status, to: "issued" },
    });
  }
  return unlockPeriod(ctx, { propertyId: p.property_id, from: p.period_start, reason: input.reason });
}
