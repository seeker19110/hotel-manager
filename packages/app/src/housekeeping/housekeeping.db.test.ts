// PLAN đợt 3 T-211 — việc buồng phòng trên Postgres thật (SPEC-housekeeping-maintenance S-001…S-011, S-020, S-022, S-023).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { getUnitStatus } from "../inventory/inventory.ts";
import { walkIn } from "../stay/stays.ts";
import { codeOf, okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import {
  assignTask,
  cancelTask,
  claimTask,
  completeTask,
  createCleaningTask,
  createTask,
  getTask,
  listTasks,
  startTask,
  TASK_FIELDS,
  verifyTask,
} from "./tasks.ts";

let h: Hotel;
let H1: Actor;
let H2: Actor;
let M2: Actor;

beforeAll(async () => {
  h = await seedHotel();
  H1 = await seedMember(h.t, h.org, "housekeeping", { name: "Buồng phòng H1" });
  H2 = await seedMember(h.t, h.org, "housekeeping", { name: "Buồng phòng H2" });
  M2 = await seedMember(h.t, h.org, "manager", { name: "Quản lý M2" });
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function unit(status = "inspected"): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`3${String(seq).padStart(2, "0")}`}, ${status})`.execute(
    h.t.admin,
  );
  return id;
}
const hs = async (unitId: string) =>
  (
    await sql<{ s: string }>`select housekeeping_status as s from units where id = ${unitId}`.execute(
      h.t.admin,
    )
  ).rows[0]?.s;
const newTask = async (unitId: string) =>
  (await okAs(h.t, h.manager, (ctx) => createTask(ctx, { unitId, kind: "cleaning" }))).taskId;

describe("S-001/S-002 tạo việc dọn, không trùng một phòng", () => {
  it("việc dọn open, phòng dirty; sự kiện thứ hai ghi thêm nguồn; việc cũ đã xong thì tạo việc mới", async () => {
    const u = await unit();
    const a = await okAs(h.t, h.frontDesk, (ctx) =>
      createCleaningTask(ctx, {
        propertyId: h.org.propertyId,
        unitId: u,
        sourceType: "stay",
        sourceId: randomUUID(),
      }),
    );
    expect(a.created).toBe(true);
    expect(await hs(u)).toBe("dirty");
    const b = await okAs(h.t, h.frontDesk, (ctx) =>
      createCleaningTask(ctx, {
        propertyId: h.org.propertyId,
        unitId: u,
        sourceType: "move",
        sourceId: randomUUID(),
      }),
    );
    expect(b).toEqual({ taskId: a.taskId, created: false });
    const t = await sql<{ n: number; extra: unknown[] }>`
      select count(*) over ()::int as n, extra_sources as extra from tasks where unit_id = ${u}`.execute(
      h.t.admin,
    );
    expect(t.rows[0]?.n).toBe(1);
    expect(t.rows[0]?.extra).toHaveLength(1);
    await expect(
      sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type)
          values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${u}, 'cleaning', 'manual')`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/uq_tasks_open_cleaning/);
    await okAs(h.t, h.manager, (ctx) =>
      assignTask(ctx, { taskId: a.taskId, assigneeMembershipId: H1.membershipId }),
    );
    await okAs(h.t, H1, (ctx) => startTask(ctx, { taskId: a.taskId }));
    await okAs(h.t, H1, (ctx) => completeTask(ctx, { taskId: a.taskId }));
    const c = await okAs(h.t, h.frontDesk, (ctx) =>
      createCleaningTask(ctx, {
        propertyId: h.org.propertyId,
        unitId: u,
        sourceType: "stay",
        sourceId: randomUUID(),
      }),
    );
    expect(c.created).toBe(true);
    expect(await hs(u)).toBe("dirty");
  });
});

describe("S-003 danh sách việc theo tầng và ưu tiên", () => {
  it("phòng có khách đến hôm nay xếp trước; chỉ trường cho phép (không tên/SĐT khách, giấy tờ, tiền)", async () => {
    const now = new Date("2026-10-20T03:00:00Z");
    const u1 = await unit();
    const u2 = await unit();
    const t1 = await newTask(u1);
    const t2 = await newTask(u2);
    const pii = createPiiCipher(devKeyring());
    // u2 có khách đến hôm nay (booking giữ trước) — walk-in đi tới ngày khác không tính; dùng booking confirmed ngày 20/10.
    const { confirmReservation, createReservation, holdReservation } = await import(
      "../stay/reservations.ts"
    );
    await sql`update units set housekeeping_status = 'inspected' where id = ${u2}`.execute(h.t.admin);
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: u2,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-21",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách Bí Mật", phone: "0100008999" },
      }),
    );
    await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
    void pii;
    const list = await listTasks(h.t.runtime, H1, {
      propertyId: h.org.propertyId,
      floorId: h.org.floorId,
      now,
    });
    const ids = list.map((x) => x.id);
    expect(ids.indexOf(t2)).toBeLessThan(ids.indexOf(t1));
    expect(list.find((x) => x.id === t2)?.arrivalToday).toBe(true);
    for (const row of list) expect(Object.keys(row).sort()).toEqual([...TASK_FIELDS].sort());
    expect(JSON.stringify(list)).not.toMatch(/Khách Bí Mật|0100008999|600000/);
  });
});

describe("S-004…S-006 giao, tự nhận, tiến độ", () => {
  it("giao cho H1 → assigned, phòng assigned; H2 bắt đầu → 403; H1 bắt đầu/xong → cleaning/clean, mỗi bước một audit", async () => {
    const u = await unit();
    const t = await newTask(u);
    await okAs(h.t, h.manager, (ctx) =>
      assignTask(ctx, { taskId: t, assigneeMembershipId: H1.membershipId }),
    );
    expect(await hs(u)).toBe("assigned");
    expect(await codeOf(runAs(h.t, H2, (ctx) => startTask(ctx, { taskId: t })))).toBe("FORBIDDEN");
    await okAs(h.t, H1, (ctx) => startTask(ctx, { taskId: t }));
    expect(await hs(u)).toBe("cleaning");
    await okAs(h.t, H1, (ctx) => completeTask(ctx, { taskId: t, note: "Thay khăn" }));
    expect(await hs(u)).toBe("clean");
    const a = await sql<{ action: string }>`
      select action from audit_events where entity_id = ${t} and outcome = 'success' order by occurred_at`.execute(
      h.t.admin,
    );
    expect(a.rows.map((x) => x.action)).toEqual([
      "housekeeping.task_created",
      "housekeeping.task_assigned",
      "housekeeping.task_started",
      "housekeeping.task_done",
    ]);
  });

  it("H1 và H2 cùng tự nhận một việc song song → đúng một người, người kia 409 INVALID_TRANSITION", async () => {
    const t = await newTask(await unit());
    const [a, b] = await Promise.all([
      runAs(h.t, H1, (ctx) => claimTask(ctx, { taskId: t })),
      runAs(h.t, H2, (ctx) => claimTask(ctx, { taskId: t })),
    ]);
    const res = [a, b];
    expect(res.filter((r) => r.status === "committed")).toHaveLength(1);
    const lost = res.find((r) => r.status === "failed");
    expect(lost?.status === "failed" && lost.problem.code).toBe("INVALID_TRANSITION");
  });

  it("buồng phòng không giao việc cho người khác / không huỷ việc → 403", async () => {
    const t = await newTask(await unit());
    expect(
      await codeOf(
        runAs(h.t, H1, (ctx) => assignTask(ctx, { taskId: t, assigneeMembershipId: H2.membershipId })),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(runAs(h.t, H1, (ctx) => cancelTask(ctx, { taskId: t, reason: "x" })))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("S-007/S-008 nghiệm thu", () => {
  async function doneBy(worker: Actor) {
    const u = await unit();
    const t = await newTask(u);
    await okAs(h.t, h.manager, (ctx) =>
      assignTask(ctx, { taskId: t, assigneeMembershipId: worker.membershipId }),
    );
    await okAs(h.t, worker, (ctx) => startTask(ctx, { taskId: t }));
    await okAs(h.t, worker, (ctx) => completeTask(ctx, { taskId: t }));
    return { u, t };
  }

  it("đạt → verified, phòng inspected, ready_for_arrival; không đạt → assigned cho cùng người", async () => {
    await sql`update properties set require_inspected = true where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    const { u, t } = await doneBy(H1);
    expect((await getUnitStatus(h.t.runtime, H1, u)).readyForArrival).toBe(false);
    await sql`update properties set require_inspected = false where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    await okAs(h.t, h.manager, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" }));
    expect(await hs(u)).toBe("inspected");
    expect(await getUnitStatus(h.t.runtime, h.frontDesk, u)).toMatchObject({
      occupancy: "vacant",
      readyForArrival: true,
    });
    const v = await sql<{ verified_by: string }>`select verified_by from tasks where id = ${t}`.execute(
      h.t.admin,
    );
    expect(v.rows[0]?.verified_by).toBe(h.manager.membershipId);
    const second = await doneBy(H1);
    expect(
      await codeOf(runAs(h.t, h.manager, (ctx) => verifyTask(ctx, { taskId: second.t, result: "fail" }))),
    ).toBe("VALIDATION_FAILED");
    await okAs(h.t, h.manager, (ctx) =>
      verifyTask(ctx, { taskId: second.t, result: "fail", reason: "Còn bụi" }),
    );
    const back = await sql<{ status: string; assignee: string }>`
      select status, assignee_membership_id as assignee from tasks where id = ${second.t}`.execute(h.t.admin);
    expect(back.rows[0]).toEqual({ status: "assigned", assignee: H1.membershipId });
    expect(await hs(second.u)).toBe("assigned");
  });

  it("S-008 tách quyền: quản lý tự làm rồi tự nghiệm thu → 403 SELF_APPROVAL_FORBIDDEN; buồng phòng nghiệm thu → 403", async () => {
    const { t } = await doneBy(M2);
    expect(await codeOf(runAs(h.t, M2, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" })))).toBe(
      "SELF_APPROVAL_FORBIDDEN",
    );
    expect(await codeOf(runAs(h.t, H1, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" })))).toBe(
      "FORBIDDEN",
    );
    const s = await sql<{ status: string }>`select status from tasks where id = ${t}`.execute(h.t.admin);
    expect(s.rows[0]?.status).toBe("done");
  });

  it("lễ tân nghiệm thu chỉ khi cơ sở bật front_desk_can_inspect", async () => {
    const { t } = await doneBy(H1);
    expect(
      await codeOf(runAs(h.t, h.frontDesk, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" }))),
    ).toBe("FORBIDDEN");
    await sql`update properties set settings = settings || '{"front_desk_can_inspect": true}' where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    try {
      await okAs(h.t, h.frontDesk, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" }));
    } finally {
      await sql`update properties set settings = settings - 'front_desk_can_inspect' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("S-009 chuyển trạng thái không hợp lệ (Scenario Outline)", () => {
  it.each([
    ["open", "done"],
    ["open", "verified"],
    ["verified", "in_progress"],
    ["cancelled", "assigned"],
    ["done", "in_progress"],
  ])("%s → %s: 409 INVALID_TRANSITION, có audit từ chối", async (from, to) => {
    const u = await unit();
    const t = await newTask(u);
    if (from !== "open") {
      if (from === "cancelled") {
        await okAs(h.t, h.manager, (ctx) => cancelTask(ctx, { taskId: t, reason: "Không cần" }));
      } else {
        await okAs(h.t, h.manager, (ctx) =>
          assignTask(ctx, { taskId: t, assigneeMembershipId: H1.membershipId }),
        );
        await okAs(h.t, H1, (ctx) => startTask(ctx, { taskId: t }));
        await okAs(h.t, H1, (ctx) => completeTask(ctx, { taskId: t }));
        if (from === "verified")
          await okAs(h.t, h.manager, (ctx) => verifyTask(ctx, { taskId: t, result: "pass" }));
      }
    }
    const key = randomUUID();
    const go = (ctx: Parameters<typeof completeTask>[0]) =>
      to === "done"
        ? completeTask(ctx, { taskId: t })
        : to === "verified"
          ? verifyTask(ctx, { taskId: t, result: "pass" })
          : to === "in_progress"
            ? startTask(ctx, { taskId: t })
            : assignTask(ctx, { taskId: t, assigneeMembershipId: H1.membershipId });
    const actor = to === "verified" || to === "assigned" ? h.manager : h.manager;
    const r = await runAs<unknown>(h.t, actor, go, { key });
    expect(r.status === "failed" && r.problem.code).toBe("INVALID_TRANSITION");
    const d = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where command_id = ${key} and outcome = 'denied'`.execute(
      h.t.admin,
    );
    expect(d.rows[0]?.n).toBe(1);
  });
});

describe("S-010 sạch không có nghĩa là trống", () => {
  it("phòng inspected có khách in_house → occupied, không ready_for_arrival", async () => {
    const u = await unit("inspected");
    await okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, createPiiCipher(devKeyring()), {
        unitId: u,
        departureDate: "2026-10-21",
        guests: [{ fullName: "Khách", phone: "0100000999", docType: "cccd", docNumber: "001200300400" }],
        now: new Date("2026-10-20T08:00:00Z"),
      }),
    );
    const s = await getUnitStatus(h.t.runtime, h.frontDesk, u, new Date("2026-10-20T09:00:00Z"));
    expect(s).toMatchObject({ occupancy: "occupied", housekeeping: "inspected", readyForArrival: false });
  });
});

describe("S-011 idempotency", () => {
  it("hoàn tất hai lần cùng Idempotency-Key → 1 chuyển trạng thái, 1 audit, phản hồi giống nhau", async () => {
    const t = await newTask(await unit());
    await okAs(h.t, h.manager, (ctx) =>
      assignTask(ctx, { taskId: t, assigneeMembershipId: H1.membershipId }),
    );
    await okAs(h.t, H1, (ctx) => startTask(ctx, { taskId: t }));
    const key = randomUUID();
    const send = () =>
      runAs(h.t, H1, (ctx) => completeTask(ctx, { taskId: t }), {
        key,
        command: "housekeeping.completeTask",
        payload: { task_id: t },
      });
    const a = await send();
    const b = await send();
    expect(a.status === "committed" && a.data).toEqual(b.status === "committed" && b.data);
    expect(b).toMatchObject({ replayed: true });
    const n = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${t} and action = 'housekeeping.task_done'`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });
});

describe("S-020/S-022/S-023 quyền, chéo tenant, audit + outbox", () => {
  it("chi tiết việc chỉ trường cho phép; tổ chức khác → 404; xong việc ghi audit + outbox cùng transaction", async () => {
    const t = await newTask(await unit());
    const v = await getTask(h.t.runtime, H1, t);
    expect(Object.keys(v).sort()).toEqual([...TASK_FIELDS].sort());
    await expect(getTask(h.t.runtime, h.ownerOther, t)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listTasks(h.t.runtime, h.ownerOther, { propertyId: h.org.propertyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await okAs(h.t, h.manager, (ctx) =>
      assignTask(ctx, { taskId: t, assigneeMembershipId: H1.membershipId }),
    );
    await okAs(h.t, H1, (ctx) => startTask(ctx, { taskId: t }));
    const key = randomUUID();
    await runAs(h.t, H1, (ctx) => completeTask(ctx, { taskId: t }), { key });
    const ev = await sql<{ a: number; o: number }>`
      select (select count(*) from audit_events where command_id = ${key})::int as a,
             (select count(*) from outbox where command_id = ${key} and event_type = 'housekeeping.task_done')::int as o`.execute(
      h.t.admin,
    );
    expect(ev.rows[0]).toEqual({ a: 1, o: 1 });
    // RLS: buồng phòng không cập nhật thẳng việc của người khác.
    const n = await withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: H2.membershipId }, (trx) =>
      sql`update tasks set note = 'x' where id = ${t}`.execute(trx),
    );
    expect(Number(n.numAffectedRows ?? 0)).toBe(0);
  });
});
