// PLAN đợt 3 T-212 — phiếu sự cố trên Postgres thật + object storage thật (SPEC-housekeeping-maintenance S-012, S-014,
// S-015, S-018, S-019, S-021, S-022).
import { randomUUID } from "node:crypto";
import { seedLease, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { uploadFile } from "../files/files.ts";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { endBlock } from "../inventory/inventory.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import {
  approveBlock,
  assignWorkOrder,
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  listMyWorkOrders,
  listWorkOrders,
  proposeWorkOrderBlock,
  startWorkOrder,
  verifyWorkOrder,
  WORK_ORDER_FIELDS,
} from "./work-orders.ts";

let h: Hotel;
let storage: ObjectStorage;
let tech: Actor;
let tech2: Actor;
let tenant: Actor;
let tenantUnit: string;

const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
function seg(marker: number, payload: Uint8Array): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
/** JPEG tối thiểu hợp lệ cho bộ nhận dạng (giống files.db.test). */
function jpeg(extra = ""): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xda, ascii("\x01\x01\0\0?\0")),
    ...ascii(extra),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  tech = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật K" });
  tech2 = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật K2" });
  tenant = await seedMember(h.t, h.org, "tenant", { name: "Người thuê T" });
  const lease = await seedLease(h.t.admin, {
    orgId: h.org.orgId,
    propertyId: h.org.propertyId,
    representativePersonId: tenant.personId as string,
    effectiveFrom: "2026-09-01",
  });
  tenantUnit = lease.unitId;
  await h.t.admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}'
              where lease_id = ${lease.leaseId}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${lease.leaseId}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${lease.leaseId}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${lease.leaseId}, 'move_in', '2026-09-01',
                      ${h.org.ownerMembershipId}, now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${lease.leaseId}`.execute(trx);
  });
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function unit(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`5${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return id;
}

async function photo(actor: Actor, bytes = jpeg()): Promise<{ fileId: string; status: string }> {
  return okAs(h.t, actor, (ctx) =>
    uploadFile(
      ctx,
      { storage, scanner: eicarOnlyScanner },
      { ownerType: "work_order", propertyId: h.org.propertyId, bytes },
    ),
  );
}

const create = (actor: Actor, unitId: string, extra: { fileIds?: string[] } = {}) =>
  runAs(h.t, actor, (ctx) =>
    createWorkOrder(ctx, {
      unitId,
      title: "Rò nước bồn rửa",
      description: "Nước rỉ dưới chậu rửa",
      severity: "high",
      ...extra,
    }),
  );
const as = <T>(actor: Actor, fn: (ctx: CommandContext) => Promise<T>) => okAs(h.t, actor, fn);

async function fileOwner(fileId: string): Promise<string | null> {
  const r = await sql<{
    owner_id: string | null;
  }>`select owner_id from files where id = ${fileId}`.execute(h.t.admin);
  return r.rows[0]?.owner_id ?? null;
}

describe("S-012 tạo phiếu có ảnh đã quét", () => {
  it("ảnh ready gắn vào phiếu; phiếu open, nguồn staff; audit + outbox", async () => {
    const u = await unit();
    const p = await photo(h.housekeeping);
    expect(p.status).toBe("ready");
    const r = await create(h.housekeeping, u, { fileIds: [p.fileId] });
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.attachedFileIds).toEqual([p.fileId]);
    expect(r.data.rejectedFileIds).toEqual([]);
    expect(await fileOwner(p.fileId)).toBe(r.data.workOrderId);
    const w = await sql<{ status: string; source: string; reporter_membership_id: string }>`
      select status, source, reporter_membership_id from work_orders where id = ${r.data.workOrderId}`.execute(
      h.t.admin,
    );
    expect(w.rows[0]).toEqual({
      status: "open",
      source: "staff",
      reporter_membership_id: h.housekeeping.membershipId,
    });
    const ev = await sql<{ n: number }>`
      select count(*)::int as n from outbox where aggregate_id = ${r.data.workOrderId} and event_type = 'work_order.created'`.execute(
      h.t.admin,
    );
    expect(ev.rows[0]?.n).toBe(1);
  });

  it("ảnh do người khác tải không gắn được (báo lại trong rejected)", async () => {
    const u = await unit();
    const p = await photo(h.frontDesk);
    const r = await create(h.housekeeping, u, { fileIds: [p.fileId] });
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.rejectedFileIds).toEqual([p.fileId]);
    expect(await fileOwner(p.fileId)).toBeNull();
  });

  it("kế toán không tạo phiếu → 403; tiêu đề rỗng → 422", async () => {
    const u = await unit();
    expect(await codeOf(create(h.accountant, u))).toBe("FORBIDDEN");
    expect(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) =>
          createWorkOrder(ctx, { unitId: u, title: "  ", description: "x", severity: "low" }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("S-014 tối đa 5 ảnh", () => {
  it("6 ảnh → 422, không tạo phiếu, không gắn ảnh nào", async () => {
    const u = await unit();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await photo(h.housekeeping)).fileId);
    const r = await create(h.housekeeping, u, { fileIds: ids });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.problem.code).toBe("VALIDATION_FAILED");
      expect(r.problem.errors?.map((e) => e.path)).toEqual(["file_ids"]);
    }
    for (const id of ids) expect(await fileOwner(id)).toBeNull();
    const n = await sql<{ n: number }>`
      select count(*)::int as n from work_orders where unit_id = ${u}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(0);
  });

  it("đủ 5 ảnh lúc tạo → hoàn thành thêm 1 ảnh → 422", async () => {
    const u = await unit();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await photo(h.manager)).fileId);
    const r = await create(h.manager, u, { fileIds: ids });
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.attachedFileIds).toHaveLength(5);
    const id = r.data.workOrderId;
    await as(h.manager, (ctx) =>
      assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: h.manager.membershipId }),
    );
    await as(h.manager, (ctx) => startWorkOrder(ctx, { workOrderId: id }));
    const extra = await photo(h.manager);
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) => completeWorkOrder(ctx, { workOrderId: id, fileIds: [extra.fileId] })),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("S-015 ảnh nhiễm mã độc", () => {
  it("EICAR → file rejected, không gắn vào phiếu, phiếu vẫn tạo và báo lại", async () => {
    const u = await unit();
    const bad = await photo(h.housekeeping, jpeg(EICAR));
    expect(bad.status).toBe("rejected");
    const good = await photo(h.housekeeping);
    const r = await create(h.housekeeping, u, { fileIds: [bad.fileId, good.fileId] });
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.attachedFileIds).toEqual([good.fileId]);
    expect(r.data.rejectedFileIds).toEqual([bad.fileId]);
    expect(await fileOwner(bad.fileId)).toBeNull();
    const list = await listWorkOrders(h.t.runtime, h.manager, { propertyId: h.org.propertyId });
    expect(list.find((w) => w.id === r.data.workOrderId)?.photoFileIds).toEqual([good.fileId]);
  });
});

async function openWorkOrder(unitId: string): Promise<string> {
  const r = await create(h.housekeeping, unitId);
  if (r.status !== "committed") throw new Error(JSON.stringify(r));
  return r.data.workOrderId;
}

describe("S-018 kỹ thuật đề xuất block", () => {
  it("block requested gắn phiếu; kỹ thuật duyệt → 403; quản lý duyệt → approved + allocation block", async () => {
    const u = await unit();
    const id = await openWorkOrder(u);
    await as(h.manager, (ctx) =>
      assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: tech.membershipId }),
    );
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 2 * 86_400_000);
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, { workOrderId: id, start, end, reason: "Thay ống nước" }),
    );
    const b = await sql<{ status: string; work_order_id: string }>`
      select status, work_order_id from blocks where id = ${blockId}`.execute(h.t.admin);
    expect(b.rows[0]).toEqual({ status: "requested", work_order_id: id });
    expect(await codeOf(runAs(h.t, tech, (ctx) => approveBlock(ctx, blockId)))).toBe("FORBIDDEN");
    await as(h.manager, (ctx) => approveBlock(ctx, blockId));
    const a = await sql<{ n: number }>`
      select count(*)::int as n from allocations where source_id = ${blockId} and kind = 'block' and active`.execute(
      h.t.admin,
    );
    expect(a.rows[0]?.n).toBe(1);
    const w = await sql<{
      block_id: string;
    }>`select block_id from work_orders where id = ${id}`.execute(h.t.admin);
    expect(w.rows[0]?.block_id).toBe(blockId);
  });

  it("lễ tân/buồng phòng không giao hay huỷ phiếu → 403; kỹ thuật không tự giao/huỷ → 403", async () => {
    const id = await openWorkOrder(await unit());
    const assign = (a: Actor) =>
      codeOf(
        runAs(h.t, a, (ctx) =>
          assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: tech.membershipId }),
        ),
      );
    expect(await assign(h.frontDesk)).toBe("FORBIDDEN");
    expect(await assign(h.housekeeping)).toBe("FORBIDDEN");
    expect(await assign(tech)).toBe("FORBIDDEN");
    expect(
      await codeOf(runAs(h.t, tech, (ctx) => cancelWorkOrder(ctx, { workOrderId: id, reason: "x" }))),
    ).toBe("FORBIDDEN");
  });
});

describe("S-019 hoàn thành và nghiệm thu", () => {
  it("K xong; K kết thúc block → 403; người khác được giao không bắt đầu được; quản lý nghiệm thu → block ended + việc dọn open", async () => {
    const u = await unit();
    const id = await openWorkOrder(u);
    await as(h.manager, (ctx) =>
      assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: tech.membershipId }),
    );
    expect(await codeOf(runAs(h.t, tech2, (ctx) => startWorkOrder(ctx, { workOrderId: id })))).toBe(
      "FORBIDDEN",
    );
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, {
        workOrderId: id,
        start: new Date(Date.now() - 3_600_000),
        end: new Date(Date.now() + 2 * 86_400_000),
        reason: "Chống thấm",
      }),
    );
    await as(h.manager, (ctx) => approveBlock(ctx, blockId));
    await as(tech, (ctx) => startWorkOrder(ctx, { workOrderId: id }));
    const after = await photo(tech);
    const done = await as(tech, (ctx) =>
      completeWorkOrder(ctx, { workOrderId: id, note: "Đã thay ống", fileIds: [after.fileId] }),
    );
    expect(done.status).toBe("done");
    expect(await codeOf(runAs(h.t, tech, (ctx) => endBlock(ctx, blockId)))).toBe("FORBIDDEN");
    expect(await codeOf(runAs(h.t, tech, (ctx) => verifyWorkOrder(ctx, { workOrderId: id })))).toBe(
      "FORBIDDEN",
    );
    // Phòng vẫn bị chặn tới khi nghiệm thu.
    const blocked = await sql<{ status: string }>`select status from blocks where id = ${blockId}`.execute(
      h.t.admin,
    );
    expect(blocked.rows[0]?.status).toBe("approved");
    const v = await as(h.manager, (ctx) => verifyWorkOrder(ctx, { workOrderId: id }));
    expect(v).toMatchObject({ status: "verified", blockEnded: true });
    const b = await sql<{ status: string }>`select status from blocks where id = ${blockId}`.execute(
      h.t.admin,
    );
    expect(b.rows[0]?.status).toBe("ended");
    const al = await sql<{ active: boolean; open_end: boolean }>`
      select active, upper(during) < now() + interval '1 minute' as open_end from allocations
      where source_id = ${blockId} and kind = 'block'`.execute(h.t.admin);
    expect(al.rows).toEqual([{ active: false, open_end: true }]);
    const task = await sql<{ status: string; source_type: string; unit_id: string }>`
      select status, source_type, unit_id from tasks where id = ${v.cleaningTaskId}`.execute(h.t.admin);
    expect(task.rows[0]).toEqual({ status: "open", source_type: "work_order", unit_id: u });
    const w = await sql<{ status: string; verified_by: string; resolution_note: string }>`
      select status, verified_by, resolution_note from work_orders where id = ${id}`.execute(h.t.admin);
    expect(w.rows[0]).toEqual({
      status: "verified",
      verified_by: h.manager.membershipId,
      resolution_note: "Đã thay ống",
    });
    // Phiếu đã kết thúc: CSDL chặn đổi tiếp.
    await expect(
      sql`update work_orders set status = 'assigned' where id = ${id}`.execute(h.t.admin),
    ).rejects.toThrow(/đã kết thúc/);
  });

  it("người làm tự nghiệm thu → SELF_APPROVAL_FORBIDDEN; nghiệm thu khi chưa xong → INVALID_TRANSITION", async () => {
    const id = await openWorkOrder(await unit());
    await as(h.manager, (ctx) =>
      assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: h.manager.membershipId }),
    );
    expect(await codeOf(runAs(h.t, h.owner, (ctx) => verifyWorkOrder(ctx, { workOrderId: id })))).toBe(
      "INVALID_TRANSITION",
    );
    await as(h.manager, (ctx) => startWorkOrder(ctx, { workOrderId: id }));
    await as(h.manager, (ctx) => completeWorkOrder(ctx, { workOrderId: id }));
    expect(await codeOf(runAs(h.t, h.manager, (ctx) => verifyWorkOrder(ctx, { workOrderId: id })))).toBe(
      "SELF_APPROVAL_FORBIDDEN",
    );
    const v = await as(h.owner, (ctx) => verifyWorkOrder(ctx, { workOrderId: id }));
    expect(v).toMatchObject({ status: "verified", blockEnded: false });
  });

  it("huỷ cần lý do; phiếu đã huỷ không giao lại", async () => {
    const id = await openWorkOrder(await unit());
    expect(
      await codeOf(runAs(h.t, h.manager, (ctx) => cancelWorkOrder(ctx, { workOrderId: id, reason: " " }))),
    ).toBe("VALIDATION_FAILED");
    await as(h.manager, (ctx) => cancelWorkOrder(ctx, { workOrderId: id, reason: "Báo nhầm phòng" }));
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: tech.membershipId }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });
});

describe("S-021 người thuê báo sự cố", () => {
  it("phòng của hợp đồng mình → tạo, nguồn tenant; phòng khác → 404; không xem/không xử lý phiếu", async () => {
    const r = await create(tenant, tenantUnit);
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    const w = await sql<{
      source: string;
      reporter_person_id: string;
      reporter_membership_id: string | null;
    }>`
      select source, reporter_person_id, reporter_membership_id from work_orders where id = ${r.data.workOrderId}`.execute(
      h.t.admin,
    );
    expect(w.rows[0]).toEqual({
      source: "tenant",
      reporter_person_id: tenant.personId,
      reporter_membership_id: null,
    });
    expect(await codeOf(create(tenant, h.units.r202))).toBe("NOT_FOUND");
    expect(
      await codeOf(
        runAs(h.t, tenant, (ctx) => cancelWorkOrder(ctx, { workOrderId: r.data.workOrderId, reason: "x" })),
      ),
    ).toBe("NOT_FOUND");
    await expect(listWorkOrders(h.t.runtime, tenant, { propertyId: h.org.propertyId })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    const mine = await listMyWorkOrders(h.t.runtime, tenant);
    expect(mine.map((x) => x.id)).toEqual([r.data.workOrderId]);
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual(
      ["createdAt", "doneAt", "id", "severity", "status", "title", "unitCode", "verifiedAt"].sort(),
    );
    // Phiếu nhân viên báo trên cùng phòng không hiện cho người thuê (RLS).
    await openWorkOrder(tenantUnit);
    expect((await listMyWorkOrders(h.t.runtime, tenant)).map((x) => x.id)).toEqual([r.data.workOrderId]);
    await expect(listMyWorkOrders(h.t.runtime, h.manager)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S-022 cách ly tổ chức + danh sách", () => {
  it("tổ chức khác: tạo/giao/danh sách → 404", async () => {
    const id = await openWorkOrder(await unit());
    expect(await codeOf(create(h.ownerOther, h.units.r201))).toBe("NOT_FOUND");
    expect(
      await codeOf(
        runAs(h.t, h.ownerOther, (ctx) =>
          assignWorkOrder(ctx, { workOrderId: id, assigneeMembershipId: h.ownerOther.membershipId }),
        ),
      ),
    ).toBe("NOT_FOUND");
    await expect(
      listWorkOrders(h.t.runtime, h.ownerOther, { propertyId: h.org.propertyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("chỉ trường cho phép; nghiêm trọng lên đầu; mine = phiếu giao cho mình; giao cho người ngoài cơ sở → 422", async () => {
    const u = await unit();
    const low = await runAs(h.t, h.housekeeping, (ctx) =>
      createWorkOrder(ctx, { unitId: u, title: "Bóng đèn", description: "Cháy bóng", severity: "low" }),
    );
    const crit = await runAs(h.t, h.housekeeping, (ctx) =>
      createWorkOrder(ctx, {
        unitId: u,
        title: "Chập điện",
        description: "Ổ cắm khét",
        severity: "critical",
      }),
    );
    if (low.status !== "committed" || crit.status !== "committed") throw new Error("create");
    await as(h.manager, (ctx) =>
      assignWorkOrder(ctx, { workOrderId: crit.data.workOrderId, assigneeMembershipId: tech2.membershipId }),
    );
    const list = await listWorkOrders(h.t.runtime, tech2, { propertyId: h.org.propertyId });
    expect(list[0]?.severity).toBe("critical");
    expect(Object.keys(list[0] ?? {}).sort()).toEqual([...WORK_ORDER_FIELDS].sort());
    const mine = await listWorkOrders(h.t.runtime, tech2, { propertyId: h.org.propertyId, mine: true });
    expect(mine.map((w) => w.id)).toEqual([crit.data.workOrderId]);
    expect(
      await codeOf(
        runAs(h.t, h.manager, (ctx) =>
          assignWorkOrder(ctx, {
            workOrderId: low.data.workOrderId,
            assigneeMembershipId: h.frontDesk.membershipId,
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});
