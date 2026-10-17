// T-005 — cách ly tenant ở CSDL (INV-G1, DB-SEC-007, TM-01, TM-13) trên Postgres 17 thật.
import { randomUUID } from "node:crypto";
import { migrateDownAll, migrateToLatest, withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TABLES = [
  "organizations",
  "properties",
  "floors",
  "room_types",
  "units",
  "persons",
  "memberships",
  "property_scopes",
  "invitations",
];

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ A", "rental");
  B = await seedOrg(t.admin, "Khách sạn B", "hotel");
  for (const o of [A, B]) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${o.orgId}, ${o.ownerMembershipId}, ${o.propertyId})`.execute(t.admin);
    await sql`insert into invitations (id, organization_id, email, role, token_hash, expires_at, invited_by)
              values (${randomUUID()}, ${o.orgId}, ${`nv+${o.orgId.slice(0, 6)}@example.test`}, 'front_desk',
                      ${Buffer.alloc(32, o === A ? 1 : 2)}, now() + interval '7 days', ${o.ownerMembershipId})`.execute(
      t.admin,
    );
  }
});

afterAll(async () => {
  await t.drop();
});

describe("cấu hình RLS (DB-SEC-007)", () => {
  it("mọi bảng có organization_id (và organizations) bật ENABLE + FORCE RLS và có policy USING + WITH CHECK", async () => {
    const r = await sql<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: number;
      with_check: number;
    }>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force,
             (select count(*) from pg_policies p where p.tablename = c.relname)::int as policies,
             (select count(*) from pg_policies p where p.tablename = c.relname and p.with_check is not null)::int as with_check
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'organizations' or exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'organization_id'))
      order by c.relname`.execute(t.admin);
    // Động: mọi bảng có organization_id hiện có (kể cả bảng thêm ở migration sau) phải đạt; tối thiểu 9 bảng của T-005.
    expect(r.rows.map((x) => x.relname)).toEqual(expect.arrayContaining(TABLES));
    for (const row of r.rows) {
      expect(row, row.relname).toMatchObject({ rls: true, force: true });
      expect(row.policies, row.relname).toBeGreaterThanOrEqual(1);
      expect(row.with_check, row.relname).toBeGreaterThanOrEqual(1);
    }
  });

  it("role ứng dụng không sở hữu bảng nào", async () => {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from pg_tables
      where schemaname = 'public' and tableowner in ('app_runtime','app_worker')`.execute(t.admin);
    expect(r.rows[0]?.n).toBe(0);
  });
});

describe("cách ly đọc/ghi giữa tổ chức (TM-01)", () => {
  it.each(TABLES)("%s: ngữ cảnh A chỉ thấy hàng của A", async (table) => {
    const rows = await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
      const col = table === "organizations" ? "id" : "organization_id";
      const r = await sql<{
        org: string;
      }>`select ${sql.ref(col)}::text as org from ${sql.table(table)}`.execute(trx);
      return r.rows.map((x) => x.org);
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows)).toEqual(new Set([A.orgId]));
  });

  it("SPEC-access S-013: đọc theo id của B trong ngữ cảnh A → không thấy (không lộ tồn tại)", async () => {
    const r = await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      sql`select id from units where id = ${B.unitId}`.execute(trx),
    );
    expect(r.rows).toEqual([]);
  });

  it("SPEC-access S-013: ghi hàng mang organization_id của B trong ngữ cảnh A → bị WITH CHECK chặn", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`insert into persons (id, organization_id, full_name) values (${randomUUID()}, ${B.orgId}, 'Giả mạo')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("sửa/xoá hàng của B trong ngữ cảnh A → 0 hàng bị ảnh hưởng", async () => {
    const res = await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
      const u = await sql`update units set code = 'HACK' where id = ${B.unitId}`.execute(trx);
      const d = await sql`delete from invitations where organization_id = ${B.orgId}`.execute(trx);
      return [Number(u.numAffectedRows), Number(d.numAffectedRows)];
    });
    expect(res).toEqual([0, 0]);
    const still = await sql<{ code: string }>`select code from units where id = ${B.unitId}`.execute(t.admin);
    expect(still.rows[0]?.code).toBe("101");
  });

  it("không đặt app.org_id → truy vấn lỗi (đóng an toàn), không trả hàng", async () => {
    // Phiên trong pool có thể đã từng SET LOCAL (giá trị còn lại là ''), phiên mới thì chưa có tham số: cả hai đều lỗi.
    for (let i = 0; i < 3; i++) {
      await expect(sql`select count(*) from units`.execute(t.runtime)).rejects.toThrow(
        /app\.org_id chưa đặt/,
      );
    }
  });

  it("đổi organization_id của hàng sang tổ chức khác → bị chặn", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`update persons set organization_id = ${B.orgId} where id = ${A.ownerPersonId}`.execute(trx),
      ),
    ).rejects.toThrow();
  });
});

describe("FK ghép theo tổ chức (INV-G1)", () => {
  it("SPEC-access S-014: phòng của A không thể trỏ tầng của B kể cả khi ghi bằng owner", async () => {
    await expect(
      sql`insert into units (id, organization_id, property_id, floor_id, code)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${B.floorId}, '999')`.execute(t.admin),
    ).rejects.toThrow(/foreign key/);
  });

  it("phạm vi cơ sở không thể gắn cơ sở của tổ chức khác", async () => {
    await expect(
      sql`insert into property_scopes (id, organization_id, membership_id, property_id)
          values (${randomUUID()}, ${A.orgId}, ${A.ownerMembershipId}, ${B.propertyId})`.execute(t.admin),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("ràng buộc dữ liệu", () => {
  it("timezone phải là tên IANA (INV-G2)", async () => {
    await expect(
      sql`insert into properties (id, organization_id, name, template, timezone)
          values (${randomUUID()}, ${A.orgId}, 'X', 'rental', 'GMT+7')`.execute(t.admin),
    ).rejects.toThrow(/timezone/);
  });

  it("mã phòng trùng trong cùng cơ sở (không phân biệt hoa thường, bỏ khoảng trắng) bị từ chối", async () => {
    await expect(
      sql`insert into units (id, organization_id, property_id, floor_id, code)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ' 101 ')`.execute(t.admin),
    ).rejects.toThrow(/uq_units_code/);
  });

  it("thu hồi owner duy nhất → LAST_OWNER khi commit", async () => {
    await expect(
      withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
        sql`update memberships set status = 'revoked', revoked_at = now() where id = ${A.ownerMembershipId}`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/owner/);
  });

  it("cập nhật tăng version và updated_at (khoá lạc quan)", async () => {
    const r = await withTenant(t.runtime, { orgId: A.orgId }, (trx) =>
      sql<{
        version: number;
      }>`update units set code = '102' where id = ${A.unitId} returning version`.execute(trx),
    );
    expect(r.rows[0]?.version).toBe(2);
  });
});

describe("giới hạn thời gian theo role (DB-TX-003, TM-13)", () => {
  it("app_runtime có statement_timeout và idle_in_transaction_session_timeout", async () => {
    const r = await sql<{ s: string; i: string }>`
      select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i`.execute(
      t.runtime,
    );
    expect(r.rows[0]).toEqual({ s: "15s", i: "30s" });
  });
});

describe("migration có đường lùi (DB-MIG-009)", () => {
  it("down hết rồi up lại được trên DB riêng", async () => {
    const tmp = await createTestDb();
    try {
      await migrateDownAll(tmp.admin);
      const gone = await sql<{
        n: number;
      }>`select count(*)::int as n from pg_tables where schemaname='public' and tablename='units'`.execute(
        tmp.admin,
      );
      expect(gone.rows[0]?.n).toBe(0);
      await migrateToLatest(tmp.admin);
      const back = await sql<{
        n: number;
      }>`select count(*)::int as n from pg_tables where schemaname='public' and tablename='units'`.execute(
        tmp.admin,
      );
      expect(back.rows[0]?.n).toBe(1);
    } finally {
      await tmp.drop();
    }
  });
});
