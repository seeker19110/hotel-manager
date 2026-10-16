// PLAN đợt 3 T-208 — folio và dịch vụ trên Postgres thật (SPEC-reservation-stay S-017 phần folio, S-018, S-022, S-025; INV-F5, INV-F6).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { getFolio, postCharge, voidCharge } from "./folio.ts";
import { confirmReservation, createReservation, holdReservation } from "./reservations.ts";
import { checkIn } from "./stays.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
/** Lượt ở 20/10→22/10 (2 × 600.000) đang ở; tuỳ chọn ứng trước 500.000 đã xác nhận (S-005) và cọc 1.000.000. */
async function inHouse(opts: { advance?: boolean; deposit?: boolean } = {}) {
  const unit = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${unit}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`6${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  const d = await okAs(h.t, h.manager, (ctx) =>
    createReservation(ctx, {
      unitId: unit,
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      guests: 2,
      source: "direct",
      booker: { fullName: "Khách folio", phone: "0911222333" },
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
              bankTxn: { ref: `FT-${randomUUID().slice(0, 10)}`, occurredAt: "2026-10-16T03:00:00Z" },
            },
          }
        : {}),
    }),
  );
  if (opts.deposit) {
    const { receiveDeposit } = await import("../deposits/deposits.ts");
    const { confirmPayment } = await import("../payments/payments.ts");
    const booker = (
      await sql<{
        b: string;
      }>`select booker_person_id as b from reservations where id = ${d.reservationId}`.execute(h.t.admin)
    ).rows[0]?.b as string;
    await okAs(h.t, h.manager, async (ctx) => {
      const dep = await receiveDeposit(ctx, {
        reservationId: d.reservationId,
        propertyId: h.org.propertyId,
        payerPersonId: booker,
        amount: 1_000_000,
        method: "bank_transfer",
        receivingAccountId: h.receivingAccountId,
        bankTxn: { ref: `FT-${randomUUID().slice(0, 10)}`, occurredAt: "2026-10-16T03:00:00Z" },
      });
      return confirmPayment(ctx, { paymentId: dep.paymentId });
    });
  }
  const s = await okAs(h.t, h.frontDesk, (ctx) =>
    checkIn(ctx, pii, {
      reservationId: d.reservationId,
      guests: [{ fullName: "Khách folio", phone: "0911222333", docType: "cccd", docNumber: "001099887766" }],
      now: new Date("2026-10-20T08:00:00Z"),
    }),
  );
  return s.stayId;
}

const AT = new Date("2026-10-21T03:00:00Z");

describe("S-017 folio ví dụ bắt buộc (trước check-out)", () => {
  it("2 × 600.000 + minibar 80.000 + trả muộn 150.000 = 1.430.000; ứng trước 500.000 → còn 930.000; cọc hiển thị riêng", async () => {
    const stayId = await inHouse({ advance: true, deposit: true });
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId,
        kind: "service",
        description: "Minibar",
        quantity: 1,
        unitPrice: 80_000,
        now: AT,
      }),
    );
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId,
        kind: "fee",
        description: "Phụ thu trả muộn",
        quantity: 1,
        unitPrice: 150_000,
        now: AT,
      }),
    );
    const f = await getFolio(h.t.runtime, h.frontDesk, stayId);
    expect(f.chargesTotal).toBe(1_430_000);
    expect(f.paidTotal).toBe(500_000);
    expect(f.balance).toBe(930_000);
    expect(f.deposit).toMatchObject({ amount: 1_000_000, balance: 1_000_000 });
    expect(f.charges.map((c) => [c.kind, c.amount])).toEqual([
      ["room", 600_000],
      ["room", 600_000],
      ["service", 80_000],
      ["fee", 150_000],
    ]);
  });
});

describe("S-018 không ghi dịch vụ hai lần", () => {
  it("cùng Idempotency-Key 2 lần → 1 khoản; cùng key khác số tiền → 409 IDEMPOTENCY_CONFLICT; key khác = khoản mới, huỷ có lý do", async () => {
    const stayId = await inHouse();
    const key = randomUUID();
    const send = (unitPrice: number) =>
      runAs(
        h.t,
        h.frontDesk,
        (ctx) =>
          postCharge(ctx, {
            stayId,
            kind: "service",
            description: "Minibar",
            quantity: 1,
            unitPrice,
            now: AT,
          }),
        {
          key,
          command: "stay.postCharge",
          payload: { stay_id: stayId, unit_price: unitPrice },
        },
      );
    const a = await send(80_000);
    const b = await send(80_000);
    expect(a.status).toBe("committed");
    expect(b).toMatchObject({ status: "committed", replayed: true });
    await expect(send(90_000)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const second = await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId,
        kind: "service",
        description: "Minibar",
        quantity: 1,
        unitPrice: 80_000,
        now: AT,
      }),
    );
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from charges where stay_id = ${stayId} and kind = 'service'`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(2);
    await okAs(h.t, h.frontDesk, (ctx) => voidCharge(ctx, { chargeId: second.chargeId, reason: "Bấm nhầm" }));
    expect((await getFolio(h.t.runtime, h.frontDesk, stayId)).chargesTotal).toBe(1_280_000);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) => voidCharge(ctx, { chargeId: second.chargeId, reason: "Lại" })),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("không huỷ từng đêm tiền phòng (đổi qua đổi ngày) → 422; giảm giá vượt hạn mức → 403 APPROVAL_LIMIT_EXCEEDED", async () => {
    const stayId = await inHouse();
    const room = await sql<{
      id: string;
    }>`select id from charges where stay_id = ${stayId} and kind = 'room' limit 1`.execute(h.t.admin);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          voidCharge(ctx, { chargeId: room.rows[0]?.id as string, reason: "x" }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          postCharge(ctx, {
            stayId,
            kind: "discount",
            description: "Giảm giá",
            quantity: 1,
            unitPrice: 50_000,
            now: AT,
          }),
        ),
      ),
    ).toBe("APPROVAL_LIMIT_EXCEEDED");
    const L = await seedMember(h.t, h.org, "front_desk", { limits: { price_override: 100_000 } });
    const d = await okAs(h.t, L, (ctx) =>
      postCharge(ctx, {
        stayId,
        kind: "discount",
        description: "Giảm giá",
        quantity: 1,
        unitPrice: 50_000,
        now: AT,
      }),
    );
    expect(d.amount).toBe(-50_000);
    expect((await getFolio(h.t.runtime, h.frontDesk, stayId)).chargesTotal).toBe(1_150_000);
  });
});

describe("S-022 kỳ đã khoá (INV-F6)", () => {
  it("ghi/huỷ khoản có ngày kinh doanh trong kỳ khoá → 409 PERIOD_LOCKED", async () => {
    const stayId = await inHouse();
    const fee = await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId,
        kind: "fee",
        description: "Giặt ủi",
        quantity: 1,
        unitPrice: 30_000,
        now: AT,
      }),
    );
    const lockId = randomUUID();
    await sql`insert into period_locks (id, organization_id, property_id, locked_through, locked_by, reason)
              values (${lockId}, ${h.org.orgId}, ${h.org.propertyId}, '2026-10-21', ${h.org.ownerMembershipId}, 'chốt kỳ test')`.execute(
      h.t.admin,
    );
    try {
      expect(
        await codeOf(
          runAs(h.t, h.frontDesk, (ctx) =>
            postCharge(ctx, {
              stayId,
              kind: "service",
              description: "Minibar",
              quantity: 1,
              unitPrice: 80_000,
              now: AT,
            }),
          ),
        ),
      ).toBe("PERIOD_LOCKED");
      expect(
        await codeOf(
          runAs(h.t, h.frontDesk, (ctx) => voidCharge(ctx, { chargeId: fee.chargeId, reason: "x" })),
        ),
      ).toBe("PERIOD_LOCKED");
    } finally {
      await sql`update period_locks set released_at = now(), released_by = ${h.org.ownerMembershipId}, release_reason = 'mở test'
                where id = ${lockId}`.execute(h.t.admin);
    }
  });
});

describe("S-025 quyền và tenant", () => {
  it("buồng phòng xem folio → 404; tổ chức khác → 404; kế toán đọc được; buồng phòng ghi dịch vụ → 404 (RLS che lượt ở, không lộ tồn tại)", async () => {
    const stayId = await inHouse();
    await expect(getFolio(h.t.runtime, h.housekeeping, stayId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFolio(h.t.runtime, h.ownerOther, stayId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getFolio(h.t.runtime, h.accountant, stayId)).chargesTotal).toBe(1_200_000);
    expect(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) =>
          postCharge(ctx, { stayId, kind: "service", description: "x", quantity: 1, unitPrice: 1, now: AT }),
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});
