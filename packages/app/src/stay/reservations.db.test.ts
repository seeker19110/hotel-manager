// PLAN đợt 3 T-205 — booking trên Postgres thật (SPEC-reservation-stay S-003…S-011, S-025; INV-I1, INV-I3, INV-F3, INV-F4b, INV-F5).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { openShift } from "../shifts/shifts.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, ledgerBalance, seedHotel } from "../testing/hotel.ts";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  getReservation,
  holdReservation,
  markNoShow,
} from "./reservations.ts";

let h: Hotel;

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

const booker = () => ({
  fullName: "Khách Giả",
  phone: `09${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
});

async function draft(
  actor: Actor = h.frontDesk,
  opts: { unit?: string; arrival?: string; departure?: string; guests?: number } = {},
) {
  return okAs(h.t, actor, (ctx) =>
    createReservation(ctx, {
      unitId: opts.unit ?? h.units.r201,
      arrivalDate: opts.arrival ?? "2026-10-20",
      departureDate: opts.departure ?? "2026-10-22",
      guests: opts.guests ?? 2,
      source: "direct",
      booker: booker(),
    }),
  );
}

async function held(actor: Actor = h.frontDesk, opts: Parameters<typeof draft>[1] = {}) {
  const d = await draft(actor, opts);
  const hold = await okAs(h.t, actor, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  return { ...d, ...hold };
}

const allocation = async (reservationId: string) =>
  (
    await sql<{
      kind: string;
      active: boolean;
      expires_at: Date | null;
      source_type: string;
      lo: Date;
      hi: Date;
    }>`
      select a.kind, a.active, a.expires_at, a.source_type, lower(a.during) as lo, upper(a.during) as hi
      from reservation_items i join allocations a on a.id = i.allocation_id where i.reservation_id = ${reservationId}`.execute(
      h.t.admin,
    )
  ).rows[0];

const statusOf = async (reservationId: string) =>
  (
    await sql<{ r: string; s: string | null }>`
      select r.status as r, s.status as s from reservations r
      join reservation_items i on i.reservation_id = r.id left join stays s on s.reservation_item_id = i.id
      where r.id = ${reservationId}`.execute(h.t.admin)
  ).rows[0];

let unitSeq = 0;
/** Phòng riêng cho từng test (không giẫm lịch của nhau). */
async function freshUnit(): Promise<string> {
  const id = randomUUID();
  unitSeq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`9${String(unitSeq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return id;
}

describe("S-003 tạo booking và giữ phòng có hạn", () => {
  it("draft → held; allocation hold [20/10 07:00Z, 22/10 05:00Z) có expires_at; giá từng đêm snapshot", async () => {
    const r = await held();
    expect(r.number).toMatch(/^R-\d+$/);
    expect(r.nightlyPrices).toEqual([
      { businessDate: "2026-10-20", amount: 600_000 },
      { businessDate: "2026-10-21", amount: 600_000 },
    ]);
    expect((await statusOf(r.reservationId))?.r).toBe("held");
    const a = await allocation(r.reservationId);
    expect(a).toMatchObject({ kind: "hold", active: true, source_type: "reservation_item" });
    expect(a?.lo.toISOString()).toBe("2026-10-20T07:00:00.000Z");
    expect(a?.hi.toISOString()).toBe("2026-10-22T05:00:00.000Z");
    expect(a?.expires_at).not.toBeNull();
  });

  it("S-014: tạo booking 3 khách với STD sức chứa 2 → 422 CAPACITY_EXCEEDED, không ghi gì", async () => {
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          createReservation(ctx, {
            unitId: h.units.r201,
            arrivalDate: "2026-10-20",
            departureDate: "2026-10-22",
            guests: 3,
            source: "direct",
            booker: booker(),
          }),
        ),
      ),
    ).toBe("CAPACITY_EXCEEDED");
  });

  it("người đặt thiếu SĐT → 422 VALIDATION_FAILED", async () => {
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          createReservation(ctx, {
            unitId: h.units.r201,
            arrivalDate: "2026-10-20",
            departureDate: "2026-10-22",
            guests: 1,
            source: "direct",
            booker: { fullName: "Không SĐT" },
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("S-004 hai lễ tân giữ cùng phòng cuối (R-004)", () => {
  it("song song: đúng một người được, người kia 409 ROOM_UNAVAILABLE kèm gợi ý phòng cùng loại; một allocation", async () => {
    const unit = await freshUnit();
    const a = await draft(h.frontDesk, { unit, arrival: "2026-11-02", departure: "2026-11-04" });
    const b = await draft(h.frontDesk2, { unit, arrival: "2026-11-03", departure: "2026-11-05" });
    const [ra, rb] = await Promise.all([
      runAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: a.reservationId })),
      runAs(h.t, h.frontDesk2, (ctx) => holdReservation(ctx, { reservationId: b.reservationId })),
    ]);
    const results = [ra, rb];
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    const lost = results.find((r) => r.status === "failed");
    if (lost?.status !== "failed") throw new Error("phải có một lệnh thua");
    expect(lost.problem.code).toBe("ROOM_UNAVAILABLE");
    expect((lost.problem.items ?? []).length).toBeGreaterThan(0);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from allocations where unit_id = ${unit} and active`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(1);
  });
});

describe("S-005/S-006 xác nhận kèm ứng trước", () => {
  it("S-005: quản lý xác nhận với sao kê 500.000 → confirmed, stay expected, allocation stay không hết hạn, Nợ BANK / Có CUSTOMER_CREDIT", async () => {
    const unit = await freshUnit();
    const r = await held(h.manager, { unit });
    const bankBefore = await ledgerBalance(h, "BANK");
    const res = await okAs(h.t, h.manager, (ctx) =>
      confirmReservation(ctx, {
        reservationId: r.reservationId,
        payment: {
          amount: 500_000,
          method: "bank_transfer",
          kind: "advance",
          receivingAccountId: h.receivingAccountId,
          bankTxn: { ref: `FT-${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-16T03:00:00Z" },
        },
      }),
    );
    expect(res.payment).toMatchObject({ status: "confirmed" });
    expect(await statusOf(r.reservationId)).toEqual({ r: "confirmed", s: "expected" });
    expect(await allocation(r.reservationId)).toMatchObject({
      kind: "stay",
      active: true,
      expires_at: null,
      source_type: "stay",
    });
    expect((await ledgerBalance(h, "BANK")) - bankBefore).toBe(500_000);
    const pay = await sql<{ status: string; reservation_id: string; bank_transaction_id: string | null }>`
      select status, reservation_id, bank_transaction_id from payments where id = ${res.payment?.paymentId}`.execute(
      h.t.admin,
    );
    expect(pay.rows[0]).toMatchObject({ status: "confirmed", reservation_id: r.reservationId });
    expect(pay.rows[0]?.bank_transaction_id).not.toBeNull();
  });

  it("S-006: chuyển khoản không chứng cứ → payments pending, không bút toán BANK; booking vẫn confirmed (Q-05 cho phép)", async () => {
    const unit = await freshUnit();
    const r = await held(h.frontDesk, { unit });
    const bankBefore = await ledgerBalance(h, "BANK");
    const res = await okAs(h.t, h.frontDesk, (ctx) =>
      confirmReservation(ctx, {
        reservationId: r.reservationId,
        payment: {
          amount: 500_000,
          method: "bank_transfer",
          kind: "advance",
          receivingAccountId: h.receivingAccountId,
        },
      }),
    );
    expect(res.payment?.status).toBe("pending");
    expect(await ledgerBalance(h, "BANK")).toBe(bankBefore);
  });

  it("lễ tân có sao kê nhưng không có quyền xác nhận chuyển khoản → vẫn pending chờ người có quyền (INV-F3)", async () => {
    const unit = await freshUnit();
    const r = await held(h.frontDesk, { unit });
    const res = await okAs(h.t, h.frontDesk, (ctx) =>
      confirmReservation(ctx, {
        reservationId: r.reservationId,
        payment: {
          amount: 300_000,
          method: "bank_transfer",
          kind: "advance",
          receivingAccountId: h.receivingAccountId,
          bankTxn: { ref: `FT-${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-16T03:00:00Z" },
        },
      }),
    );
    expect(res.payment?.status).toBe("pending");
  });

  it("cọc bảo đảm tiền mặt trong ca mở của lễ tân → Nợ CASH / Có DEPOSIT_LIAB, cọc gắn booking", async () => {
    const L = await seedMember(h.t, h.org, "front_desk", { name: "Lễ tân ca" });
    await okAs(h.t, L, (ctx) => openShift(ctx, { propertyId: h.org.propertyId, openingCash: 0 }));
    const unit = await freshUnit();
    const r = await held(L, { unit });
    const before = await ledgerBalance(h, "DEPOSIT_LIAB");
    const res = await okAs(h.t, L, (ctx) =>
      confirmReservation(ctx, {
        reservationId: r.reservationId,
        payment: { amount: 1_000_000, method: "cash", kind: "security_deposit" },
      }),
    );
    expect(res.payment).toMatchObject({ status: "confirmed" });
    expect(res.payment?.receiptNo).toMatch(/^PT-/);
    expect((await ledgerBalance(h, "DEPOSIT_LIAB")) - before).toBe(-1_000_000);
    const d = await sql<{ reservation_id: string; balance: string }>`
      select reservation_id, balance::text from deposits where id = ${res.payment?.depositId}`.execute(
      h.t.admin,
    );
    expect(d.rows[0]).toEqual({ reservation_id: r.reservationId, balance: "1000000" });
  });
});

describe("S-007 xác nhận khi hold đã hết hạn", () => {
  it("409 HOLD_EXPIRED; booking held → expired đúng một lần; phòng nhả; xác nhận lại → INVALID_TRANSITION", async () => {
    const unit = await freshUnit();
    const r = await held(h.frontDesk, { unit });
    const late = new Date(r.expiresAt.getTime() + 60_000);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          confirmReservation(ctx, { reservationId: r.reservationId, now: late }),
        ),
      ),
    ).toBe("HOLD_EXPIRED");
    expect((await statusOf(r.reservationId))?.r).toBe("expired");
    expect((await allocation(r.reservationId))?.active).toBe(false);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          confirmReservation(ctx, { reservationId: r.reservationId, now: late }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    // Phòng trống lại: người khác giữ được.
    await held(h.frontDesk2, { unit });
  });
});

describe("S-009 huỷ booking", () => {
  it("nhả phòng, stay cancelled, ứng trước vẫn ở CUSTOMER_CREDIT, không có bút toán REV_*", async () => {
    const unit = await freshUnit();
    const r = await held(h.manager, { unit });
    await okAs(h.t, h.manager, (ctx) =>
      confirmReservation(ctx, {
        reservationId: r.reservationId,
        payment: {
          amount: 500_000,
          method: "bank_transfer",
          kind: "advance",
          receivingAccountId: h.receivingAccountId,
          bankTxn: { ref: `FT-${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-16T03:00:00Z" },
        },
      }),
    );
    const bookerId = (
      await sql<{
        b: string;
      }>`select booker_person_id as b from reservations where id = ${r.reservationId}`.execute(h.t.admin)
    ).rows[0]?.b as string;
    const revBefore = await sql<{ n: number }>`
      select count(*)::int as n from journal_lines where organization_id = ${h.org.orgId} and account like 'REV_%'`.execute(
      h.t.admin,
    );
    await okAs(h.t, h.frontDesk, (ctx) =>
      cancelReservation(ctx, { reservationId: r.reservationId, reason: "Khách đổi kế hoạch" }),
    );
    expect(await statusOf(r.reservationId)).toEqual({ r: "cancelled", s: "cancelled" });
    expect((await allocation(r.reservationId))?.active).toBe(false);
    expect(await ledgerBalance(h, "CUSTOMER_CREDIT", bookerId)).toBe(-500_000);
    const revAfter = await sql<{ n: number }>`
      select count(*)::int as n from journal_lines where organization_id = ${h.org.orgId} and account like 'REV_%'`.execute(
      h.t.admin,
    );
    expect(revAfter.rows[0]?.n).toBe(revBefore.rows[0]?.n);
  });

  it("phí huỷ > 0: trong hạn mức → phiếu phí (Nợ AR / Có REV_FEE); vượt hạn mức → 403 APPROVAL_LIMIT_EXCEEDED", async () => {
    const L = await seedMember(h.t, h.org, "front_desk", { limits: { price_override: 200_000 } });
    const mk = async () => {
      const unit = await freshUnit();
      const r = await held(L, { unit });
      await okAs(h.t, L, (ctx) => confirmReservation(ctx, { reservationId: r.reservationId }));
      return r;
    };
    const over = await mk();
    expect(
      await codeOf(
        runAs(h.t, L, (ctx) =>
          cancelReservation(ctx, {
            reservationId: over.reservationId,
            reason: "Huỷ sát ngày",
            cancellationFee: 300_000,
          }),
        ),
      ),
    ).toBe("APPROVAL_LIMIT_EXCEEDED");
    expect((await statusOf(over.reservationId))?.r).toBe("confirmed");
    const ok = await mk();
    const res = await okAs(h.t, L, (ctx) =>
      cancelReservation(ctx, {
        reservationId: ok.reservationId,
        reason: "Huỷ sát ngày",
        cancellationFee: 150_000,
      }),
    );
    const inv = await sql<{
      total: string;
      kind: string;
    }>`select total::text, kind from invoices where id = ${res.feeInvoiceId}`.execute(h.t.admin);
    expect(inv.rows[0]).toEqual({ total: "150000", kind: "fee" });
    const rev = await sql<{ c: string }>`
      select coalesce(sum(credit), 0)::text as c from journal_lines where invoice_id = ${res.feeInvoiceId} and account = 'REV_FEE'`.execute(
      h.t.admin,
    );
    expect(rev.rows[0]?.c).toBe("150000");
  });

  it("phí huỷ khi chưa xác nhận → 422", async () => {
    const r = await held(h.frontDesk, { unit: await freshUnit() });
    expect(
      await codeOf(
        runAs(h.t, h.owner, (ctx) =>
          cancelReservation(ctx, { reservationId: r.reservationId, reason: "x", cancellationFee: 1 }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("S-010 chuyển trạng thái không hợp lệ", () => {
  it("huỷ lần hai → 409 INVALID_TRANSITION, có audit ghi lần từ chối; CSDL chặn chuyển ngoài bảng", async () => {
    const r = await draft(h.frontDesk, { unit: await freshUnit() });
    await okAs(h.t, h.frontDesk, (ctx) =>
      cancelReservation(ctx, { reservationId: r.reservationId, reason: "Nhầm" }),
    );
    const key = randomUUID();
    const res = await runAs(
      h.t,
      h.frontDesk,
      (ctx) => cancelReservation(ctx, { reservationId: r.reservationId, reason: "Lại" }),
      {
        key,
      },
    );
    expect(res).toMatchObject({ status: "failed", httpStatus: 409 });
    const denied = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where command_id = ${key} and outcome = 'denied'`.execute(
      h.t.admin,
    );
    expect(denied.rows[0]?.n).toBe(1);
    await expect(
      sql`update reservations set status = 'held' where id = ${r.reservationId}`.execute(h.t.admin),
    ).rejects.toThrow(/không chuyển/);
  });
});

describe("S-011 no-show", () => {
  it("chưa qua ngày đến → 409; sau giờ chốt ngày đến → booking + stay no_show, phòng nhả, tiền giữ nguyên", async () => {
    const unit = await freshUnit();
    const r = await held(h.frontDesk, { unit });
    await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: r.reservationId }));
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          markNoShow(ctx, {
            reservationId: r.reservationId,
            reason: "Không đến",
            now: new Date("2026-10-20T11:00:00Z"),
          }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    await okAs(h.t, h.frontDesk, (ctx) =>
      markNoShow(ctx, {
        reservationId: r.reservationId,
        reason: "Không đến",
        now: new Date("2026-10-21T01:00:00Z"),
      }),
    );
    expect(await statusOf(r.reservationId)).toEqual({ r: "no_show", s: "no_show" });
    expect((await allocation(r.reservationId))?.active).toBe(false);
  });

  it("no-show booking chưa xác nhận → INVALID_TRANSITION", async () => {
    const r = await held(h.frontDesk, { unit: await freshUnit() });
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          markNoShow(ctx, {
            reservationId: r.reservationId,
            reason: "x",
            now: new Date("2026-10-25T01:00:00Z"),
          }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });
});

describe("khung nhìn booking cho UI (T-223)", () => {
  it("heldUntil chỉ có khi `held` (khớp hạn giữ), null ở draft/confirmed; bookerName là họ tên, không SĐT", async () => {
    const d = await draft(h.frontDesk, {
      unit: h.units.r202,
      arrival: "2027-06-10",
      departure: "2027-06-12",
    });
    expect(await getReservation(h.t.runtime, h.frontDesk, d.reservationId)).toMatchObject({
      status: "draft",
      heldUntil: null,
      bookerName: "Khách Giả",
    });
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      holdReservation(ctx, { reservationId: d.reservationId }),
    );
    const v = await getReservation(h.t.runtime, h.frontDesk, d.reservationId);
    expect(v.status).toBe("held");
    expect(v.heldUntil?.getTime()).toBe(hold.expiresAt.getTime());
    expect(Object.keys(v)).not.toContain("phone");
    await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
    expect((await getReservation(h.t.runtime, h.frontDesk, d.reservationId)).heldUntil).toBeNull();
  });
});

describe("S-025 quyền và tenant", () => {
  it("buồng phòng, tổ chức khác → 404; buồng phòng giữ phòng → 403/404; RLS: buồng phòng không đọc hàng booking", async () => {
    const r = await draft();
    await expect(getReservation(h.t.runtime, h.housekeeping, r.reservationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getReservation(h.t.runtime, h.ownerOther, r.reservationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await getReservation(h.t.runtime, h.accountant, r.reservationId)).roomTotal).toBe(1_200_000);
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) => holdReservation(ctx, { reservationId: r.reservationId })),
      ),
    );
    const { withTenant } = await import("@hm/db");
    const n = await withTenant(
      h.t.runtime,
      { orgId: h.org.orgId, actorId: h.housekeeping.membershipId },
      (trx) => sql<{ n: number }>`select count(*)::int as n from reservations`.execute(trx),
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});
