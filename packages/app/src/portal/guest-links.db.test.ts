// PLAN đợt 3 T-218 — liên kết khách trên Postgres thật (SPEC-portal S-016…S-020; D-006).
// Ví dụ S-016: folio 2 × 600.000 + 80.000 + 150.000 = 1.430.000, ứng trước 500.000 → còn 930.000.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { postCharge } from "../stay/folio.ts";
import { confirmReservation, createReservation, holdReservation } from "../stay/reservations.ts";
import { checkIn } from "../stay/stays.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { createGuestLink, guestGetStay, revokeGuestLink } from "./guest.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
const NOW = new Date("2026-10-21T03:00:00Z");
let seq = 0;

async function stay(): Promise<{ stayId: string; unitId: string }> {
  const unitId = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${unitId}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`G${seq}`}, 'inspected')`.execute(
    h.t.admin,
  );
  const d = await okAs(h.t, h.manager, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      guests: 1,
      source: "direct",
      booker: { fullName: "Khách R-778", phone: "0100005678" },
    }),
  );
  await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  await okAs(h.t, h.manager, (ctx) =>
    confirmReservation(ctx, {
      reservationId: d.reservationId,
      payment: {
        amount: 500_000,
        method: "bank_transfer",
        kind: "advance",
        receivingAccountId: h.receivingAccountId,
        bankTxn: { ref: `FT-${randomUUID().slice(0, 12)}`, occurredAt: "2026-10-16T03:00:00Z" },
      },
    }),
  );
  const s = await okAs(h.t, h.frontDesk, (ctx) =>
    checkIn(ctx, pii, {
      reservationId: d.reservationId,
      guests: [
        {
          fullName: "Khách R-778",
          phone: "0100005678",
          docType: "cccd",
          docNumber: `0017${String(seq).padStart(8, "0")}`,
        },
      ],
      now: new Date("2026-10-20T08:00:00Z"),
    }),
  );
  for (const [description, unitPrice, kind] of [
    ["Minibar", 80_000, "service"],
    ["Trả phòng muộn", 150_000, "fee"],
  ] as const)
    await okAs(h.t, h.frontDesk, (ctx) =>
      postCharge(ctx, {
        stayId: s.stayId,
        kind,
        description,
        quantity: 1,
        unitPrice,
        now: new Date("2026-10-21T02:00:00Z"),
      }),
    );
  return { stayId: s.stayId, unitId };
}

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe("S-016 khách mở liên kết hợp lệ", () => {
  it("qua bước hai → lượt ở + folio 1.430.000 / đã trả 500.000 / còn 930.000; không hồ sơ, không giấy tờ; token chỉ lưu băm", async () => {
    const s = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    expect(l.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await sql<{ token_hash: Buffer; expires_at: Date }>`
      select token_hash, expires_at from guest_access_links where id = ${l.linkId}`.execute(h.t.admin);
    expect(stored.rows[0]?.token_hash.equals(createHash("sha256").update(l.token).digest())).toBe(true);
    // Hạn = 22/10 12:00 giờ cơ sở + 48 giờ.
    expect(stored.rows[0]?.expires_at.toISOString()).toBe("2026-10-24T05:00:00.000Z");
    const v = await guestGetStay(h.t.runtime, {
      token: l.token,
      stayId: s.stayId,
      phoneLast4: "5678",
      ip: ip(),
      now: NOW,
    });
    expect(v.stay).toMatchObject({
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      status: "in_house",
    });
    expect(v.folio).toMatchObject({ total: 1_430_000, paid: 500_000, balance: 930_000 });
    const body = JSON.stringify(v);
    expect(body).not.toMatch(/0100005678|0017\d{8}|Khách R-778/);
  });

  it("cơ sở tắt bước hai → mở được không cần 4 số", async () => {
    const s = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    await sql`update properties set settings = settings || '{"guest_link_second_factor": false}'::jsonb where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    try {
      const v = await guestGetStay(h.t.runtime, { token: l.token, stayId: s.stayId, ip: ip(), now: NOW });
      expect(v.folio.total).toBe(1_430_000);
    } finally {
      await sql`update properties set settings = settings - 'guest_link_second_factor' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("S-017…S-019 hết hạn, sai lượt ở, thu hồi, khoá", () => {
  it("hết hạn → 410 LINK_EXPIRED; lượt ở khác → 404; thu hồi → 410 LINK_REVOKED + audit người thu hồi; buồng phòng không tạo link", async () => {
    const s = await stay();
    const other = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    const open = (stayId: string, now = NOW) =>
      guestGetStay(h.t.runtime, { token: l.token, stayId, phoneLast4: "5678", ip: ip(), now }).catch(
        (e) => e,
      );
    expect(await open(s.stayId, new Date("2026-10-24T05:00:01Z"))).toMatchObject({
      code: "LINK_EXPIRED",
      status: 410,
    });
    expect(await open(other.stayId)).toMatchObject({ code: "NOT_FOUND", status: 404 });
    await okAs(h.t, h.manager, (ctx) => revokeGuestLink(ctx, { linkId: l.linkId }));
    expect(await open(s.stayId)).toMatchObject({ code: "LINK_REVOKED", status: 410 });
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'portal.guest_link_revoked' and entity_id = ${l.linkId}
        and actor_person_id = ${h.manager.personId}`.execute(h.t.admin);
    expect(a.rows[0]?.n).toBe(1);
    expect(
      await codeOf(runAs(h.t, h.housekeeping, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }))),
    ).toMatch(/FORBIDDEN|NOT_FOUND/);
  });

  it("sai 4 số cuối 5 lần → link bị khoá (410), kể cả nhập đúng sau đó", async () => {
    const s = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    const tryWith = (last4: string) =>
      guestGetStay(h.t.runtime, {
        token: l.token,
        stayId: s.stayId,
        phoneLast4: last4,
        ip: ip(),
        now: NOW,
      }).catch((e) => e);
    for (let i = 0; i < 4; i++) expect(await tryWith("0000")).toMatchObject({ code: "NOT_FOUND" });
    expect(await tryWith("0000")).toMatchObject({ code: "LINK_REVOKED" });
    expect(await tryWith("5678")).toMatchObject({ code: "LINK_REVOKED" });
  });

  it("lần đúng chạy song song ngay sau khi link bị khoá → hàm ghi lần dùng báo khoá, không mở (review lát 4)", async () => {
    const s = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    await sql`update guest_access_links set locked_at = ${NOW}, failed_attempts = 5 where id = ${l.linkId}`.execute(
      h.t.admin,
    );
    const r = await sql<{ locked: boolean }>`
      select app.guest_link_attempt(${l.linkId}::uuid, true, ${NOW}) as locked`.execute(h.t.runtime);
    expect(r.rows[0]?.locked).toBe(true);
    const used = await sql<{ last_used_at: Date | null }>`
      select last_used_at from guest_access_links where id = ${l.linkId}`.execute(h.t.admin);
    expect(used.rows[0]?.last_used_at).toBeNull();
  });

  it("người đặt không có SĐT mà cơ sở bật bước hai → 422 booker_phone, không tạo link; tắt bước hai → tạo được", async () => {
    // Người đặt nhập từ nguồn khác/đã sửa hồ sơ, không còn SĐT (đặt phòng mới luôn bắt buộc SĐT).
    const s = await stay();
    await sql`update persons set phone = null where id = (
                select r.booker_person_id from stays st
                join reservation_items ri on ri.id = st.reservation_item_id
                join reservations r on r.id = ri.reservation_id where st.id = ${s.stayId})`.execute(
      h.t.admin,
    );
    const r = await runAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    expect(await codeOf(Promise.resolve(r))).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(r)).toContain("booker_phone");
    const n = await sql<{ n: number }>`
      select count(*)::int as n from guest_access_links where stay_id = ${s.stayId}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(0);
    await sql`update properties set settings = settings || '{"guest_link_second_factor": false}'::jsonb
              where id = ${h.org.propertyId}`.execute(h.t.admin);
    try {
      await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    } finally {
      await sql`update properties set settings = settings - 'guest_link_second_factor' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("S-020 đoán token", () => {
  it("cùng IP 10 token sai trong 1 phút → lần 11 (kể cả token đúng) 429; thông điệp token không tồn tại = sai định dạng", async () => {
    const s = await stay();
    const l = await okAs(h.t, h.frontDesk, (ctx) => createGuestLink(ctx, { stayId: s.stayId, now: NOW }));
    const addr = ip();
    const errs: { code: string; message: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const bad = i % 2 === 0 ? "x".repeat(43) : "khong-hop-le";
      errs.push(
        await guestGetStay(h.t.runtime, {
          token: bad,
          stayId: s.stayId,
          phoneLast4: "5678",
          ip: addr,
          now: NOW,
        }).catch((e) => e),
      );
    }
    expect(new Set(errs.map((e) => `${e.code}:${e.message}`)).size).toBe(1);
    expect(errs[0]).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await guestGetStay(h.t.runtime, {
        token: l.token,
        stayId: s.stayId,
        phoneLast4: "5678",
        ip: addr,
        now: NOW,
      }).catch((e) => e),
    ).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    // IP khác không bị ảnh hưởng; phút sau mở lại.
    expect(
      (
        await guestGetStay(h.t.runtime, {
          token: l.token,
          stayId: s.stayId,
          phoneLast4: "5678",
          ip: ip(),
          now: NOW,
        })
      ).folio.total,
    ).toBe(1_430_000);
    expect(
      (
        await guestGetStay(h.t.runtime, {
          token: l.token,
          stayId: s.stayId,
          phoneLast4: "5678",
          ip: addr,
          now: new Date(NOW.getTime() + 61_000),
        })
      ).folio.total,
    ).toBe(1_430_000);
  });
});
