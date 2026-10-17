// PLAN đợt 3 T-220 — nhật ký audit + "Hôm nay" trên Postgres thật (SPEC-audit-reporting S-001…S-008).
import { randomUUID } from "node:crypto";
import { seedIssuedInvoice, setBusinessDayCutoffForTest } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { createReservation, holdReservation } from "../stay/reservations.ts";
import { walkIn } from "../stay/stays.ts";
import { okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { getSummary, listItems, TODAY_CARDS } from "../today/today.ts";
import { AUDIT_MONEY_GROUPS, getEvent, listEvents } from "./events.ts";

let h: Hotel;
let hs2: string;
let maintenance: Actor;
const pii = createPiiCipher(devKeyring());
/** Giờ cơ sở (UTC+7) → UTC. */
const vn = (local: string) => new Date(`${local}:00+07:00`);
const NOW = vn("2026-10-20T10:00");
let seq = 0;

async function unit(propertyId: string, floorId: string, typeId: string, hk = "inspected"): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${propertyId}, ${floorId}, ${typeId}, ${`T${seq}`}, ${hk})`.execute(
    h.t.admin,
  );
  return id;
}
const hs1Unit = (hk?: string) => unit(h.org.propertyId, h.org.floorId, h.org.roomTypeId, hk);

async function audit(e: {
  propertyId: string | null;
  action: string;
  correlationId?: string;
  at?: string;
  actor?: string;
  before?: unknown;
}): Promise<string> {
  const id = randomUUID();
  await sql`insert into audit_events (id, organization_id, property_id, occurred_at, actor_type, actor_person_id, action,
                                      entity_type, entity_id, before, correlation_id)
            values (${id}, ${h.org.orgId}, ${e.propertyId}, ${e.at ?? "2026-10-15T03:00:00Z"}::timestamptz, 'user',
                    ${e.actor ?? h.owner.personId}, ${e.action}, 'test', ${randomUUID()},
                    ${e.before === undefined ? null : JSON.stringify(e.before)}::jsonb, ${e.correlationId ?? `c-${id}`})`.execute(
    h.t.admin,
  );
  return id;
}

beforeAll(async () => {
  h = await seedHotel();
  maintenance = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật T" });
  // Cơ sở thứ hai HS2 (quản lý M chỉ có HS1).
  hs2 = randomUUID();
  const f2 = randomUUID();
  const t2 = randomUUID();
  await h.t.admin.transaction().execute(async (trx) => {
    await sql`insert into properties (id, organization_id, name, template) values (${hs2}, ${h.org.orgId}, 'HS2', 'hotel')`.execute(
      trx,
    );
    await sql`insert into floors (id, organization_id, property_id, name) values (${f2}, ${h.org.orgId}, ${hs2}, 'Tầng 1')`.execute(
      trx,
    );
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
              values (${t2}, ${h.org.orgId}, ${hs2}, 'STD', 'Tiêu chuẩn', 2)`.execute(trx);
  });
  await unit(hs2, f2, t2, "dirty");
});

afterAll(async () => {
  await h?.t.drop();
});

describe("S-001…S-003 audit cùng transaction, che dữ liệu, append-only", () => {
  it("command commit → 1 audit có correlation_id + command_id, before/after đã che mật khẩu/CCCD; rollback → không audit", async () => {
    const entity = randomUUID();
    const r = await runAs(h.t, h.manager, async (ctx) => {
      await ctx.audit({
        action: "person.updated",
        entityType: "person",
        entityId: entity,
        propertyId: h.org.propertyId,
        before: { note: "CCCD 012345678901", password: "bi-mat" },
        after: { note: "đã sửa" },
        reason: "Sửa hồ sơ",
      });
      return {};
    });
    expect(r.status).toBe("committed");
    const a = await sql<{
      before: unknown;
      correlation_id: string;
      command_id: string | null;
      actor_person_id: string;
    }>`
      select before, correlation_id, command_id, actor_person_id from audit_events where entity_id = ${entity}`.execute(
      h.t.admin,
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.actor_person_id).toBe(h.manager.personId);
    expect(a.rows[0]?.command_id).toBeTruthy();
    expect(a.rows[0]?.correlation_id).toBeTruthy();
    expect(JSON.stringify(a.rows[0]?.before)).not.toMatch(/012345678901|bi-mat/);
    expect(JSON.stringify(a.rows[0]?.before)).toContain("8901");

    const gone = randomUUID();
    const f = await runAs(h.t, h.manager, async (ctx) => {
      await ctx.audit({ action: "person.updated", entityType: "person", entityId: gone });
      throw new Error("rollback");
    }).catch((e) => e);
    expect(f).toBeTruthy();
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where entity_id = ${gone}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(0);
  });

  it("app_runtime UPDATE/DELETE audit_events → bị từ chối", async () => {
    const id = await audit({ propertyId: h.org.propertyId, action: "payment.confirmed" });
    await expect(
      sql`update audit_events set reason = 'x' where id = ${id}`.execute(h.t.runtime),
    ).rejects.toThrow();
    await expect(sql`delete from audit_events where id = ${id}`.execute(h.t.runtime)).rejects.toThrow();
  });
});

describe("S-004 xem nhật ký theo quyền", () => {
  let ids: { hs1Pay: string; hs2Pay: string; hs1Lease: string; orgByOwner: string; orgByManager: string };
  beforeAll(async () => {
    ids = {
      hs1Pay: await audit({ propertyId: h.org.propertyId, action: "payment.confirmed", correlationId: "s4" }),
      hs2Pay: await audit({ propertyId: hs2, action: "payment.confirmed", correlationId: "s4" }),
      hs1Lease: await audit({ propertyId: h.org.propertyId, action: "lease.activated", correlationId: "s4" }),
      orgByOwner: await audit({ propertyId: null, action: "member.invited", correlationId: "s4" }),
      orgByManager: await audit({
        propertyId: null,
        action: "member.invited",
        correlationId: "s4",
        actor: h.manager.personId,
      }),
    };
  });
  const seen = async (actor: Actor) =>
    new Set((await listEvents(h.t.runtime, actor, { correlationId: "s4" })).items.map((e) => e.id));

  it("owner thấy toàn tổ chức", async () => {
    expect(await seen(h.owner)).toEqual(new Set(Object.values(ids)));
  });

  it("manager (HS1): sự kiện HS1 + cấp tổ chức của chính mình; lọc HS2 → 404", async () => {
    expect(await seen(h.manager)).toEqual(new Set([ids.hs1Pay, ids.hs1Lease, ids.orgByManager]));
    await expect(listEvents(h.t.runtime, h.manager, { propertyId: hs2 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getEvent(h.t.runtime, h.manager, ids.hs2Pay)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accountant: chỉ nhóm tiền", async () => {
    expect(await seen(h.accountant)).toEqual(new Set([ids.hs1Pay, ids.hs2Pay]));
    await expect(getEvent(h.t.runtime, h.accountant, ids.hs1Lease)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("buồng phòng, lễ tân, người thuê → 403 kể cả lọc cơ sở ngoài phạm vi", async () => {
    const tenant = await seedMember(h.t, h.org, "tenant", { properties: [] });
    for (const a of [h.housekeeping, h.frontDesk, tenant]) {
      await expect(listEvents(h.t.runtime, a)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listEvents(h.t.runtime, a, { propertyId: hs2 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("RLS chặn cả khi gọi SQL trực tiếp trong ngữ cảnh buồng phòng (phòng thủ nhiều lớp)", async () => {
    const { withTenant } = await import("@hm/db");
    const n = await withTenant(
      h.t.runtime,
      { orgId: h.org.orgId, actorId: h.housekeeping.membershipId },
      (trx) => sql<{ n: number }>`select count(*)::int as n from audit_events`.execute(trx),
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("danh sách nhóm tiền của app trùng policy CSDL", async () => {
    const p = await sql<{ qual: string }>`
      select qual from pg_policies where tablename = 'audit_events' and policyname = 'audit_read_by_role'`.execute(
      h.t.admin,
    );
    for (const g of AUDIT_MONEY_GROUPS) expect(p.rows[0]?.qual).toContain(`'${g}'`);
  });
});

describe("S-005 lọc theo correlation_id + keyset", () => {
  it("3 sự kiện cùng c-9 → đúng 3, theo occurred_at, giờ theo múi giờ cơ sở", async () => {
    const c = `c-9-${randomUUID().slice(0, 6)}`;
    const b = await audit({
      propertyId: h.org.propertyId,
      action: "deposit.received",
      correlationId: c,
      at: "2026-10-15T03:00:02Z",
    });
    const a = await audit({
      propertyId: h.org.propertyId,
      action: "reservation.held",
      correlationId: c,
      at: "2026-10-15T03:00:01Z",
    });
    const o = await audit({
      propertyId: h.org.propertyId,
      action: "outbox.emitted",
      correlationId: c,
      at: "2026-10-15T03:00:03Z",
    });
    const r = await listEvents(h.t.runtime, h.owner, { correlationId: c });
    expect(r.items.map((e) => e.id)).toEqual([a, b, o]);
    expect(r.items[0]?.occurredAtLocal).toBe("2026-10-15 10:00:01");
  });

  it("phân trang keyset: các trang nối nhau không trùng không sót, kể cả cùng thời điểm và khác micro giây", async () => {
    const c = `page-${randomUUID().slice(0, 6)}`;
    const made: string[] = [];
    for (let i = 0; i < 7; i++)
      made.push(
        await audit({
          propertyId: h.org.propertyId,
          action: "payment.confirmed",
          correlationId: c,
          at: i < 3 ? "2026-10-15T03:00:00.000001Z" : `2026-10-15T03:00:00.00000${i}Z`,
        }),
      );
    const got: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await listEvents(h.t.runtime, h.owner, {
        correlationId: c,
        order: "desc",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      got.push(...r.items.map((e) => e.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(got).toHaveLength(7);
    expect(new Set(got)).toEqual(new Set(made));
    await expect(listEvents(h.t.runtime, h.owner, { cursor: "khong-hop-le" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("S-006…S-008 Hôm nay", () => {
  beforeAll(async () => {
    // 3 khách đến hôm nay (giữ phòng) + 1 booking đã huỷ cùng ngày (không đếm).
    const arrivals: string[] = [];
    for (let i = 0; i < 4; i++) {
      const u = await hs1Unit();
      const d = await okAs(h.t, h.manager, (ctx) =>
        createReservation(ctx, {
          unitId: u,
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-22",
          guests: 1,
          source: "direct",
          booker: { fullName: `Khách ${i}`, phone: `091234560${i}` },
        }),
      );
      await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
      arrivals.push(d.reservationId);
    }
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update reservations set status = 'cancelled', cancel_reason = 'khách huỷ', cancelled_at = now()
                where id = ${arrivals[3]}`.execute(trx);
    });
    // 2 khách đi hôm nay (nhận phòng hôm qua).
    for (let i = 0; i < 2; i++) {
      const u = await hs1Unit();
      await okAs(h.t, h.frontDesk, (ctx) =>
        walkIn(ctx, pii, {
          unitId: u,
          departureDate: "2026-10-20",
          guests: [
            { fullName: `Khách đi ${i}`, phone: "0100005678", docType: "cccd", docNumber: `00170000000${i}` },
          ],
          now: vn("2026-10-19T15:00"),
        }),
      );
    }
    // 1 phiếu quá hạn + 1 phiếu chưa tới hạn + 1 phiếu đã trả (chỉ phiếu đầu được đếm).
    const payer = h.owner.personId;
    const mk = async (due: string, paid: boolean) => {
      const inv = await seedIssuedInvoice(h.t.admin, {
        orgId: h.org.orgId,
        propertyId: h.org.propertyId,
        payerPersonId: payer,
        lines: [{ amount: 1_580_000 }],
        businessDate: "2026-10-01",
      });
      await h.t.admin.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await sql`update invoices set due_on = ${due}::date ${paid ? sql`, allocated_total = total` : sql``}
                  where id = ${inv.invoiceId}`.execute(trx);
      });
    };
    await mk("2026-10-10", false);
    await mk("2026-10-25", false);
    await mk("2026-10-05", true);
    // 1 kỳ thu đang duyệt; 4 phòng cần dọn; 2 sự cố mở (+1 đã xong không đếm).
    await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, '2026-10-01', '2026-10-31', 'reviewing')`.execute(
      h.t.admin,
    );
    for (let i = 0; i < 4; i++) await hs1Unit(i === 3 ? "cleaning" : "dirty");
    for (const status of ["open", "open", "cancelled"]) {
      const u = await hs1Unit();
      await sql`insert into work_orders (id, organization_id, property_id, unit_id, title, description, severity, status, source,
                                         reporter_membership_id, cancel_reason)
                values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${u}, 'Rò nước', 'Rò nước bồn rửa', 'medium', ${status},
                        'staff', ${h.org.ownerMembershipId}, ${status === "cancelled" ? "trùng" : null})`.execute(
        h.t.admin,
      );
    }
  });

  const counts = async (actor: Actor, propertyId?: string) =>
    Object.fromEntries(
      (await getSummary(h.t.runtime, actor, { now: NOW, ...(propertyId ? { propertyId } : {}) })).cards.map(
        (c) => [c.key, c.count],
      ),
    );

  it("S-006 quản lý HS1: Khách đến 3 · Khách đi 2 · Nợ 1 · Kỳ thu cần duyệt 1 · Phòng cần dọn 4 · Sự cố 2; danh sách đúng số dòng", async () => {
    const s = await getSummary(h.t.runtime, h.manager, { now: NOW });
    expect(s.properties.map((p) => p.businessDate)).toEqual(["2026-10-20"]);
    const c = Object.fromEntries(s.cards.map((x) => [x.key, x]));
    expect(c.arrivals?.count).toBe(3);
    expect(c.departures?.count).toBe(2);
    expect(c.receivables).toMatchObject({ count: 1, amount: 1_580_000 });
    expect(c.periodsReviewing?.count).toBe(1);
    expect(c.dirtyUnits?.count).toBe(4);
    expect(c.workOrders?.count).toBe(2);
    for (const card of TODAY_CARDS) {
      const items = await listItems(h.t.runtime, h.manager, { card, now: NOW });
      expect(items, card).toHaveLength(c[card]?.count ?? -1);
    }
    const inv = await listItems(h.t.runtime, h.manager, { card: "receivables", now: NOW });
    expect(inv[0]).toMatchObject({ amount: 1_580_000, overdue: true });
  });

  it("owner thấy cả HS2 (phòng bẩn ở HS2); quản lý lọc HS2 → 404", async () => {
    expect((await counts(h.owner)).dirtyUnits).toBe(5);
    expect((await counts(h.owner, hs2)).dirtyUnits).toBe(1);
    await expect(getSummary(h.t.runtime, h.manager, { propertyId: hs2, now: NOW })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("S-007 buồng phòng: chỉ Phòng cần dọn + Sự cố, không trường tiền; thẻ khác → 403; người thuê → 403", async () => {
    const s = await getSummary(h.t.runtime, h.housekeeping, { now: NOW });
    expect(s.cards.map((c) => c.key)).toEqual(["dirtyUnits", "workOrders"]);
    expect(JSON.stringify(s)).not.toMatch(/amount/);
    expect(s.cards.find((c) => c.key === "dirtyUnits")?.count).toBe(4);
    await expect(
      listItems(h.t.runtime, h.housekeeping, { card: "receivables", now: NOW }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await getSummary(h.t.runtime, maintenance, { now: NOW })).cards.map((c) => c.key)).toEqual([
      "workOrders",
    ]);
    const tenant = await seedMember(h.t, h.org, "tenant", { properties: [] });
    await expect(getSummary(h.t.runtime, tenant, { now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const acc = await getSummary(h.t.runtime, h.accountant, { now: NOW });
    expect(acc.cards.map((c) => c.key)).toEqual(["receivables", "periodsReviewing"]);
  });

  it("S-008 giờ chốt ngày 04:00, lúc 01:30 ngày 21/10 giờ cơ sở → ngày kinh doanh 20/10", async () => {
    await setBusinessDayCutoffForTest(h.t.admin, h.org.propertyId, "04:00");
    try {
      const s = await getSummary(h.t.runtime, h.manager, { now: vn("2026-10-21T01:30") });
      expect(s.properties[0]?.businessDate).toBe("2026-10-20");
      expect(s.cards.find((c) => c.key === "arrivals")?.count).toBe(3);
    } finally {
      await setBusinessDayCutoffForTest(h.t.admin, h.org.propertyId, "00:00");
    }
  });
});
