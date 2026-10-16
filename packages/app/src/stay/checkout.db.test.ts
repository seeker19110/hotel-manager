// PLAN đợt 3 T-209 — trả phòng trên Postgres thật (SPEC-reservation-stay S-017, S-019, S-020, S-023, S-024, S-026, S-027;
// INV-F1…F5, INV-F3b). Ví dụ bắt buộc: folio 1.430.000 đ, ứng trước 500.000 đ, còn 930.000 đ.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { decideApproval, requestApproval } from "../approvals/approvals.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { receiveDeposit } from "../deposits/deposits.ts";
import { allocatePayment, confirmPayment, recordPayment } from "../payments/payments.ts";
import { expectedCash, openShift } from "../shifts/shifts.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, ledgerBalance, seedHotel } from "../testing/hotel.ts";
import { checkOut } from "./checkout.ts";
import { getFolio, postCharge } from "./folio.ts";
import { confirmReservation, createReservation, holdReservation } from "./reservations.ts";
import { checkIn } from "./stays.ts";

let h: Hotel;
let L: Actor;
let L2: Actor;
let shiftL: string;
const pii = createPiiCipher(devKeyring());
const txn = () => ({ ref: `FT-${randomUUID().slice(0, 12)}`, occurredAt: "2026-10-16T03:00:00Z" });

beforeAll(async () => {
  h = await seedHotel();
  L = await seedMember(h.t, h.org, "front_desk", { name: "Lễ tân ca đêm L" });
  L2 = await seedMember(h.t, h.org, "front_desk", { name: "Lễ tân L2" });
  shiftL = (
    await okAs(h.t, L, (ctx) => openShift(ctx, { propertyId: h.org.propertyId, openingCash: 2_000_000 }))
  ).shiftId;
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
interface Made {
  stayId: string;
  reservationId: string;
  unitId: string;
  booker: string;
  depositId: string | null;
}

/** Lượt ở S-017: 20/10→22/10 (2 × 600.000), tuỳ chọn ứng trước 500.000 (S-005), cọc, minibar 80.000 + trả muộn 150.000. */
async function make(
  opts: { advance?: boolean; deposit?: number; extras?: boolean; damage?: number } = {},
): Promise<Made> {
  const unitId = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${unitId}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`5${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  const d = await okAs(h.t, h.manager, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      guests: 2,
      source: "direct",
      booker: { fullName: "Khách trả phòng", phone: "0933444555" },
    }),
  );
  await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  await okAs(h.t, h.manager, (ctx) =>
    confirmReservation(ctx, {
      reservationId: d.reservationId,
      ...(opts.advance
        ? {
            payment: {
              amount: 500_000,
              method: "bank_transfer" as const,
              kind: "advance" as const,
              receivingAccountId: h.receivingAccountId,
              bankTxn: txn(),
            },
          }
        : {}),
    }),
  );
  const booker = (
    await sql<{
      b: string;
    }>`select booker_person_id as b from reservations where id = ${d.reservationId}`.execute(h.t.admin)
  ).rows[0]?.b as string;
  let depositId: string | null = null;
  if (opts.deposit) {
    depositId = await okAs(h.t, h.manager, async (ctx) => {
      const dep = await receiveDeposit(ctx, {
        reservationId: d.reservationId,
        propertyId: h.org.propertyId,
        payerPersonId: booker,
        amount: opts.deposit as number,
        method: "bank_transfer",
        receivingAccountId: h.receivingAccountId,
        bankTxn: txn(),
      });
      await confirmPayment(ctx, { paymentId: dep.paymentId });
      return dep.depositId;
    });
  }
  const s = await okAs(h.t, h.frontDesk, (ctx) =>
    checkIn(ctx, pii, {
      reservationId: d.reservationId,
      guests: [
        { fullName: "Khách trả phòng", phone: "0933444555", docType: "cccd", docNumber: "001088776655" },
      ],
      now: new Date("2026-10-20T08:00:00Z"),
    }),
  );
  const at = new Date("2026-10-21T03:00:00Z");
  if (opts.extras) {
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind: "service",
        description: "Minibar",
        quantity: 1,
        unitPrice: 80_000,
        now: at,
      }),
    );
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind: "fee",
        description: "Phụ thu trả muộn",
        quantity: 1,
        unitPrice: 150_000,
        now: at,
      }),
    );
  }
  if (opts.damage) {
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind: "fee",
        description: "Phí hư hỏng",
        quantity: 1,
        unitPrice: opts.damage as number,
        now: at,
      }),
    );
  }
  return { stayId: s.stayId, reservationId: d.reservationId, unitId, booker, depositId };
}

/** Thanh toán đủ phòng (1.200.000) để folio không còn nợ — tiền mặt trong ca L. */
const PAY_ALL = (amount: number) => [{ method: "cash" as const, amount }];
const OUT = new Date("2026-10-22T03:30:00Z"); // 10:30 giờ VN ngày đi

const entryLines = async (invoiceId: string) =>
  (
    await sql<{ account: string; debit: string; credit: string }>`
      select jl.account, sum(jl.debit)::text as debit, sum(jl.credit)::text as credit
      from journal_lines jl join journal_entries je on je.id = jl.entry_id
      where je.source_doc_type = 'invoice' and je.source_doc_id = ${invoiceId} group by jl.account order by jl.account`.execute(
      h.t.admin,
    )
  ).rows;

describe("S-017 folio ví dụ bắt buộc khi trả phòng", () => {
  it("phát hành 1.430.000: Nợ AR / Có REV_ROOM 1.200.000, REV_SERVICE 80.000, REV_FEE 150.000; ứng trước 500.000 phân bổ; còn 930.000; cọc tách riêng", async () => {
    const m = await make({ advance: true, extras: true, deposit: 1_000_000 });
    const r = await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        allowBalance: { debtorPersonId: m.booker, dueDate: "2026-10-30" },
        now: OUT,
      }),
    );
    expect(r.total).toBe(1_430_000);
    expect(r.balance).toBe(930_000);
    expect(await entryLines(r.invoiceId)).toEqual([
      { account: "AR", debit: "1430000", credit: "0" },
      { account: "REV_FEE", debit: "0", credit: "150000" },
      { account: "REV_ROOM", debit: "0", credit: "1200000" },
      { account: "REV_SERVICE", debit: "0", credit: "80000" },
    ]);
    const alloc = await sql<{ debit: string; credit: string; account: string }>`
      select jl.account, jl.debit::text, jl.credit::text from journal_lines jl join journal_entries je on je.id = jl.entry_id
      where je.entry_type = 'payment_allocated' and jl.organization_id = ${h.org.orgId}
        and je.id in (select entry_id from payment_allocations where invoice_id = ${r.invoiceId}) order by jl.account`.execute(
      h.t.admin,
    );
    expect(alloc.rows).toEqual([
      { account: "AR", debit: "0", credit: "500000" },
      { account: "CUSTOMER_CREDIT", debit: "500000", credit: "0" },
    ]);
    const f = await getFolio(h.t.runtime, h.frontDesk, m.stayId);
    expect(f).toMatchObject({ balance: 930_000, deposit: { balance: 1_000_000 } });
  });
});

describe("S-019 trả phòng còn nợ cần quản lý cho phép", () => {
  it("lễ tân không thu đủ → 409 OUTSTANDING_BALANCE, không ghi gì; quản lý duyệt cho nợ → trả phòng, AR 930.000 gắn người nợ + hạn", async () => {
    const m = await make({ advance: true, extras: true });
    const invBefore = await sql<{
      n: number;
    }>`select count(*)::int as n from invoices where stay_id = ${m.stayId}`.execute(h.t.admin);
    expect(await codeOf(runAs(h.t, L, (ctx) => checkOut(ctx, { stayId: m.stayId, now: OUT })))).toBe(
      "OUTSTANDING_BALANCE",
    );
    const invAfter = await sql<{
      n: number;
    }>`select count(*)::int as n from invoices where stay_id = ${m.stayId}`.execute(h.t.admin);
    expect(invAfter.rows[0]?.n).toBe(invBefore.rows[0]?.n);
    // Không có yêu cầu duyệt hợp lệ → vẫn từ chối.
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) =>
          checkOut(ctx, {
            stayId: m.stayId,
            allowBalance: { debtorPersonId: m.booker, dueDate: "2026-10-30" },
            now: OUT,
          }),
        ),
      ),
    ).toBe("OUTSTANDING_BALANCE");
    const req = await okAs(h.t, L, (ctx) =>
      requestApproval(ctx, {
        kind: "allow_balance",
        amount: 930_000,
        reason: "Khách công tác, công ty thanh toán",
        propertyId: h.org.propertyId,
        subjectType: "stay",
        subjectId: m.stayId,
        payload: { debtor_person_id: m.booker, due_date: "2026-10-30" },
      }),
    );
    expect(
      await codeOf(
        runAs(h.t, L2, (ctx) =>
          decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
        ),
      ),
    ).toBe("FORBIDDEN");
    await okAs(h.t, h.manager, (ctx) =>
      decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
    );
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) =>
          checkOut(ctx, {
            stayId: m.stayId,
            allowBalance: { approvalRequestId: req.approvalRequestId, debtorPersonId: m.booker, dueDate: "" },
            now: OUT,
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    const r = await okAs(h.t, L, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        allowBalance: {
          approvalRequestId: req.approvalRequestId,
          debtorPersonId: m.booker,
          dueDate: "2026-10-30",
        },
        now: OUT,
      }),
    );
    expect(r.balance).toBe(930_000);
    const s = await sql<{ status: string; debtor_person_id: string; due: string }>`
      select status, debtor_person_id, debt_due_date::text as due from stays where id = ${m.stayId}`.execute(
      h.t.admin,
    );
    expect(s.rows[0]).toEqual({ status: "checked_out", debtor_person_id: m.booker, due: "2026-10-30" });
    expect(await ledgerBalance(h, "AR", m.booker)).toBeGreaterThanOrEqual(930_000);
  });
});

describe("S-020 trả phòng tạo việc dọn trong cùng quy trình", () => {
  it("trả sớm 10:30 → allocation kết thúc 10:30 (nhả phòng ngay); phòng dirty; 1 việc dọn open; checked_out_at UTC", async () => {
    const m = await make();
    await okAs(h.t, L, (ctx) => checkOut(ctx, { stayId: m.stayId, payments: PAY_ALL(1_200_000), now: OUT }));
    const a = await sql<{ hi: Date }>`
      select upper(a.during) as hi from allocations a join reservation_items i on i.allocation_id = a.id
      where i.reservation_id = ${m.reservationId}`.execute(h.t.admin);
    expect(a.rows[0]?.hi.toISOString()).toBe(OUT.toISOString());
    const u = await sql<{
      hs: string;
    }>`select housekeeping_status as hs from units where id = ${m.unitId}`.execute(h.t.admin);
    expect(u.rows[0]?.hs).toBe("dirty");
    const t = await sql<{ status: string; kind: string; source_id: string }>`
      select status, kind, source_id from tasks where unit_id = ${m.unitId}`.execute(h.t.admin);
    expect(t.rows).toEqual([{ status: "open", kind: "cleaning", source_id: m.stayId }]);
    const s = await sql<{ at: Date; r: string }>`
      select s.checked_out_at as at, r.status as r from stays s join reservation_items i on i.id = s.reservation_item_id
      join reservations r on r.id = i.reservation_id where s.id = ${m.stayId}`.execute(h.t.admin);
    expect(s.rows[0]?.at.toISOString()).toBe(OUT.toISOString());
    expect(s.rows[0]?.r).toBe("checked_out");
    // Phòng trống lại cho booking mới từ 22/10 14:00 (không chồng).
    expect(await codeOf(runAs(h.t, L, (ctx) => checkOut(ctx, { stayId: m.stayId, now: OUT })))).toBe(
      "INVALID_TRANSITION",
    );
  });
});

describe("S-023/S-024 bất biến sau phát hành", () => {
  it("sửa số tiền khoản đã lên phiếu → DOCUMENT_IMMUTABLE; phân bổ thêm từ khoản đã phân bổ hết → OVER_ALLOCATION", async () => {
    const m = await make({ advance: true });
    const r = await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        allowBalance: { debtorPersonId: m.booker, dueDate: "2026-10-30" },
        now: OUT,
      }),
    );
    const c = await sql<{ id: string }>`select id from charges where stay_id = ${m.stayId} limit 1`.execute(
      h.t.admin,
    );
    await expect(
      sql`update charges set amount = 1 where id = ${c.rows[0]?.id}`.execute(h.t.admin),
    ).rejects.toMatchObject({
      hint: "DOCUMENT_IMMUTABLE",
    });
    const pay = await sql<{
      id: string;
    }>`select id from payments where reservation_id = ${m.reservationId}`.execute(h.t.admin);
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          allocatePayment(ctx, {
            paymentId: pay.rows[0]?.id as string,
            allocations: [{ invoiceId: r.invoiceId, amount: 100_000 }],
          }),
        ),
      ),
    ).toBe("OVER_ALLOCATION");
  });
});

describe("S-026 trả phòng ca đêm, khách trả tiền mặt — lễ tân tự xác nhận", () => {
  it("23/10 00:40 (giờ chốt 04:00): một transaction thu 930.000 → folio 0, biên nhận, vào tiền mặt kỳ vọng ca L; ngày kinh doanh 22/10", async () => {
    const m = await make({ advance: true, extras: true });
    await sql`update properties set business_day_cutoff = '04:00' where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    try {
      const cashBefore = await withTenant(
        h.t.runtime,
        { orgId: h.org.orgId, actorId: L.membershipId },
        (trx) => expectedCash(trx, h.org.orgId, shiftL),
      );
      const night = new Date("2026-10-22T17:40:00Z");
      const key = randomUUID();
      const send = () =>
        runAs(h.t, L, (ctx) => checkOut(ctx, { stayId: m.stayId, payments: PAY_ALL(930_000), now: night }), {
          key,
          command: "stay.checkOut",
          payload: { stay_id: m.stayId, payments: [{ method: "cash", amount: 930_000 }] },
        });
      const first = await send();
      if (first.status !== "committed") throw new Error(first.problem.code);
      expect(first.data).toMatchObject({ total: 1_430_000, balance: 0 });
      expect(first.data.payments[0]).toMatchObject({ status: "confirmed" });
      expect(first.data.payments[0]?.receiptNo).toMatch(/^PT-/);
      // (d) gửi lại cùng key → cùng kết quả, một payment, một biên nhận.
      const again = await send();
      expect(again).toMatchObject({ status: "committed", replayed: true });
      const pays = await sql<{ n: number; d: string }>`
        select count(*)::int as n, max(business_date)::text as d from payments where reservation_id = ${m.reservationId} and method = 'cash'`.execute(
        h.t.admin,
      );
      expect(pays.rows[0]).toEqual({ n: 1, d: "2026-10-22" });
      const inv = await sql<{
        d: string;
      }>`select business_date::text as d from invoices where id = ${first.data.invoiceId}`.execute(h.t.admin);
      expect(inv.rows[0]?.d).toBe("2026-10-22");
      const cashAfter = await withTenant(
        h.t.runtime,
        { orgId: h.org.orgId, actorId: L.membershipId },
        (trx) => expectedCash(trx, h.org.orgId, shiftL),
      );
      expect(Number(cashAfter) - Number(cashBefore)).toBe(930_000);
    } finally {
      await sql`update properties set business_day_cutoff = '00:00' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });

  it("(a) lễ tân không có ca mở → 403, không payment/bút toán/trả phòng; (b) đưa 900.000 → OUTSTANDING_BALANCE", async () => {
    const m = await make({ advance: true, extras: true });
    const paysBefore = await sql<{
      n: number;
    }>`select count(*)::int as n from payments where organization_id = ${h.org.orgId}`.execute(h.t.admin);
    expect(
      await codeOf(
        runAs(h.t, L2, (ctx) => checkOut(ctx, { stayId: m.stayId, payments: PAY_ALL(930_000), now: OUT })),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) => checkOut(ctx, { stayId: m.stayId, payments: PAY_ALL(900_000), now: OUT })),
      ),
    ).toBe("OUTSTANDING_BALANCE");
    const paysAfter = await sql<{
      n: number;
    }>`select count(*)::int as n from payments where organization_id = ${h.org.orgId}`.execute(h.t.admin);
    expect(paysAfter.rows[0]?.n).toBe(paysBefore.rows[0]?.n);
    expect((await getFolio(h.t.runtime, L, m.stayId)).stayStatus).toBe("in_house");
  });

  it("(c) tiền do lễ tân khác nhận: L2 xác nhận khoản L ghi → 403", async () => {
    const m = await make();
    const { paymentId } = await okAs(h.t, L, (ctx) =>
      recordPayment(ctx, {
        propertyId: h.org.propertyId,
        method: "cash",
        amount: 50_000,
        payerPersonId: m.booker,
        reservationId: m.reservationId,
      }),
    );
    expect(await codeOf(runAs(h.t, L2, (ctx) => confirmPayment(ctx, { paymentId })))).toBe("FORBIDDEN");
  });
});

describe("S-027 hoàn/khấu trừ cọc lúc trả phòng", () => {
  it("(a) cọc 1.000.000, folio đã thu đủ: L hoàn tiền mặt trong hạn mức → Nợ DEPOSIT_LIAB / Có CASH ca L, cọc 0, không REV_*", async () => {
    const m = await make({ deposit: 1_000_000 });
    const before = await withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: L.membershipId }, (trx) =>
      expectedCash(trx, h.org.orgId, shiftL),
    );
    const r = await okAs(h.t, L, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        payments: PAY_ALL(1_200_000),
        depositRefund: { amount: 1_000_000, method: "cash" },
        now: OUT,
      }),
    );
    expect(r.depositRefundStatus).toBe("done");
    const d = await sql<{
      b: string;
    }>`select balance::text as b from deposits where id = ${m.depositId}`.execute(h.t.admin);
    expect(d.rows[0]?.b).toBe("0");
    const after = await withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: L.membershipId }, (trx) =>
      expectedCash(trx, h.org.orgId, shiftL),
    );
    expect(Number(after) - Number(before)).toBe(1_200_000 - 1_000_000);
    const rev = await sql<{ n: number }>`
      select count(*)::int as n from journal_lines jl join journal_entries je on je.id = jl.entry_id
      where je.entry_type = 'deposit_refunded' and je.source_doc_id = ${m.depositId} and jl.account like 'REV_%'`.execute(
      h.t.admin,
    );
    expect(rev.rows[0]?.n).toBe(0);
  });

  it("(b) cọc 3.000.000 vượt hạn mức lễ tân → vẫn trả phòng, yêu cầu duyệt pending, cọc giữ nguyên; L2 duyệt → vượt hạn mức; L tự duyệt → cấm; quản lý duyệt → hoàn", async () => {
    const m = await make({ deposit: 3_000_000 });
    const r = await okAs(h.t, L, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        payments: PAY_ALL(1_200_000),
        depositRefund: {
          amount: 3_000_000,
          method: "bank_transfer",
          receivingAccountId: h.receivingAccountId,
        },
        now: OUT,
      }),
    );
    expect(r.depositRefundStatus).toBe("pending_approval");
    const ap = r.depositRefundApprovalId as string;
    const bal = async () =>
      (
        await sql<{ b: string }>`select balance::text as b from deposits where id = ${m.depositId}`.execute(
          h.t.admin,
        )
      ).rows[0]?.b;
    expect(await bal()).toBe("3000000");
    expect(
      await codeOf(
        runAs(h.t, L2, (ctx) => decideApproval(ctx, { approvalRequestId: ap, decision: "approve" })),
      ),
    ).toBe("APPROVAL_LIMIT_EXCEEDED");
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) => decideApproval(ctx, { approvalRequestId: ap, decision: "approve" })),
      ),
    ).toBe("SELF_APPROVAL_FORBIDDEN");
    await okAs(h.t, h.manager, (ctx) => decideApproval(ctx, { approvalRequestId: ap, decision: "approve" }));
    expect(await bal()).toBe("0");
  });

  it("(c) cọc 1.000.000, nợ phí hư hỏng 200.000: khấu trừ cần người khác duyệt; L tự duyệt → 403; quản lý duyệt → folio 0, không REV từ cọc", async () => {
    const m = await make({ deposit: 1_000_000, damage: 200_000 });
    const r = await okAs(h.t, L, (ctx) =>
      checkOut(ctx, {
        stayId: m.stayId,
        payments: PAY_ALL(1_200_000),
        depositDeduction: { amount: 200_000, reason: "Vỡ cốc, hỏng rèm" },
        now: OUT,
      }),
    );
    expect(r.balance).toBe(200_000);
    const ap = r.deductionApprovalId as string;
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) => decideApproval(ctx, { approvalRequestId: ap, decision: "approve" })),
      ),
    ).toBe("SELF_APPROVAL_FORBIDDEN");
    await okAs(h.t, h.manager, (ctx) => decideApproval(ctx, { approvalRequestId: ap, decision: "approve" }));
    const inv = await sql<{
      open: string;
    }>`select open_amount::text as open from invoices where id = ${r.invoiceId}`.execute(h.t.admin);
    expect(inv.rows[0]?.open).toBe("0");
    const d = await sql<{
      b: string;
    }>`select balance::text as b from deposits where id = ${m.depositId}`.execute(h.t.admin);
    expect(d.rows[0]?.b).toBe("800000");
  });

  it("hoàn cọc khi folio còn nợ → OUTSTANDING_BALANCE; hoàn vượt số cọc → REFUND_EXCEEDS_BALANCE", async () => {
    const m = await make({ deposit: 500_000 });
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) =>
          checkOut(ctx, {
            stayId: m.stayId,
            depositRefund: { amount: 500_000, method: "cash" },
            payments: PAY_ALL(1_000_000),
            now: OUT,
          }),
        ),
      ),
    ).toBe("OUTSTANDING_BALANCE");
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) =>
          checkOut(ctx, {
            stayId: m.stayId,
            depositRefund: { amount: 600_000, method: "cash" },
            payments: PAY_ALL(1_200_000),
            now: OUT,
          }),
        ),
      ),
    ).toBe("REFUND_EXCEEDS_BALANCE");
  });
});

describe("quyền", () => {
  it("buồng phòng/tổ chức khác trả phòng → 404", async () => {
    const m = await make();
    expect(
      await codeOf(runAs(h.t, h.housekeeping, (ctx) => checkOut(ctx, { stayId: m.stayId, now: OUT }))),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(runAs(h.t, h.ownerOther, (ctx) => checkOut(ctx, { stayId: m.stayId, now: OUT }))),
    ).toBe("NOT_FOUND");
  });
});
