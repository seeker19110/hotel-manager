// PLAN đợt 3 T-221 — báo cáo trên Postgres thật (SPEC-audit-reporting S-009…S-012, S-019).
// Tiền đi qua command thật (ghi nhận → xác nhận → phân bổ; nhận cọc; hoàn cọc có duyệt) để số dư sổ phụ là thật.
import { randomUUID } from "node:crypto";
import { seedIssuedInvoice, seedLease } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "../approvals/approvals.ts";
import { receiveDeposit, requestDepositRefund } from "../deposits/deposits.ts";
import { allocatePayment, confirmPayment, recordPayment } from "../payments/payments.ts";
import { openShift } from "../shifts/shifts.ts";
import { okAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { collections, depositsHeld, occupancy, REPORT_MAX_DAYS, receivables } from "./reports.ts";

let h: Hotel;
let payer: string;
let invA: string;
let invB: string;
let depositId: string;
/** Ngày kinh doanh hôm nay (giờ VN, cơ sở giờ chốt 00:00) — lệnh tiền ghi theo giờ thật. */
const TODAY = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const bankTxn = () => ({ ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: new Date().toISOString() });

beforeAll(async () => {
  h = await seedHotel();
  payer = (await seedMember(h.t, h.org, "tenant", { name: "Người thuê An", properties: [] })).personId;
  const lease = await seedLease(h.t.admin, {
    orgId: h.org.orgId,
    propertyId: h.org.propertyId,
    representativePersonId: payer,
  });
  // Phiếu 101: 3.580.000, phát hành 10 ngày trước, hạn 5 ngày trước; folio 203: 930.000.
  const mk = async (amount: number, due: string) => {
    const inv = await seedIssuedInvoice(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      payerPersonId: payer,
      lines: [{ amount }],
      businessDate: addDays(TODAY, -10),
    });
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update invoices set due_on = ${due}::date where id = ${inv.invoiceId}`.execute(trx);
    });
    return inv.invoiceId;
  };
  invA = await mk(3_580_000, addDays(TODAY, -5));
  invB = await mk(930_000, TODAY);
  // Chuyển khoản 2.000.000 xác nhận + phân bổ vào phiếu 101.
  const p = await okAs(h.t, h.accountant, (ctx) =>
    recordPayment(ctx, {
      propertyId: h.org.propertyId,
      method: "bank_transfer",
      amount: 2_000_000,
      payerPersonId: payer,
      receivingAccountId: h.receivingAccountId,
      bankTxn: bankTxn(),
    }),
  );
  await okAs(h.t, h.accountant, (ctx) => confirmPayment(ctx, { paymentId: p.paymentId }));
  await okAs(h.t, h.accountant, (ctx) =>
    allocatePayment(ctx, { paymentId: p.paymentId, allocations: [{ invoiceId: invA, amount: 2_000_000 }] }),
  );
  // Tiền mặt 500.000 lễ tân nhận trong ca (xác nhận) — chưa phân bổ.
  await okAs(h.t, h.frontDesk, (ctx) => openShift(ctx, { propertyId: h.org.propertyId, openingCash: 0 }));
  const cash = await okAs(h.t, h.frontDesk, (ctx) =>
    recordPayment(ctx, {
      propertyId: h.org.propertyId,
      method: "cash",
      amount: 500_000,
      payerPersonId: payer,
    }),
  );
  await okAs(h.t, h.frontDesk, (ctx) => confirmPayment(ctx, { paymentId: cash.paymentId }));
  // Một khoản chuyển khoản pending 1.580.000 (không tính).
  await okAs(h.t, h.accountant, (ctx) =>
    recordPayment(ctx, {
      propertyId: h.org.propertyId,
      method: "bank_transfer",
      amount: 1_580_000,
      payerPersonId: payer,
      receivingAccountId: h.receivingAccountId,
      bankTxn: bankTxn(),
    }),
  );
  // Cọc 3.000.000 của hợp đồng.
  const d = await okAs(h.t, h.accountant, (ctx) =>
    receiveDeposit(ctx, {
      leaseId: lease.leaseId,
      propertyId: h.org.propertyId,
      payerPersonId: payer,
      amount: 3_000_000,
      method: "bank_transfer",
      receivingAccountId: h.receivingAccountId,
      bankTxn: bankTxn(),
    }),
  );
  await okAs(h.t, h.accountant, (ctx) => confirmPayment(ctx, { paymentId: d.paymentId }));
  depositId = d.depositId;
});

afterAll(async () => {
  await h?.t.drop();
});

describe("S-009 công nợ — tổng = chi tiết = số dư AR", () => {
  it("hôm nay: 101 còn 1.580.000 quá hạn 5 ngày, 203 còn 930.000; tổng 2.510.000 = AR; cọc không trừ", async () => {
    const r = await receivables(h.t.runtime, h.owner, {});
    const by = Object.fromEntries(r.rows.map((x) => [x.invoiceId, x]));
    expect(by[invA]).toMatchObject({ balance: 1_580_000, allocated: 2_000_000, daysOverdue: 5 });
    expect(by[invB]).toMatchObject({ balance: 930_000, daysOverdue: 0 });
    expect(r.total).toBe(2_510_000);
    expect(r.rows.reduce((s, x) => s + x.balance, 0)).toBe(r.total);
    expect(r).toMatchObject({ ledgerBalance: 2_510_000, matchesLedger: true });
  });

  it("chốt hôm qua: phân bổ hôm nay chưa tính → 4.510.000, vẫn khớp AR tại ngày đó", async () => {
    const r = await receivables(h.t.runtime, h.accountant, { asOf: addDays(TODAY, -1) });
    expect(r).toMatchObject({ total: 4_510_000, ledgerBalance: 4_510_000, matchesLedger: true });
    expect(r.rows.find((x) => x.invoiceId === invA)?.daysOverdue).toBe(4);
  });

  it("chốt trước ngày phát hành → rỗng, tổng 0", async () => {
    const r = await receivables(h.t.runtime, h.owner, { asOf: addDays(TODAY, -30) });
    expect(r).toMatchObject({ rows: [], total: 0, ledgerBalance: 0, matchesLedger: true });
  });
});

describe("S-010 tiền đã thu theo phương thức", () => {
  it("Chuyển khoản 5.000.000 (2.000.000 + cọc 3.000.000) · Tiền mặt 500.000 · pending không tính; ghi rõ không phải doanh thu", async () => {
    const r = await collections(h.t.runtime, h.manager, { from: addDays(TODAY, -6), to: TODAY });
    expect(r.note).toBe("Tiền đã thu — không phải doanh thu");
    expect(r.byMethod).toEqual([
      { method: "bank_transfer", label: "Chuyển khoản", amount: 5_000_000, count: 2 },
      { method: "cash", label: "Tiền mặt", amount: 500_000, count: 1 },
    ]);
    expect(r.total).toBe(5_500_000);
    expect(r.byDay.reduce((s, x) => s + x.amount, 0)).toBe(r.total);
    expect(r.byDay.find((x) => x.method === "cash")).toMatchObject({
      confirmedBy: "Lễ tân L",
      businessDate: TODAY,
    });
  });

  it("khoảng ngày không có thu → tổng 0; khoảng > 366 ngày → 422 REPORT_RANGE_TOO_LARGE; ngày sai → 422", async () => {
    const empty = await collections(h.t.runtime, h.owner, { from: "2026-01-01", to: "2026-01-31" });
    expect(empty).toMatchObject({ byMethod: [], total: 0 });
    await expect(
      collections(h.t.runtime, h.owner, { from: "2025-01-01", to: addDays("2025-01-01", REPORT_MAX_DAYS) }),
    ).rejects.toMatchObject({ code: "REPORT_RANGE_TOO_LARGE", status: 422 });
    expect(
      (
        await collections(h.t.runtime, h.owner, {
          from: "2025-01-01",
          to: addDays("2025-01-01", REPORT_MAX_DAYS - 1),
        })
      ).total,
    ).toBe(0);
    await expect(
      collections(h.t.runtime, h.owner, { from: "2026-02-30", to: "2026-03-01" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("S-011 cọc đang giữ = DEPOSIT_LIAB", () => {
  it("1 dòng 3.000.000 = sổ; hoàn 1.000.000 có duyệt → còn 2.000.000, vẫn khớp", async () => {
    const r = await depositsHeld(h.t.runtime, h.owner);
    expect(r.rows).toHaveLength(1);
    expect(r).toMatchObject({ total: 3_000_000, ledgerBalance: 3_000_000, matchesLedger: true });
    const req = await okAs(h.t, h.manager, (ctx) =>
      requestDepositRefund(ctx, {
        depositId,
        amount: 1_000_000,
        reason: "hoàn một phần",
        refund: { method: "bank_transfer", receivingAccountId: h.receivingAccountId },
      }),
    );
    await okAs(h.t, h.owner, (ctx) =>
      decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
    );
    const after = await depositsHeld(h.t.runtime, h.accountant);
    expect(after.rows[0]).toMatchObject({ balance: 2_000_000, refunded: 1_000_000 });
    expect(after).toMatchObject({ total: 2_000_000, ledgerBalance: 2_000_000, matchesLedger: true });
  });
});

describe("S-012 công suất cơ bản", () => {
  let hs3: string;
  beforeAll(async () => {
    hs3 = randomUUID();
    const floor = randomUUID();
    const type = randomUUID();
    const units: string[] = [];
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`insert into properties (id, organization_id, name, template) values (${hs3}, ${h.org.orgId}, 'HS3', 'hotel')`.execute(
        trx,
      );
      await sql`insert into floors (id, organization_id, property_id, name) values (${floor}, ${h.org.orgId}, ${hs3}, 'Tầng 1')`.execute(
        trx,
      );
      await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
                values (${type}, ${h.org.orgId}, ${hs3}, 'STD', 'Tiêu chuẩn', 2)`.execute(trx);
      for (let i = 0; i < 10; i++) {
        const u = randomUUID();
        units.push(u);
        await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
                  values (${u}, ${h.org.orgId}, ${hs3}, ${floor}, ${type}, ${`H${i}`})`.execute(trx);
      }
      // Bỏ qua trigger nguồn allocation (dữ liệu dựng cho báo cáo); khoảng phủ ngày 15/10 giờ VN.
      await sql`set local session_replication_role = replica`.execute(trx);
      const alloc = (unit: string, kind: string, extra = sql``) =>
        sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, active, deactivated_at, deactivated_reason)
            values (${randomUUID()}, ${h.org.orgId}, ${hs3}, ${unit}, ${kind},
                    tstzrange('2026-10-15T00:00:00+07', '2026-10-17T00:00:00+07', '[)'), ${extra})`.execute(
          trx,
        );
      for (let i = 0; i < 7; i++)
        await alloc(units[i] as string, i < 4 ? "lease" : "stay", sql`true, null, null`);
      await alloc(units[7] as string, "block", sql`true, null, null`);
      await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, active, expires_at)
                values (${randomUUID()}, ${h.org.orgId}, ${hs3}, ${units[8]}, 'hold',
                        tstzrange('2026-10-15T00:00:00+07', '2026-10-17T00:00:00+07', '[)'), true, '2026-10-16T00:00:00+07')`.execute(
        trx,
      );
      // Đã huỷ trước ngày đó (không còn hiệu lực lúc 23:59:59 ngày 15) → không tính.
      await alloc(units[9] as string, "stay", sql`false, '2026-10-14T00:00:00+07', 'cancelled'`);
    });
  });

  it("10 phòng: đang ở 7, khả dụng 9 (trừ block), hold không tính → 77,8%; ngày khác 0%; công thức ghi kèm", async () => {
    const r = await occupancy(h.t.runtime, h.owner, {
      from: "2026-10-14",
      to: "2026-10-15",
      propertyId: hs3,
    });
    expect(r.rows).toEqual([
      expect.objectContaining({
        date: "2026-10-14",
        units: 10,
        blocked: 0,
        available: 10,
        occupied: 0,
        rate: 0,
      }),
      expect.objectContaining({
        date: "2026-10-15",
        units: 10,
        blocked: 1,
        available: 9,
        occupied: 7,
        rate: 77.8,
      }),
    ]);
    expect(r.formula).toContain("phòng khả dụng");
  });

  it("quyền: buồng phòng/người thuê → 403; quản lý (chỉ HS1) xem HS3 → 404", async () => {
    const tenant = await seedMember(h.t, h.org, "tenant", { properties: [] });
    for (const a of [h.housekeeping, tenant]) {
      await expect(occupancy(h.t.runtime, a, { from: "2026-10-15", to: "2026-10-15" })).rejects.toMatchObject(
        {
          code: "FORBIDDEN",
        },
      );
      await expect(receivables(h.t.runtime, a)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      occupancy(h.t.runtime, h.manager, { from: "2026-10-15", to: "2026-10-15", propertyId: hs3 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(receivables(h.t.runtime, h.manager, { propertyId: hs3 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
