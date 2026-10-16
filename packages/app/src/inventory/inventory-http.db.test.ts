// T-202 — lệnh/query inventory qua lớp HTTP trên Postgres thật: S-002 (gợi ý phòng), S-004, S-011, S-012 (BLOCK_CONFLICT kèm
// danh sách), S-013 (ngừng khai thác phòng có khách → RELOCATION_REQUIRED + gợi ý chuyển, không mất booking), S-022, S-023.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let deps: HttpDeps;
const users: Record<string, string> = {};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000);
const isoAt = (ms: number) => at(ms).toISOString();

// biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject/toEqual
type Json = any;

async function addMember(org: SeededOrg, role: string): Promise<string> {
  const authUser = await seedAuthUser(t.admin, `inv+${randomUUID().slice(0, 8)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${`NV ${role}`})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${org.orgId}, ${authUser}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  return authUser;
}

async function call(
  name: string,
  body: unknown,
  as: string,
  key: string = randomUUID(),
): Promise<{ status: number; body: Json }> {
  const def = COMMANDS[name];
  if (!def) throw new Error(`thiếu lệnh ${name}`);
  const res = await handleCommand(
    def,
    new Request(`http://local.test/api/v1/${name.replace(".", "/")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-test-user": users[as] as string,
        "x-test-2fa": "1",
        "x-org-id": A.orgId,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, body: await res.json() };
}

async function query(name: string, params: Record<string, string>, as: string) {
  const def = QUERIES[name];
  if (!def) throw new Error(`thiếu query ${name}`);
  const res = await handleQuery(
    def,
    new Request(`http://local.test/api/v1/${name.replace(".", "/")}?${new URLSearchParams(params)}`, {
      headers: { "x-test-user": users[as] as string, "x-test-2fa": "1", "x-org-id": A.orgId },
    }),
    deps,
  );
  return { status: res.status, body: (await res.json()) as Json };
}

async function newUnit(
  code: string,
  opts: { typeId?: string | null; availability?: "active" | "out_of_service" } = {},
): Promise<string> {
  const id = randomUUID();
  const typeId = opts.typeId === undefined ? A.roomTypeId : opts.typeId;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, availability, availability_reason)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${typeId}, ${code}, ${opts.availability ?? "active"},
                    ${opts.availability === "out_of_service" ? "sự cố" : null})`.execute(t.admin);
  return id;
}

async function alloc(
  unitId: string,
  kind: "hold" | "stay" | "lease" | "block",
  start: Date,
  end: Date | null,
  expiresAt?: Date,
): Promise<string> {
  const id = randomUUID();
  await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${unitId}, ${kind}, tstzrange(${start}, ${end}, '[)'),
                    ${expiresAt ?? null})`.execute(t.admin);
  return id;
}

async function count(q: ReturnType<typeof sql>): Promise<number> {
  const r = await sql<{ n: number }>`select count(*)::int as n from (${q}) x`.execute(t.admin);
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Inventory HTTP");
  B = await seedOrg(t.admin, "KS Khác");
  users.owner = A.ownerAuthUserId;
  users.manager = await addMember(A, "manager");
  users.front_desk = await addMember(A, "front_desk");
  users.housekeeping = await addMember(A, "housekeeping");
  users.maintenance = await addMember(A, "maintenance");
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

describe("đăng ký HTTP", () => {
  it("mọi lệnh/query inventory của T-202 có trong registry theo tên SPEC", () => {
    for (const c of [
      "createHold",
      "releaseHold",
      "confirmHold",
      "moveAllocation",
      "requestBlock",
      "approveBlock",
      "setUnitAvailability",
    ]) {
      expect(COMMANDS[`inventory.${c}`]?.command).toBe(`inventory.${c}`);
    }
    expect(QUERIES["inventory.getCalendar"]).toBeDefined();
    expect(QUERIES["inventory.getUnitStatus"]).toBeDefined();
  });
});

describe("S-001/S-002/S-004 giữ phòng qua HTTP", () => {
  it("S-001 giữ phòng → 201, TTL mặc định theo cơ sở (15 phút); gửi lại cùng Idempotency-Key trả cùng allocation", async () => {
    const key = randomUUID();
    const before = Date.now();
    const body = { unit_id: A.unitId, start: isoAt(10 * DAY), end: isoAt(11 * DAY) };
    const r1 = await call("inventory.createHold", body, "front_desk", key);
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe("committed");
    const exp = Date.parse(r1.body.data.expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const r2 = await call("inventory.createHold", body, "front_desk", key);
    expect(r2.body.data.allocation_id).toBe(r1.body.data.allocation_id);
    expect(await count(sql`select 1 from allocations where unit_id = ${A.unitId} and active`)).toBe(1);
    await call(
      "inventory.releaseHold",
      { allocation_id: r1.body.data.allocation_id, reason: "dọn" },
      "front_desk",
    );
  });

  it("S-002 chồng lấn → 409 ROOM_UNAVAILABLE kèm phòng CÙNG LOẠI còn trống (bỏ phòng bận, phòng ngừng khai thác, loại khác)", async () => {
    const free = await newUnit("A-free");
    const busy = await newUnit("A-busy");
    await newUnit("A-oos", { availability: "out_of_service" });
    const otherType = randomUUID();
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
              values (${otherType}, ${A.orgId}, ${A.propertyId}, 'OTH', 'Loại khác', 4)`.execute(t.admin);
    await newUnit("A-other", { typeId: otherType });
    const src = await newUnit("A-src");
    await alloc(src, "stay", at(20 * DAY), at(22 * DAY));
    await alloc(busy, "hold", at(21 * DAY + HOUR), at(22 * DAY), at(30 * DAY));
    const r = await call(
      "inventory.createHold",
      { unit_id: src, start: isoAt(21 * DAY), end: isoAt(23 * DAY) },
      "front_desk",
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ROOM_UNAVAILABLE");
    expect(r.body.alternatives.map((a: { code: string }) => a.code)).toEqual(
      expect.arrayContaining(["A-free"]),
    );
    const codes: string[] = r.body.alternatives.map((a: { code: string }) => a.code);
    expect(codes).not.toContain("A-busy");
    expect(codes).not.toContain("A-oos");
    expect(codes).not.toContain("A-other");
    expect(codes).not.toContain("A-src");
    expect(r.body.alternatives.find((a: { code: string }) => a.code === "A-free").unit_id).toBe(free);
    expect(await count(sql`select 1 from allocations where unit_id = ${src} and active`)).toBe(1);
  });

  it.each([
    ["end null (hold phải có điểm cuối)", { start: isoAt(30 * DAY), end: null }],
    ["thiếu end", { start: isoAt(30 * DAY) }],
    ["end = start", { start: isoAt(30 * DAY), end: isoAt(30 * DAY) }],
    ["end < start", { start: isoAt(31 * DAY), end: isoAt(30 * DAY) }],
    ["thiếu start", { end: isoAt(30 * DAY) }],
    ["ttl 0", { start: isoAt(30 * DAY), end: isoAt(31 * DAY), ttl_minutes: 0 }],
    [
      "khách gắn nguồn lease (không được phép qua HTTP)",
      { start: isoAt(30 * DAY), end: null, source_type: "lease" },
    ],
  ])("S-004 %s → 422 VALIDATION_FAILED, không tạo allocation", async (_n, extra) => {
    const unit = await newUnit(`V-${randomUUID().slice(0, 6)}`);
    const r = await call("inventory.createHold", { unit_id: unit, ...extra }, "front_desk");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("VALIDATION_FAILED");
    expect(await count(sql`select 1 from allocations where unit_id = ${unit}`)).toBe(0);
  });

  it("S-022 chéo tenant: giữ phòng của tổ chức khác → 404 NOT_FOUND, không allocation nào được tạo", async () => {
    const r = await call(
      "inventory.createHold",
      { unit_id: B.unitId, start: isoAt(40 * DAY), end: isoAt(41 * DAY) },
      "owner",
    );
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
    expect(await count(sql`select 1 from allocations where unit_id = ${B.unitId}`)).toBe(0);
  });

  it("vai trò không có quyền giữ phòng (buồng phòng) → 403 FORBIDDEN", async () => {
    const r = await call(
      "inventory.createHold",
      { unit_id: A.unitId, start: isoAt(50 * DAY), end: isoAt(51 * DAY) },
      "housekeeping",
    );
    expect(r.status).toBe(403);
  });

  it("confirmHold chỉ nhận kind=stay qua HTTP (hợp đồng đi qua lease.*); xác nhận hold → stay, bỏ expires_at", async () => {
    const unit = await newUnit("C-1");
    const h = await call(
      "inventory.createHold",
      { unit_id: unit, start: isoAt(60 * DAY), end: isoAt(61 * DAY) },
      "front_desk",
    );
    const bad = await call(
      "inventory.confirmHold",
      { allocation_id: h.body.data.allocation_id, kind: "lease" },
      "owner",
    );
    expect(bad.status).toBe(422);
    const ok = await call(
      "inventory.confirmHold",
      { allocation_id: h.body.data.allocation_id, kind: "stay" },
      "front_desk",
    );
    expect(ok.status).toBe(200);
    const row = await sql<{
      kind: string;
      expires_at: Date | null;
    }>`select kind, expires_at from allocations where id = ${h.body.data.allocation_id}`.execute(t.admin);
    expect(row.rows[0]).toMatchObject({ kind: "stay", expires_at: null });
  });

  it("releaseHold cần lý do; nhả hai lần: lần hai released=false, chỉ một audit", async () => {
    const unit = await newUnit("R-1");
    const h = await call(
      "inventory.createHold",
      { unit_id: unit, start: isoAt(70 * DAY), end: isoAt(71 * DAY) },
      "front_desk",
    );
    const id = h.body.data.allocation_id;
    expect(
      (await call("inventory.releaseHold", { allocation_id: id, reason: " " }, "front_desk")).status,
    ).toBe(422);
    expect(
      (await call("inventory.releaseHold", { allocation_id: id, reason: "khách đổi ý" }, "front_desk")).body
        .data,
    ).toEqual({
      released: true,
    });
    expect(
      (await call("inventory.releaseHold", { allocation_id: id, reason: "khách đổi ý" }, "front_desk")).body
        .data,
    ).toEqual({
      released: false,
    });
    expect(
      await count(
        sql`select 1 from audit_events where entity_id = ${id} and action = 'allocation.released' and reason = 'khách đổi ý'`,
      ),
    ).toBe(1);
  });
});

describe("S-011/S-012 block", () => {
  it("S-011 kỹ thuật đề xuất (201), kỹ thuật tự duyệt → 403, quản lý duyệt → phòng không giữ được nữa", async () => {
    const unit = await newUnit("B-1");
    const req = await call(
      "inventory.requestBlock",
      { unit_id: unit, start: isoAt(5 * DAY), end: isoAt(7 * DAY), reason: "Thay bình nóng lạnh" },
      "maintenance",
    );
    expect(req.status).toBe(201);
    const blockId = req.body.data.block_id;
    expect(await count(sql`select 1 from allocations where unit_id = ${unit}`)).toBe(0); // chưa có allocation
    expect((await call("inventory.approveBlock", { block_id: blockId }, "maintenance")).status).toBe(403);
    const ok = await call("inventory.approveBlock", { block_id: blockId, note: "ok" }, "manager");
    expect(ok.status).toBe(200);
    expect(ok.body.data.block_id).toBe(blockId);
    expect(
      await count(
        sql`select 1 from allocations where id = ${ok.body.data.allocation_id} and kind = 'block' and active`,
      ),
    ).toBe(1);
    const hold = await call(
      "inventory.createHold",
      { unit_id: unit, start: isoAt(6 * DAY), end: isoAt(8 * DAY) },
      "front_desk",
    );
    expect(hold.status).toBe(409);
    expect(hold.body.code).toBe("ROOM_UNAVAILABLE");
  });

  it("requestBlock: end ≤ start hoặc thiếu lý do → 422", async () => {
    const unit = await newUnit("B-2");
    const bad = await call(
      "inventory.requestBlock",
      { unit_id: unit, start: isoAt(5 * DAY), end: isoAt(5 * DAY), reason: "x" },
      "maintenance",
    );
    expect(bad.status).toBe(422);
    const noReason = await call(
      "inventory.requestBlock",
      { unit_id: unit, start: isoAt(5 * DAY), end: isoAt(6 * DAY), reason: "  " },
      "maintenance",
    );
    expect(noReason.status).toBe(422);
  });

  it("S-012 block đụng khách đã xác nhận → 409 BLOCK_CONFLICT kèm danh sách xung đột; block vẫn requested; không chèn một phần", async () => {
    const unit = await newUnit("B-3");
    const stayId = await alloc(unit, "stay", at(8 * DAY), at(9 * DAY));
    const expiredHold = await alloc(unit, "hold", at(2 * DAY), at(3 * DAY), at(-HOUR)); // hết hạn chưa nhả: không phải xung đột
    const req = await call(
      "inventory.requestBlock",
      { unit_id: unit, start: isoAt(2 * DAY - HOUR), end: isoAt(10 * DAY), reason: "Sửa sàn" },
      "maintenance",
    );
    const blockId = req.body.data.block_id;
    const r = await call("inventory.approveBlock", { block_id: blockId }, "manager");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("BLOCK_CONFLICT");
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ allocation_id: stayId, kind: "stay" });
    expect(r.body.items.map((i: { allocation_id: string }) => i.allocation_id)).not.toContain(expiredHold);
    const b = await sql<{ status: string }>`select status from blocks where id = ${blockId}`.execute(t.admin);
    expect(b.rows[0]?.status).toBe("requested");
    expect(await count(sql`select 1 from allocations where kind = 'block' and unit_id = ${unit}`)).toBe(0);
    // Hold hết hạn chưa nhả KHÔNG chặn block (INV-I3): bỏ khách đụng thì duyệt được, hold cũ được nhả.
    await sql`update allocations set active = false, deactivated_at = now(), deactivated_reason = 'cancelled' where id = ${stayId}`.execute(
      t.admin,
    );
    const ok = await call("inventory.approveBlock", { block_id: blockId }, "manager");
    expect(ok.status).toBe(200);
    const h = await sql<{
      active: boolean;
      deactivated_reason: string | null;
    }>`select active, deactivated_reason from allocations where id = ${expiredHold}`.execute(t.admin);
    expect(h.rows[0]).toMatchObject({ active: false, deactivated_reason: "expired" });
  });
});

describe("S-013 ngừng khai thác phòng có khách sắp đến", () => {
  it("không mất booking; mỗi allocation tương lai có RELOCATION_REQUIRED + phòng cùng loại để chuyển; chuyển xong thì đóng yêu cầu", async () => {
    const r1 = await newUnit("S13-R1");
    const r2 = await newUnit("S13-R2"); // trống
    const r3 = await newUnit("S13-R3"); // bận đúng khoảng của lượt ở thứ nhất
    const s1Start = at(2 * HOUR);
    const s1 = await alloc(r1, "stay", s1Start, at(26 * HOUR)); // sắp đến hôm nay
    const s2 = await alloc(r1, "stay", at(3 * DAY), at(5 * DAY));
    await alloc(r3, "stay", at(HOUR), at(30 * HOUR));
    await alloc(r1, "stay", at(-3 * DAY), at(-2 * DAY)); // đã qua: không cần tái bố trí
    await alloc(r1, "hold", at(7 * DAY), at(8 * DAY), at(-HOUR)); // hold hết hạn chưa nhả: không phải khách
    await alloc(r1, "block", at(9 * DAY), at(10 * DAY));

    // Quyền: lễ tân/buồng phòng không được; thiếu lý do → 422; unit không đổi
    for (const who of ["front_desk", "housekeeping"]) {
      const denied = await call(
        "inventory.setUnitAvailability",
        { unit_id: r1, availability: "out_of_service", reason: "Rò nước" },
        who,
      );
      expect(denied.status).toBe(403);
    }
    const noReason = await call(
      "inventory.setUnitAvailability",
      { unit_id: r1, availability: "out_of_service" },
      "manager",
    );
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe("VALIDATION_FAILED");
    expect(await count(sql`select 1 from units where id = ${r1} and availability = 'out_of_service'`)).toBe(
      0,
    );

    const key = randomUUID();
    const set = await call(
      "inventory.setUnitAvailability",
      { unit_id: r1, availability: "out_of_service", reason: "Rò nước" },
      "manager",
      key,
    );
    expect(set.status).toBe(200);
    const rel: { allocation_id: string; exception_id: string; alternatives: { code: string }[] }[] =
      set.body.data.relocations;
    expect(rel.map((x) => x.allocation_id)).toEqual([s1, s2]);
    expect(set.body.data.exception_ids).toEqual(rel.map((x) => x.exception_id));
    expect(rel[0]?.alternatives.map((a) => a.code)).toContain("S13-R2");
    expect(rel[0]?.alternatives.map((a) => a.code)).not.toContain("S13-R3"); // bận đúng khoảng đó
    expect(rel[1]?.alternatives.map((a) => a.code)).toEqual(expect.arrayContaining(["S13-R2", "S13-R3"]));
    expect(rel.every((x) => !x.alternatives.some((a) => a.code === "S13-R1"))).toBe(true);

    // booking không bị xoá/huỷ; có đúng 2 ngoại lệ mở; audit có trước/sau
    expect(
      await count(
        sql`select 1 from allocations where unit_id = ${r1} and kind = 'stay' and active and upper(during) > now()`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`select 1 from exceptions where type = 'RELOCATION_REQUIRED' and status = 'open' and allocation_id in (${s1}, ${s2})`,
      ),
    ).toBe(2);
    const audit = await sql<{
      before: Json;
      after: Json;
      reason: string;
    }>`select before, after, reason from audit_events where entity_id = ${r1} and action = 'unit.availability_changed'`.execute(
      t.admin,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      before: { availability: "active" },
      after: { availability: "out_of_service", exception_count: 2 },
      reason: "Rò nước",
    });

    // Gửi lại (key mới): không thêm ngoại lệ, không thêm audit; cùng exception_ids
    const again = await call(
      "inventory.setUnitAvailability",
      { unit_id: r1, availability: "out_of_service", reason: "Rò nước" },
      "manager",
    );
    expect(again.body.data.exception_ids).toEqual(set.body.data.exception_ids);
    expect(
      await count(
        sql`select 1 from exceptions where type = 'RELOCATION_REQUIRED' and allocation_id in (${s1}, ${s2})`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`select 1 from audit_events where entity_id = ${r1} and action = 'unit.availability_changed'`,
      ),
    ).toBe(1);

    // Mọi giữ chỗ/chuyển vào phòng ngừng khai thác → 409 UNIT_OUT_OF_SERVICE
    const hold = await call(
      "inventory.createHold",
      { unit_id: r1, start: isoAt(20 * DAY), end: isoAt(21 * DAY) },
      "front_desk",
    );
    expect(hold.status).toBe(409);
    expect(hold.body.code).toBe("UNIT_OUT_OF_SERVICE");
    const s3 = await alloc(r2, "stay", at(40 * DAY), at(41 * DAY));
    const into = await call(
      "inventory.moveAllocation",
      { allocation_id: s3, to_unit_id: r1, effective_at: isoAt(40 * DAY), reason: "thử" },
      "front_desk",
    );
    expect(into.status).toBe(409);
    expect(into.body.code).toBe("UNIT_OUT_OF_SERVICE");

    // Chuyển khách sang phòng gợi ý → ngoại lệ của allocation đó được đóng (resolution = moved)
    const mv = await call(
      "inventory.moveAllocation",
      { allocation_id: s1, to_unit_id: r2, effective_at: s1Start.toISOString(), reason: "Phòng gặp sự cố" },
      "front_desk",
    );
    expect(mv.status).toBe(200);
    expect(mv.body.data.old_allocation_id).toBe(s1);
    const ex = await sql<{
      allocation_id: string;
      status: string;
      resolution: string | null;
    }>`select allocation_id, status, resolution from exceptions where allocation_id in (${s1}, ${s2}) order by allocation_id`.execute(
      t.admin,
    );
    expect(ex.rows.find((e) => e.allocation_id === s1)).toMatchObject({
      status: "resolved",
      resolution: "moved",
    });
    expect(ex.rows.find((e) => e.allocation_id === s2)).toMatchObject({ status: "open" });
    expect(
      await count(
        sql`select 1 from allocations where id = ${mv.body.data.new_allocation_id} and unit_id = ${r2} and active`,
      ),
    ).toBe(1);

    // Bật lại: ngoại lệ còn lại tự đóng; phòng giữ được lại
    const back = await call(
      "inventory.setUnitAvailability",
      { unit_id: r1, availability: "active" },
      "manager",
    );
    expect(back.status).toBe(200);
    expect(back.body.data.exception_ids).toEqual([]);
    expect(
      await count(
        sql`select 1 from exceptions where allocation_id = ${s2} and status = 'resolved' and resolution = 'unit_restored'`,
      ),
    ).toBe(1);
    const reHold = await call(
      "inventory.createHold",
      { unit_id: r1, start: isoAt(20 * DAY), end: isoAt(21 * DAY) },
      "front_desk",
    );
    expect(reHold.status).toBe(201);
  });

  it("S-013 phòng không có khách tương lai → không ngoại lệ; phòng của tổ chức khác → 404", async () => {
    const empty = await newUnit("S13-empty");
    const r = await call(
      "inventory.setUnitAvailability",
      { unit_id: empty, availability: "out_of_service", reason: "Sơn lại" },
      "manager",
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ exception_ids: [], relocations: [] });
    const other = await call(
      "inventory.setUnitAvailability",
      { unit_id: B.unitId, availability: "out_of_service", reason: "x" },
      "owner",
    );
    expect(other.status).toBe(404);
    expect(
      await count(sql`select 1 from units where id = ${B.unitId} and availability = 'out_of_service'`),
    ).toBe(0);
  });
});

describe("query lịch qua HTTP", () => {
  it("GET inventory/getCalendar trả phòng + đoạn; tham số lạ, khoảng quá dài → 422; ngoài phạm vi → 404", async () => {
    const ok = await query(
      "inventory.getCalendar",
      {
        property_id: A.propertyId,
        from: new Date().toISOString().slice(0, 10),
        to: isoAt(5 * DAY).slice(0, 10),
        limit: "3",
      },
      "front_desk",
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data.rooms.length).toBeLessThanOrEqual(3);
    expect(ok.body.data.next_cursor).toEqual(expect.any(String));
    const long = await query(
      "inventory.getCalendar",
      { property_id: A.propertyId, from: "2026-01-01", to: "2026-06-01" },
      "front_desk",
    );
    expect(long.status).toBe(422);
    expect(long.body.code).toBe("VALIDATION_FAILED");
    const extra = await query(
      "inventory.getCalendar",
      { property_id: A.propertyId, from: "2026-10-01", to: "2026-10-02", x: "1" },
      "front_desk",
    );
    expect(extra.status).toBe(422);
    const foreign = await query(
      "inventory.getCalendar",
      { property_id: B.propertyId, from: "2026-10-01", to: "2026-10-02" },
      "owner",
    );
    expect(foreign.status).toBe(404);
  });

  it("GET inventory/getUnitStatus: phòng trống sạch → sellable + ready_for_arrival; tham số at sai → 422", async () => {
    const unit = await newUnit("Q-1");
    const ok = await query("inventory.getUnitStatus", { unit_id: unit }, "housekeeping");
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ occupancy: "vacant", sellable: true, ready_for_arrival: true });
    const bad = await query("inventory.getUnitStatus", { unit_id: unit, at: "hôm qua" }, "housekeeping");
    expect(bad.status).toBe(422);
  });
});
