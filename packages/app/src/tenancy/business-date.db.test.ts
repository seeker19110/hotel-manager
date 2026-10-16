// PLAN đợt 3 T-201 — giờ chốt ngày kinh doanh theo mẫu (D-002/D-005) và khoá đổi khi đã có dữ liệu (SPEC-access S-023)
// trên Postgres thật. Ví dụ theo SPEC-reservation S-016 (b): giờ chốt 04:00, walk-in 16/10 01:30 → đêm của 15/10.
import { randomUUID } from "node:crypto";
import { propertyDefaults } from "@hm/domain";
import { createTestDb, type SeededOrg, seedIssuedInvoice, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let t: TestDb;
let H: SeededOrg;
let R: SeededOrg;

async function businessDate(o: SeededOrg, at: string): Promise<string> {
  const r = await sql<{
    d: string;
  }>`select app.business_date(${o.orgId}::uuid, ${o.propertyId}::uuid, ${at}::timestamptz)::text as d`.execute(
    t.admin,
  );
  return r.rows[0]?.d ?? "";
}

beforeAll(async () => {
  t = await createTestDb();
  H = await seedOrg(t.admin, "Khách sạn giờ chốt", "hotel");
  R = await seedOrg(t.admin, "Nhà trọ giờ chốt", "rental");
  const d = propertyDefaults("hotel");
  await sql`update properties set business_day_cutoff = ${d.businessDayCutoff}::time,
              check_in_time = ${d.checkInTime}::time, check_out_time = ${d.checkOutTime}::time
            where id = ${H.propertyId}`.execute(t.admin);
});

afterAll(async () => {
  await t?.drop();
});

describe("app.business_date theo giờ chốt (D-005)", () => {
  it("khách sạn 04:00: 01:30 giờ VN thuộc ngày hôm trước; 04:00 sang ngày mới (S-016 b)", async () => {
    expect(await businessDate(H, "2026-10-16T01:30:00+07:00")).toBe("2026-10-15");
    expect(await businessDate(H, "2026-10-16T03:59:59+07:00")).toBe("2026-10-15");
    expect(await businessDate(H, "2026-10-16T04:00:00+07:00")).toBe("2026-10-16");
  });

  it("trọ 00:00: nửa đêm giờ VN là ngày mới; mốc UTC 17:00 không làm lệch ngày", async () => {
    expect(await businessDate(R, "2026-10-16T00:00:00+07:00")).toBe("2026-10-16");
    expect(await businessDate(R, "2026-10-15T17:00:00Z")).toBe("2026-10-16");
    expect(await businessDate(R, "2026-10-15T16:59:59Z")).toBe("2026-10-15");
  });

  it("giờ nhận/trả mặc định của khách sạn lưu đúng cột", async () => {
    const r = await sql<{
      i: string;
      o: string;
    }>`select check_in_time::text i, check_out_time::text o from properties where id = ${H.propertyId}`.execute(
      t.admin,
    );
    expect(r.rows[0]).toEqual({ i: "14:00:00", o: "12:00:00" });
  });
});

describe("S-023 — đổi múi giờ/giờ chốt khi cơ sở đã có dữ liệu → PROPERTY_IN_USE", () => {
  it("chưa có dữ liệu thì đổi được; có allocation thì bị từ chối, giá trị cũ giữ nguyên", async () => {
    const o = await seedOrg(t.admin, "Cơ sở đổi giờ chốt", "hotel");
    await sql`update properties set business_day_cutoff = '05:00' where id = ${o.propertyId}`.execute(
      t.admin,
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${o.unitId}, 'block', 'block', ${randomUUID()},
                      tstzrange('2026-11-01T14:00:00+07:00', '2026-11-02T12:00:00+07:00'))`.execute(t.admin);
    for (const change of [
      sql`update properties set business_day_cutoff = '04:00' where id = ${o.propertyId}`,
      sql`update properties set timezone = 'Asia/Bangkok' where id = ${o.propertyId}`,
    ]) {
      const err = await change.execute(t.admin).then(
        () => null,
        (e: { hint?: string }) => e,
      );
      expect(err?.hint).toBe("PROPERTY_IN_USE");
    }
    const r = await sql<{
      c: string;
      tz: string;
    }>`select business_day_cutoff::text c, timezone tz from properties where id = ${o.propertyId}`.execute(
      t.admin,
    );
    expect(r.rows[0]).toEqual({ c: "05:00:00", tz: "Asia/Ho_Chi_Minh" });
    // Cột khác vẫn sửa được.
    await sql`update properties set name = 'Đổi tên được' where id = ${o.propertyId}`.execute(t.admin);
  });

  it("có chứng từ (phiếu) cũng bị từ chối", async () => {
    const o = await seedOrg(t.admin, "Cơ sở có phiếu", "rental");
    await seedIssuedInvoice(t.admin, {
      orgId: o.orgId,
      propertyId: o.propertyId,
      payerPersonId: o.ownerPersonId,
      lines: [{ amount: 100_000 }],
    });
    const err = await sql`update properties set business_day_cutoff = '01:00' where id = ${o.propertyId}`
      .execute(t.admin)
      .then(
        () => null,
        (e: { hint?: string }) => e,
      );
    expect(err?.hint).toBe("PROPERTY_IN_USE");
  });
});

describe("S-023 — đổi giờ chốt song song với tạo chứng từ đầu tiên không thể cùng commit (review: kiểm EXISTS không khoá)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const insertAllocation = (o: SeededOrg) =>
    sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
        values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${o.unitId}, 'block', 'block', ${randomUUID()},
                tstzrange('2026-11-01T14:00:00+07:00', '2026-11-02T12:00:00+07:00'))`;
  const changeCutoff = (o: SeededOrg) =>
    sql`update properties set business_day_cutoff = '03:00' where id = ${o.propertyId}`;
  const cutoffOf = async (o: SeededOrg) =>
    (
      await sql<{
        c: string;
      }>`select business_day_cutoff::text c from properties where id = ${o.propertyId}`.execute(t.admin)
    ).rows[0]?.c;

  it("allocation đã insert (chưa commit) → bên đổi giờ chốt CHỜ, rồi nhận PROPERTY_IN_USE; giá trị cũ giữ nguyên", async () => {
    const o = await seedOrg(t.admin, "Đua: allocation trước", "hotel");
    const before = await cutoffOf(o);
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => {
      inserted = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tx1 = t.admin.transaction().execute(async (trx) => {
      await insertAllocation(o).execute(trx);
      inserted();
      await gate;
    });
    await insertedP;
    let state: "pending" | "done" = "pending";
    const tx2 = t.admin
      .transaction()
      .execute((trx) => changeCutoff(o).execute(trx))
      .then(
        () => {
          state = "done";
          return null;
        },
        (e: { hint?: string }) => {
          state = "done";
          return e;
        },
      );
    await sleep(600);
    const waited = state === "pending"; // bên đổi giờ đang chờ chứng từ chưa commit
    release(); // luôn nhả khoá kể cả khi khẳng định bên dưới đỏ (tránh treo test)
    expect(waited).toBe(true);
    await tx1;
    expect((await tx2)?.hint).toBe("PROPERTY_IN_USE");
    expect(await cutoffOf(o)).toBe(before);
  });

  it("đổi giờ chốt đang giữ (chưa commit) → allocation đầu tiên CHỜ rồi mới ghi; không có hai bên cùng commit lệch nhau", async () => {
    const o = await seedOrg(t.admin, "Đua: đổi giờ trước", "hotel");
    let changed!: () => void;
    const changedP = new Promise<void>((r) => {
      changed = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tx1 = t.admin.transaction().execute(async (trx) => {
      await changeCutoff(o).execute(trx);
      changed();
      await gate;
    });
    await changedP;
    let state: "pending" | "done" = "pending";
    const tx2 = t.admin
      .transaction()
      .execute((trx) => insertAllocation(o).execute(trx))
      .then(() => {
        state = "done";
      });
    await sleep(600);
    const waited = state === "pending";
    release();
    expect(waited).toBe(true);
    await tx1;
    await tx2;
    expect(await cutoffOf(o)).toBe("03:00:00");
  });

  it("khoá chia sẻ nằm trên cả bốn loại chứng từ (allocations, journal_entries, invoices, payments)", async () => {
    const r = await sql<{ t: string }>`
      select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where g.tgname like '%\_property\_use' order by 1`.execute(t.admin);
    expect(r.rows.map((x) => x.t)).toEqual(["allocations", "invoices", "journal_entries", "payments"]);
  });
});
