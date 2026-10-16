// Hồi quy review lát khách sạn (T-204…T-209): mỗi test tái hiện đúng đường lỗi reviewer chỉ ra, trên Postgres thật.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { decideApproval, requestApproval } from "../approvals/approvals.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { requestCreditRefund } from "../deposits/deposits.ts";
import { openShift } from "../shifts/shifts.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, ledgerBalance, seedHotel } from "../testing/hotel.ts";
import { checkOut } from "./checkout.ts";
import { getFolio, postCharge } from "./folio.ts";
import { cancelReservation, confirmReservation, createReservation, holdReservation } from "./reservations.ts";
import { checkIn, walkIn } from "./stays.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
const txn = () => ({ ref: `FT-${randomUUID().slice(0, 12)}`, occurredAt: "2026-10-16T03:00:00Z" });

beforeAll(async () => {
  h = await seedHotel();
  await okAs(h.t, h.frontDesk, (ctx) =>
    openShift(ctx, { propertyId: h.org.propertyId, openingCash: 1_000_000 }),
  );
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function unit(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`7${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return id;
}

/** Booking 20/10→`departure` (đêm thường 600.000), nhận phòng 20/10 15:00 giờ VN; tuỳ chọn ứng trước 500.000. */
async function stay(opts: { departure?: string; advance?: boolean; unitId?: string } = {}) {
  const unitId = opts.unitId ?? (await unit());
  const d = await okAs(h.t, h.manager, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: "2026-10-20",
      departureDate: opts.departure ?? "2026-10-23",
      guests: 1,
      source: "direct",
      booker: { fullName: "Khách hồi quy", phone: `09${String(10_000_000 + seq).slice(-8)}` },
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
  const s = await okAs(h.t, h.frontDesk, (ctx) =>
    checkIn(ctx, pii, {
      reservationId: d.reservationId,
      guests: [
        {
          fullName: "Khách hồi quy",
          phone: "0912000111",
          docType: "cccd",
          docNumber: `0010${String(seq).padStart(8, "0")}`,
        },
      ],
      now: new Date("2026-10-20T08:00:00Z"),
    }),
  );
  return { stayId: s.stayId, reservationId: d.reservationId, unitId, booker };
}

describe("R1 trả sớm không tính đêm chưa ở", () => {
  it("3 đêm, trả 21/10 10:00 → chỉ tính 20/10; đêm 21, 22 huỷ; bán lại phòng không ghi REV_ROOM hai lần", async () => {
    const s = await stay();
    const revBefore = await ledgerBalance(h, "REV_ROOM");
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        payments: [{ method: "cash", amount: 600_000 }],
        now: new Date("2026-10-21T03:00:00Z"),
      }),
    );
    expect(r).toMatchObject({ total: 600_000, balance: 0 });
    expect(revBefore - (await ledgerBalance(h, "REV_ROOM"))).toBe(600_000);
    const voided = await sql<{ d: string; reason: string }>`
      select business_date::text as d, void_reason as reason from charges
      where stay_id = ${s.stayId} and kind = 'room' and voided_at is not null order by business_date`.execute(
      h.t.admin,
    );
    expect(voided.rows.map((x) => x.d)).toEqual(["2026-10-21", "2026-10-22"]);
    // Phòng đã nhả → bán lại 21/10→23/10: tiền hai đêm này chỉ tính cho khách mới.
    await sql`update tasks set status = 'cancelled', cancel_reason = 'test' where unit_id = ${s.unitId}`.execute(
      h.t.admin,
    );
    await sql`update units set housekeeping_status = 'inspected' where id = ${s.unitId}`.execute(h.t.admin);
    const w = await okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: s.unitId,
        departureDate: "2026-10-23",
        guests: [{ fullName: "Khách mới", phone: "0977000111", docType: "cccd", docNumber: "001299887766" }],
        now: new Date("2026-10-21T08:00:00Z"),
      }),
    );
    const nights = await sql<{ d: string; n: number }>`
      select c.business_date::text as d, count(*)::int as n from charges c
      join stays st on st.id = c.stay_id
      where st.unit_id = ${s.unitId} and c.kind = 'room' and c.voided_at is null group by 1 order by 1`.execute(
      h.t.admin,
    );
    expect(nights.rows).toEqual([
      { d: "2026-10-20", n: 1 },
      { d: "2026-10-21", n: 1 },
      { d: "2026-10-22", n: 1 },
    ]);
    expect(w.stayId).not.toBe(s.stayId);
  });

  it("trả sau giờ nhận phòng của đêm kế (đã ở qua đêm) → đêm đó vẫn tính", async () => {
    const s = await stay();
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        payments: [{ method: "cash", amount: 1_200_000 }],
        // 22/10 02:00 giờ VN: đã ở đêm 21/10 (bắt đầu 21/10 14:00); đêm 22/10 chưa bắt đầu.
        now: new Date("2026-10-21T19:00:00Z"),
      }),
    );
    expect(r).toMatchObject({ total: 1_200_000, balance: 0 });
  });
});

describe("R2 ứng trước đã hoàn qua credit_refund", () => {
  it("folio tính số đã trả theo số dư thật; trả phòng thu đủ 600.000 → xong, không 409", async () => {
    const s = await stay({ departure: "2026-10-21", advance: true });
    const req = await okAs(h.t, h.manager, (ctx) =>
      requestCreditRefund(ctx, {
        personId: s.booker,
        propertyId: h.org.propertyId,
        amount: 500_000,
        reason: "Khách xin hoàn ứng trước",
        refund: { method: "bank_transfer", receivingAccountId: h.receivingAccountId },
      }),
    );
    await okAs(h.t, h.owner, (ctx) =>
      decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
    );
    const f = await getFolio(h.t.runtime, h.manager, s.stayId);
    expect(f).toMatchObject({ chargesTotal: 600_000, paidTotal: 0, balance: 600_000 });
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        payments: [{ method: "cash", amount: 600_000 }],
        now: new Date("2026-10-21T04:00:00Z"),
      }),
    );
    expect(r).toMatchObject({ total: 600_000, balance: 0 });
  });
});

describe("R3 folio 0 đồng", () => {
  it("giảm giá bằng tổng phí → trả phòng được, không lỗi 500; sổ cân", async () => {
    const s = await stay({ departure: "2026-10-21" });
    await okAs(h.t, h.owner, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind: "discount",
        description: "Tặng đêm",
        quantity: 1,
        unitPrice: 600_000,
        now: new Date("2026-10-20T10:00:00Z"),
      }),
    );
    const r = await okAs(h.t, h.owner, (ctx) =>
      checkOut(ctx, { stayId: s.stayId, now: new Date("2026-10-21T04:00:00Z") }),
    );
    expect(r).toMatchObject({ total: 0, balance: 0 });
    const ar = await sql<{ n: number }>`
      select count(*)::int as n from journal_lines where invoice_id = ${r.invoiceId} and account = 'AR'`.execute(
      h.t.admin,
    );
    expect(ar.rows[0]?.n).toBe(0);
  });
});

describe("R4 + R8 cho nợ: người nợ và hạn do người duyệt quyết", () => {
  it("yêu cầu thiếu người nợ/hạn → duyệt 422; lễ tân đổi người nợ/hạn → 409; đúng giá trị duyệt → trả phòng", async () => {
    const s = await stay({ departure: "2026-10-21" });
    const bad = await okAs(h.t, h.frontDesk, (ctx) =>
      requestApproval(ctx, {
        kind: "allow_balance",
        amount: 600_000,
        reason: "Công ty trả sau",
        propertyId: h.org.propertyId,
        subjectType: "stay",
        subjectId: s.stayId,
      }),
    );
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          decideApproval(ctx, { approvalRequestId: bad.approvalRequestId, decision: "approve" }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    const req = await okAs(h.t, h.frontDesk, (ctx) =>
      requestApproval(ctx, {
        kind: "allow_balance",
        amount: 600_000,
        reason: "Công ty trả sau",
        propertyId: h.org.propertyId,
        subjectType: "stay",
        subjectId: s.stayId,
        payload: { debtor_person_id: s.booker, due_date: "2026-10-31" },
      }),
    );
    await okAs(h.t, h.manager, (ctx) =>
      decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
    );
    const out = (allow: { debtorPersonId: string; dueDate: string }) =>
      runAs(h.t, h.frontDesk, (ctx) =>
        checkOut(ctx, {
          stayId: s.stayId,
          allowBalance: { approvalRequestId: req.approvalRequestId, ...allow },
          now: new Date("2026-10-21T04:00:00Z"),
        }),
      );
    expect(await codeOf(out({ debtorPersonId: h.manager.personId, dueDate: "2026-10-31" }))).toBe(
      "OUTSTANDING_BALANCE",
    );
    expect(await codeOf(out({ debtorPersonId: s.booker, dueDate: "2099-12-31" }))).toBe(
      "OUTSTANDING_BALANCE",
    );
    expect((await out({ debtorPersonId: s.booker, dueDate: "2026-10-31" })).status).toBe("committed");
    const st = await sql<{ debtor: string; due: string }>`
      select debtor_person_id as debtor, debt_due_date::text as due from stays where id = ${s.stayId}`.execute(
      h.t.admin,
    );
    expect(st.rows[0]).toEqual({ debtor: s.booker, due: "2026-10-31" });
  });

  it("quản lý cho nợ trực tiếp: không gắn yêu cầu duyệt của lượt ở khác; hạn trước ngày trả → 422", async () => {
    const a = await stay({ departure: "2026-10-21" });
    const other = await stay({ departure: "2026-10-21" });
    const req = await okAs(h.t, h.frontDesk, (ctx) =>
      requestApproval(ctx, {
        kind: "allow_balance",
        amount: 600_000,
        reason: "Trả sau",
        propertyId: h.org.propertyId,
        subjectType: "stay",
        subjectId: other.stayId,
        payload: { debtor_person_id: other.booker, due_date: "2026-10-31" },
      }),
    );
    await okAs(h.t, h.owner, (ctx) =>
      decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
    );
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          checkOut(ctx, {
            stayId: a.stayId,
            allowBalance: { debtorPersonId: a.booker, dueDate: "2026-10-01" },
            now: new Date("2026-10-21T04:00:00Z"),
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: a.stayId,
        allowBalance: {
          approvalRequestId: req.approvalRequestId,
          debtorPersonId: a.booker,
          dueDate: "2026-10-31",
        },
        now: new Date("2026-10-21T04:00:00Z"),
      }),
    );
    const st = await sql<{
      id: string | null;
    }>`select allow_balance_approval_id as id from stays where id = ${a.stayId}`.execute(h.t.admin);
    expect(st.rows[0]?.id).toBeNull();
    // Yêu cầu của lượt ở kia vẫn dùng được cho đúng lượt ở đó.
    const r = await runAs(h.t, h.frontDesk, (ctx) =>
      checkOut(ctx, {
        stayId: other.stayId,
        allowBalance: {
          approvalRequestId: req.approvalRequestId,
          debtorPersonId: other.booker,
          dueDate: "2026-10-31",
        },
        now: new Date("2026-10-21T04:00:00Z"),
      }),
    );
    expect(r.status).toBe("committed");
  });
});

describe("R5 cơ sở bắt buộc tiền khi xác nhận", () => {
  it("chuyển khoản chưa có chứng cứ → 422, booking vẫn held, không có payment", async () => {
    await sql`update properties set settings = settings || '{"confirm_without_payment": false}'::jsonb
              where id = ${h.org.propertyId}`.execute(h.t.admin);
    try {
      const d = await okAs(h.t, h.manager, async (ctx) =>
        createReservation(ctx, {
          unitId: await unit(),
          arrivalDate: "2026-11-01",
          departureDate: "2026-11-02",
          guests: 1,
          source: "direct",
          booker: { fullName: "Khách R5", phone: "0966000555" },
        }),
      );
      await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
      const r = await runAs(h.t, h.frontDesk, (ctx) =>
        confirmReservation(ctx, {
          reservationId: d.reservationId,
          payment: {
            amount: 1,
            method: "bank_transfer",
            kind: "advance",
            receivingAccountId: h.receivingAccountId,
          },
        }),
      );
      expect(r.status === "failed" && r.problem.code).toBe("VALIDATION_FAILED");
      const st = await sql<{ status: string; n: number }>`
        select r.status, (select count(*)::int from payments p where p.reservation_id = r.id) as n
        from reservations r where r.id = ${d.reservationId}`.execute(h.t.admin);
      expect(st.rows[0]).toEqual({ status: "held", n: 0 });
    } finally {
      await sql`update properties set settings = settings - 'confirm_without_payment' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("R6 quốc tịch đã lưu không bị ghi đè", () => {
  it("khách US đã có hồ sơ, nhận phòng không gửi quốc tịch → giữ US, thông báo lưu trú is_foreign", async () => {
    const u = await unit();
    const first = await okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: u,
        departureDate: "2026-10-21",
        guests: [
          {
            fullName: "Jane Roe",
            phone: "+15550001111",
            docType: "passport",
            docNumber: "P7654321",
            nationality: "US",
          },
        ],
        now: new Date("2026-10-20T08:00:00Z"),
      }),
    );
    const person = (
      await sql<{
        p: string;
      }>`select primary_guest_person_id as p from stays where id = ${first.stayId}`.execute(h.t.admin)
    ).rows[0]?.p as string;
    const again = await okAs(h.t, h.frontDesk, async (ctx) =>
      walkIn(ctx, pii, {
        unitId: await unit(),
        departureDate: "2026-10-22",
        guests: [{ personId: person, docType: "passport", docNumber: "P7654321" }],
        now: new Date("2026-10-21T08:00:00Z"),
      }),
    );
    const n = await sql<{ nationality: string; is_foreign: boolean }>`
      select p.nationality, rn.is_foreign from persons p, residence_notices rn
      where p.id = ${person} and rn.stay_id = ${again.stayId}`.execute(h.t.admin);
    expect(n.rows[0]).toEqual({ nationality: "US", is_foreign: true });
  });
});

describe("R7 vượt hạn mức → yêu cầu duyệt + executor", () => {
  let L: Actor;
  beforeAll(async () => {
    L = await seedMember(h.t, h.org, "front_desk", { limits: { price_override: 100_000 } });
  });

  it("giảm giá 150.000 > hạn mức → 403 kèm approval_request_id; owner duyệt → khoản giảm giá vào folio", async () => {
    const s = await stay({ departure: "2026-10-21" });
    const r = await runAs(h.t, L, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind: "discount",
        description: "Khách quen",
        quantity: 1,
        unitPrice: 150_000,
        now: new Date("2026-10-20T10:00:00Z"),
      }),
    );
    if (r.status !== "failed") throw new Error("phải bị chặn");
    expect(r.problem.code).toBe("APPROVAL_LIMIT_EXCEEDED");
    const id = (r.problem as { approval_request_id?: string }).approval_request_id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await okAs(h.t, h.owner, (ctx) => decideApproval(ctx, { approvalRequestId: id, decision: "approve" }));
    const f = await getFolio(h.t.runtime, h.manager, s.stayId);
    expect(f.chargesTotal).toBe(450_000);
  });

  it("phí huỷ 300.000 > hạn mức → yêu cầu duyệt; owner duyệt → booking huỷ kèm phiếu phí", async () => {
    const d = await okAs(h.t, h.manager, async (ctx) =>
      createReservation(ctx, {
        unitId: await unit(),
        arrivalDate: "2026-11-05",
        departureDate: "2026-11-06",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách huỷ", phone: "0966000777" },
      }),
    );
    await okAs(h.t, L, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    await okAs(h.t, L, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
    const r = await runAs(h.t, L, (ctx) =>
      cancelReservation(ctx, {
        reservationId: d.reservationId,
        reason: "Huỷ sát ngày",
        cancellationFee: 300_000,
      }),
    );
    if (r.status !== "failed") throw new Error("phải bị chặn");
    const id = (r.problem as { approval_request_id?: string }).approval_request_id as string;
    await okAs(h.t, h.owner, (ctx) => decideApproval(ctx, { approvalRequestId: id, decision: "approve" }));
    const st = await sql<{ status: string; fee: string | null }>`
      select r.status, (select sum(i.total)::text from invoices i join stays s on s.id = i.stay_id
                        join reservation_items it on it.id = s.reservation_item_id where it.reservation_id = r.id) as fee
      from reservations r where r.id = ${d.reservationId}`.execute(h.t.admin);
    expect(st.rows[0]).toEqual({ status: "cancelled", fee: "300000" });
  });
});

describe("R9 hết hạn giữ phát hiện lúc xác nhận có audit", () => {
  it("HOLD_EXPIRED → booking expired + audit reservation.expired", async () => {
    const d = await okAs(h.t, h.manager, async (ctx) =>
      createReservation(ctx, {
        unitId: await unit(),
        arrivalDate: "2026-11-10",
        departureDate: "2026-11-11",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách hết giữ", phone: "0966000888" },
      }),
    );
    await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          confirmReservation(ctx, { reservationId: d.reservationId, now: new Date(Date.now() + 86_400_000) }),
        ),
      ),
    ).toBe("HOLD_EXPIRED");
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${d.reservationId} and action = 'reservation.expired'`.execute(
      h.t.admin,
    );
    expect(a.rows[0]?.n).toBe(1);
  });
});
