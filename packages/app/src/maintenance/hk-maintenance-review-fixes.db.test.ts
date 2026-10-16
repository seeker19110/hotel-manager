// Hồi quy review lát buồng phòng/sự cố (T-211, T-212) trên Postgres thật — mỗi test là đúng đường lỗi reviewer tái hiện.
import { randomUUID } from "node:crypto";
import { seedLease } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import {
  assignTask,
  cancelTask,
  completeTask,
  createCleaningTask,
  startTask,
  verifyTask,
} from "../housekeeping/tasks.ts";
import { approveBlock, endBlock, getUnitStatus } from "../inventory/inventory.ts";
import type { CommandContext } from "../pipeline/command.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import {
  assignWorkOrder,
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  proposeWorkOrderBlock,
  startWorkOrder,
  verifyWorkOrder,
} from "./work-orders.ts";

let h: Hotel;
let tech: Actor;
const as = <T>(a: Actor, fn: (ctx: CommandContext) => Promise<T>) => okAs(h.t, a, fn);
const DAY = 86_400_000;

beforeAll(async () => {
  h = await seedHotel();
  tech = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật K" });
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function unit(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`8${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return id;
}
const hs = async (u: string) =>
  (await sql<{ s: string }>`select housekeeping_status as s from units where id = ${u}`.execute(h.t.admin))
    .rows[0]?.s;
const checkoutTask = (u: string) =>
  as(h.frontDesk, (ctx) =>
    createCleaningTask(ctx, {
      propertyId: h.org.propertyId,
      unitId: u,
      sourceType: "stay",
      sourceId: randomUUID(),
    }),
  );
async function toDone(taskId: string) {
  await as(h.manager, (ctx) =>
    assignTask(ctx, { taskId, assigneeMembershipId: h.housekeeping.membershipId }),
  );
  await as(h.housekeeping, (ctx) => startTask(ctx, { taskId }));
  await as(h.housekeeping, (ctx) => completeTask(ctx, { taskId }));
}

describe("R2/R3 việc done chờ kiểm gặp check-out mới (S-002)", () => {
  it("tạo việc mới, phòng dirty; nghiệm thu đạt việc cũ không báo phòng sẵn sàng", async () => {
    const u = await unit();
    const t1 = await checkoutTask(u);
    await toDone(t1.taskId);
    const t2 = await checkoutTask(u);
    expect(t2.created).toBe(true);
    expect(await hs(u)).toBe("dirty");
    await as(h.manager, (ctx) => verifyTask(ctx, { taskId: t1.taskId, result: "pass" }));
    expect(await hs(u)).toBe("dirty");
    expect((await getUnitStatus(h.t.runtime, h.manager, u)).readyForArrival).toBe(false);
  });

  it("nghiệm thu không đạt việc cũ → việc cũ đóng (không 409), lý do ghi vào việc mới; phòng vẫn dirty", async () => {
    const u = await unit();
    const t1 = await checkoutTask(u);
    await toDone(t1.taskId);
    const t2 = await checkoutTask(u);
    const r = await as(h.manager, (ctx) =>
      verifyTask(ctx, { taskId: t1.taskId, result: "fail", reason: "Còn rác" }),
    );
    expect(r.status).toBe("cancelled");
    const rows = await sql<{ id: string; status: string; note: string | null }>`
      select id, status, note from tasks where unit_id = ${u} order by created_at`.execute(h.t.admin);
    expect(rows.rows.map((x) => x.status)).toEqual(["cancelled", "open"]);
    expect(rows.rows[1]?.note).toContain("Còn rác");
    expect(rows.rows[1]?.id).toBe(t2.taskId);
    expect(await hs(u)).toBe("dirty");
  });

  it("CSDL: việc done chỉ đóng được khi phòng có việc dọn khác đang mở", async () => {
    const u = await unit();
    const t1 = await checkoutTask(u);
    await toDone(t1.taskId);
    await expect(
      sql`update tasks set status = 'cancelled', cancel_reason = 'x' where id = ${t1.taskId}`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/không chuyển done → cancelled/);
  });
});

describe("R6 huỷ việc dọn", () => {
  it("việc từ check-out bị huỷ → phòng vẫn dirty; việc tạo tay bị huỷ → về trạng thái trước", async () => {
    const u = await unit();
    const t = await checkoutTask(u);
    await as(h.manager, (ctx) => cancelTask(ctx, { taskId: t.taskId, reason: "nhầm" }));
    expect(await hs(u)).toBe("dirty");
    expect((await getUnitStatus(h.t.runtime, h.manager, u)).readyForArrival).toBe(false);
    const u2 = await unit();
    const m = await as(h.manager, (ctx) =>
      createCleaningTask(ctx, {
        propertyId: h.org.propertyId,
        unitId: u2,
        sourceType: "manual",
        sourceId: null,
      }),
    );
    await as(h.manager, (ctx) => cancelTask(ctx, { taskId: m.taskId, reason: "không cần" }));
    expect(await hs(u2)).toBe("inspected");
  });
});

async function workOrder(u: string): Promise<string> {
  const r = await as(h.housekeeping, (ctx) =>
    createWorkOrder(ctx, { unitId: u, title: "Hỏng vòi", description: "Vòi sen rò", severity: "medium" }),
  );
  await as(h.manager, (ctx) =>
    assignWorkOrder(ctx, { workOrderId: r.workOrderId, assigneeMembershipId: tech.membershipId }),
  );
  return r.workOrderId;
}
const blockStatus = async (id: string) =>
  (await sql<{ s: string }>`select status as s from blocks where id = ${id}`.execute(h.t.admin)).rows[0]?.s;
const activeAllocs = async (blockId: string) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from allocations where source_id = ${blockId} and kind = 'block' and active`.execute(
      h.t.admin,
    )
  ).rows[0]?.n;

describe("R1 block đã hết khoảng chặn", () => {
  it("nghiệm thu sau hạn block → block ended, allocation nhả, việc dọn tạo", async () => {
    const id = await workOrder(await unit());
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, {
        workOrderId: id,
        start: new Date(Date.now() - 3 * DAY),
        end: new Date(Date.now() - DAY),
        reason: "Thay ống",
      }),
    );
    await as(h.manager, (ctx) => approveBlock(ctx, blockId));
    await as(tech, (ctx) => startWorkOrder(ctx, { workOrderId: id }));
    await as(tech, (ctx) => completeWorkOrder(ctx, { workOrderId: id }));
    const v = await as(h.manager, (ctx) => verifyWorkOrder(ctx, { workOrderId: id }));
    expect(v).toMatchObject({ status: "verified", blockEnded: true });
    expect(await blockStatus(blockId)).toBe("ended");
    expect(await activeAllocs(blockId)).toBe(0);
  });

  it("endBlock trực tiếp với block đã qua hạn → ended", async () => {
    const id = await workOrder(await unit());
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, {
        workOrderId: id,
        start: new Date(Date.now() - 2 * DAY),
        end: new Date(Date.now() - DAY),
        reason: "Sơn lại",
      }),
    );
    await as(h.manager, (ctx) => approveBlock(ctx, blockId));
    await as(h.manager, (ctx) => endBlock(ctx, blockId));
    expect(await blockStatus(blockId)).toBe("ended");
  });
});

describe("R4/R8/R9 block của phiếu", () => {
  it("đề xuất block lần hai khi đã có block → 409; huỷ phiếu kết thúc block đang chặn", async () => {
    const id = await workOrder(await unit());
    const range = { start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 2 * DAY) };
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, { workOrderId: id, ...range, reason: "Chống thấm" }),
    );
    await as(h.manager, (ctx) => approveBlock(ctx, blockId));
    expect(
      await codeOf(
        runAs(h.t, tech, (ctx) =>
          proposeWorkOrderBlock(ctx, { workOrderId: id, ...range, reason: "Lần hai" }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    await as(h.manager, (ctx) => cancelWorkOrder(ctx, { workOrderId: id, reason: "Khách tự sửa" }));
    expect(await blockStatus(blockId)).toBe("ended");
    expect(await activeAllocs(blockId)).toBe(0);
  });

  it("nghiệm thu khi block còn chờ duyệt → block rejected có audit", async () => {
    const id = await workOrder(await unit());
    const { blockId } = await as(tech, (ctx) =>
      proposeWorkOrderBlock(ctx, {
        workOrderId: id,
        start: new Date(Date.now() + DAY),
        end: new Date(Date.now() + 2 * DAY),
        reason: "Dự phòng",
      }),
    );
    await as(tech, (ctx) => startWorkOrder(ctx, { workOrderId: id }));
    await as(tech, (ctx) => completeWorkOrder(ctx, { workOrderId: id }));
    await as(h.manager, (ctx) => verifyWorkOrder(ctx, { workOrderId: id }));
    expect(await blockStatus(blockId)).toBe("rejected");
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${blockId} and action = 'block.rejected'`.execute(
      h.t.admin,
    );
    expect(a.rows[0]?.n).toBe(1);
  });
});

describe("R7 quyền đề xuất block qua phiếu", () => {
  it("kỹ thuật không được giao / lễ tân → 403 (không phải 409)", async () => {
    const tech2 = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật K2" });
    const id = await workOrder(await unit());
    const propose = (a: Actor) =>
      codeOf(
        runAs(h.t, a, (ctx) =>
          proposeWorkOrderBlock(ctx, {
            workOrderId: id,
            start: new Date(Date.now() + DAY),
            end: new Date(Date.now() + 2 * DAY),
            reason: "x",
          }),
        ),
      );
    expect(await propose(tech2)).toBe("FORBIDDEN");
    expect(await propose(h.frontDesk)).toBe("FORBIDDEN");
  });
});

describe("R5 người thuê chung báo sự cố", () => {
  it("co_tenant đang ở → tạo được; người đã rời (to_on quá khứ) → 404", async () => {
    const rep = await seedMember(h.t, h.org, "tenant", { name: "Đại diện" });
    const co = await seedMember(h.t, h.org, "tenant", { name: "Ở ghép" });
    const left = await seedMember(h.t, h.org, "tenant", { name: "Đã chuyển đi" });
    const lease = await seedLease(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      representativePersonId: rep.personId,
      effectiveFrom: "2026-09-01",
    });
    await h.t.admin.transaction().execute(async (trx) => {
      for (const [p, to] of [
        [co.personId, null],
        [left.personId, "2026-09-15"],
      ] as const) {
        await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative,
                                               from_on, to_on)
                  values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${lease.leaseId}, ${p}, 'co_tenant', false,
                          '2026-09-01', ${to}::date)`.execute(trx);
      }
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
    const report = (a: Actor) =>
      runAs(h.t, a, (ctx) =>
        createWorkOrder(ctx, {
          unitId: lease.unitId,
          title: "Mất điện",
          description: "Aptomat nhảy",
          severity: "high",
        }),
      );
    expect((await report(co)).status).toBe("committed");
    expect((await report(rep)).status).toBe("committed");
    expect(await codeOf(report(left))).toBe("NOT_FOUND");
  });
});
