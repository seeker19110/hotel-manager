// PLAN đợt 3 T-209 — việc buồng phòng trên Postgres thật (SPEC-housekeeping-maintenance S-001…S-011, S-020, S-022, S-023; Q-01, Q-02,
// Q-04, Q-05; DOMAIN-MODEL §4 vòng đời phiếu việc). Kiểm qua lớp HTTP + kết nối runtime (RLS thật), không qua đường tắt của admin.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { sql, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { executeCommand } from "../pipeline/command.ts";
import { checkOut } from "../reservation/folio.ts";
import { setRatePlan } from "../reservation/rates.ts";
import { confirmReservation, createReservation, holdReservation } from "../reservation/reservation.ts";
import { checkIn } from "../reservation/stay.ts";
import { openCleaningTask } from "./cleaning.ts";
import { TASK_VIEW_FIELDS } from "./housekeeping.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let deps: HttpDeps;
let floor2: string;
let P2: { propertyId: string; floorId: string; unitId: string };
const users: Record<string, string> = {};
const members: Record<string, { membershipId: string; personId: string }> = {};
const actors: Record<string, Actor> = {};

// biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject/toEqual
type Json = any;

async function addMember(org: SeededOrg, role: string, label: string, scoped = true): Promise<void> {
  const user = await seedAuthUser(t.admin, `${label}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${`NV ${label}`})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  if (scoped)
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  users[label] = user;
  members[label] = { membershipId: membership, personId: person };
  actors[label] = await resolveActor(t.runtime, {
    authUserId: user,
    orgId: org.orgId,
    twoFactorEnabled: true,
  });
}

async function call(
  name: string,
  body: unknown,
  as: string,
  key: string = randomUUID(),
  orgId: string = A.orgId,
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
        "x-org-id": orgId,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, body: await res.json() };
}

async function query(name: string, params: Record<string, string>, as: string, orgId: string = A.orgId) {
  const def = QUERIES[name];
  if (!def) throw new Error(`thiếu query ${name}`);
  const res = await handleQuery(
    def,
    new Request(`http://local.test/api/v1/${name.replace(".", "/")}?${new URLSearchParams(params)}`, {
      headers: { "x-test-user": users[as] as string, "x-org-id": orgId },
    }),
    deps,
  );
  return { status: res.status, body: (await res.json()) as Json };
}

async function rows<T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await q.execute(t.admin)).rows;
}
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>) =>
  (await rows(q))[0] as T;

async function newUnit(floorId: string = A.floorId, org: SeededOrg = A): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${floorId}, ${org.roomTypeId}, ${`U${id.slice(0, 6)}`})`.execute(
    t.admin,
  );
  return id;
}

const hk = async (unitId: string) =>
  (await one(sql<{ h: string }>`select housekeeping_status as h from units where id = ${unitId}`)).h;
const taskRow = (id: string) =>
  one(
    sql<{
      status: string;
      assignee_membership_id: string | null;
      done_by: string | null;
      verified_by: string | null;
      note: string | null;
      extra_sources: { type: string; id: string | null }[];
    }>`select status, assignee_membership_id, done_by, verified_by, note, extra_sources from tasks where id = ${id}`,
  );
const auditCount = async (action: string, entityId: string) =>
  (
    await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from audit_events where action = ${action} and entity_id = ${entityId}`,
    )
  ).n;
const tasksOfUnit = (unitId: string) =>
  rows(
    sql<{
      id: string;
      status: string;
      source_type: string;
    }>`select id, status, source_type from tasks where unit_id = ${unitId} order by created_at, id`,
  );

/** Mở việc dọn thủ công (đã có lệnh createTask) — mỗi test dùng phòng riêng nên không đụng unique việc đang mở. */
async function newTask(unitId?: string): Promise<{ taskId: string; unitId: string }> {
  const u = unitId ?? (await newUnit());
  const r = await call("housekeeping.createTask", { unit_id: u }, "manager");
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { taskId: r.body.data.task_id, unitId: u };
}

type Stage = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";
/** Đưa việc tới trạng thái bằng các lệnh thật: H1 làm, quản lý giao/huỷ, chủ nghiệm thu. */
async function taskAt(stage: Stage): Promise<{ taskId: string; unitId: string }> {
  const x = await newTask();
  if (stage === "open") return x;
  if (stage === "cancelled") {
    await ok(call("housekeeping.cancelTask", { task_id: x.taskId, reason: "Khách ở lại thêm" }, "manager"));
    return x;
  }
  await ok(
    call(
      "housekeeping.assignTask",
      { task_id: x.taskId, assignee_membership_id: members.H1?.membershipId },
      "manager",
    ),
  );
  if (stage === "assigned") return x;
  await ok(call("housekeeping.startTask", { task_id: x.taskId }, "H1"));
  if (stage === "in_progress") return x;
  await ok(call("housekeeping.completeTask", { task_id: x.taskId, note: "Đã dọn" }, "H1"));
  if (stage === "done") return x;
  await ok(call("housekeeping.verifyTask", { task_id: x.taskId, result: "pass" }, "owner"));
  return x;
}

async function ok(p: Promise<{ status: number; body: Json }>): Promise<Json> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

async function businessToday(): Promise<string> {
  return (await one(sql<{ d: string }>`select app.business_date(${A.orgId}, ${A.propertyId})::text as d`)).d;
}

/** Khách đã đặt (lượt ở `expected`) đến phòng lúc `startIso` (UTC) — chỉ bảng `stays` + allocation, không cần lệnh đặt phòng. */
async function expectedArrival(unitId: string, startIso: string, arrivalDate: string, departureDate: string) {
  const booker = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${booker}, ${A.orgId}, 'Khách Đến Hôm Nay', '0903334444')`.execute(
    t.admin,
  );
  const { itemId } = await seedReservation(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    bookerPersonId: booker,
    unitId,
    roomTypeId: A.roomTypeId,
    arrivalDate,
    departureDate,
  });
  const stayId = randomUUID();
  await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id)
            values (${stayId}, ${A.orgId}, ${A.propertyId}, ${itemId}, ${unitId}, 'expected', ${booker})`.execute(
    t.admin,
  );
  const end = new Date(new Date(startIso).getTime() + 2 * 86_400_000);
  await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay', 'stay', ${stayId},
                    tstzrange(${new Date(startIso)}, ${end}, '[)'))`.execute(t.admin);
  return stayId;
}

async function pgError(p: PromiseLike<unknown>): Promise<{ code?: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; hint?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

const asRuntime = <T>(who: string, fn: (trx: Transaction<unknown>) => Promise<T>): Promise<T> =>
  withTenant(t.runtime, { orgId: A.orgId, actorId: members[who]?.membershipId as string }, fn);

/** Số hàng người dùng thấy qua kết nối runtime (RLS); bảng không cấp SELECT cho role ứng dụng cũng tính là 0. */
async function visibleRows(who: string, table: string): Promise<number> {
  try {
    return await asRuntime(
      who,
      async (trx) =>
        (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(trx)).rows[0]
          ?.n ?? 0,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "42501") return 0;
    throw e;
  }
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Buồng phòng", "hotel");
  B = await seedOrg(t.admin, "KS Khác", "hotel");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00',
            settings = ${JSON.stringify({ reservation: { confirm_without_payment: true } })}::jsonb
            where id = ${A.propertyId}`.execute(t.admin);
  floor2 = randomUUID();
  await sql`insert into floors (id, organization_id, property_id, name, sort_order)
            values (${floor2}, ${A.orgId}, ${A.propertyId}, 'Tầng 2', 2)`.execute(t.admin);
  users.owner = A.ownerAuthUserId;
  members.owner = { membershipId: A.ownerMembershipId, personId: A.ownerPersonId };
  actors.owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  await addMember(A, "manager", "manager");
  await addMember(A, "manager", "manager2");
  await addMember(A, "front_desk", "front_desk");
  await addMember(A, "housekeeping", "H1");
  await addMember(A, "housekeeping", "H2");
  await addMember(A, "housekeeping", "H3");
  await addMember(A, "accountant", "accountant");
  await addMember(A, "maintenance", "maintenance");
  await addMember(A, "housekeeping", "Hphụ", false); // không có phạm vi cơ sở nào
  // Cơ sở thứ hai của cùng tổ chức: H1 không thuộc phạm vi.
  P2 = { propertyId: randomUUID(), floorId: randomUUID(), unitId: randomUUID() };
  await sql`insert into properties (id, organization_id, name, template) values (${P2.propertyId}, ${A.orgId}, 'CS2', 'hotel')`.execute(
    t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name) values (${P2.floorId}, ${A.orgId}, ${P2.propertyId}, 'T1')`.execute(
    t.admin,
  );
  await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${P2.unitId}, ${A.orgId}, ${P2.propertyId}, ${P2.floorId}, 'X1')`.execute(
    t.admin,
  );
  await executeCommand(
    t.runtime,
    actors.owner as Actor,
    { command: "hk.test", idempotencyKey: randomUUID(), payload: {}, correlationId: "c-hk-test" },
    async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    }),
  );
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

describe("housekeeping S-001/S-002 — việc dọn từ check-out/chuyển phòng, không trùng", () => {
  it("S-001: check-out tạo đúng một việc dọn open (nguồn = stay) + phòng dirty, cùng transaction; sự kiện vẫn phát; S-020: buồng phòng không đọc được CCCD/folio của lượt ở đó", async () => {
    const unitId = await newUnit();
    const NOW = new Date("2026-10-16T03:00:00Z");
    const IN = new Date("2026-10-20T08:00:00Z");
    const OUT = new Date("2026-10-22T03:30:00Z");
    const run = <T>(who: string, fn: Parameters<typeof executeCommand<T>>[3]) =>
      executeCommand<T>(
        t.runtime,
        actors[who] as Actor,
        {
          command: "hk.scenario",
          idempotencyKey: randomUUID(),
          payload: { k: randomUUID() },
          correlationId: "c-hk-scn",
        },
        fn,
      );
    const must = async <T>(p: ReturnType<typeof run<T>>): Promise<T> => {
      const r = await p;
      if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
      return r.data;
    };
    const res = await must(
      run("manager", async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "Khách trả phòng", phone: "0912345678" },
          rooms: [{ unitId, guests: 2 }],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-22",
        }),
      })),
    );
    await must(
      run("manager", async (ctx) => ({
        data: await holdReservation(ctx, { reservationId: res.id, now: NOW }),
      })),
    );
    const c = await must(
      run("manager", async (ctx) => ({
        data: await confirmReservation(ctx, { reservationId: res.id, now: NOW }),
      })),
    );
    await must(
      run("manager", async (ctx) => ({
        data: await checkIn(ctx, {
          reservationId: res.id,
          guests: [
            {
              fullName: "Nguyễn Văn A",
              phone: "0901234567",
              document: { type: "cccd", number: "079123456789" },
            },
          ],
          now: IN,
        }),
      })),
    );
    expect(await tasksOfUnit(unitId)).toHaveLength(0);
    const booker = await one(
      sql<{ b: string }>`select booker_person_id as b from reservations where id = ${res.id}`,
    );
    const out = await must(
      run("manager", async (ctx) => ({
        data: await checkOut(ctx, {
          stayId: c.stay_id,
          now: OUT,
          allowBalance: { debtorPersonId: booker.b, dueDate: "2026-10-30" },
        }),
      })),
    );

    const tasks = await rows(
      sql<{
        id: string;
        kind: string;
        status: string;
        source_type: string;
        source_id: string;
        property_id: string;
      }>`
        select id, kind, status, source_type, source_id, property_id from tasks where unit_id = ${unitId}`,
    );
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: "cleaning",
        status: "open",
        source_type: "stay",
        source_id: c.stay_id,
        property_id: A.propertyId,
      }),
    ]);
    expect(await hk(unitId)).toBe("dirty");
    expect(
      await rows(
        sql<
          Record<string, unknown>
        >`select 1 from outbox where event_type = 'stay.checked_out' and aggregate_id = ${c.stay_id}`,
      ),
    ).toHaveLength(1);

    // Chạy lại cùng nguồn (sự kiện/lệnh lặp) → không tạo thêm.
    const again = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, {
        orgId: A.orgId,
        propertyId: A.propertyId,
        unitId,
        source: { type: "stay", id: c.stay_id },
      }),
    );
    expect(again).toMatchObject({ taskId: tasks[0]?.id, created: false });
    expect(await tasksOfUnit(unitId)).toHaveLength(1);

    // S-020: H1 thuộc cơ sở, có việc ở phòng này nhưng không thấy lượt ở/giấy tờ/folio/phiếu/người.
    const stayId = c.stay_id;
    const docs = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from identity_documents where organization_id = ${A.orgId}`,
    );
    expect(docs.n).toBeGreaterThanOrEqual(1);
    for (const table of [
      "stays",
      "reservations",
      "reservation_items",
      "identity_documents",
      "invoices",
      "charges",
      "payments",
    ]) {
      expect(await visibleRows("H1", table), table).toBe(0);
    }
    const people = await asRuntime(
      "H1",
      async (trx) =>
        (await sql<{ n: number }>`select count(*)::int as n from persons where phone like '09%'`.execute(trx))
          .rows[0]?.n,
    );
    expect(people).toBe(0); // tìm kiếm theo SĐT khách trả rỗng
    expect((await query("stay.getFolio", { stay_id: stayId }, "H1")).status).toBe(404);
    expect((await query("stay.get", { stay_id: stayId }, "H1")).status).toBe(404);
    expect(out.invoice_id).toBeTruthy();
    const doc = await one(
      sql<{ id: string }>`select id from identity_documents where organization_id = ${A.orgId} limit 1`,
    );
    const viaRuntime = await asRuntime(
      "H1",
      async (trx) => (await sql`select id from identity_documents where id = ${doc.id}`.execute(trx)).rows,
    );
    expect(viaRuntime).toHaveLength(0);
  });

  it("S-001: chuyển phòng tạo việc dọn cho phòng cũ (nguồn = move) và đặt phòng cũ dirty", async () => {
    const from = await newUnit();
    const to = await newUnit();
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 2 * 86_400_000);
    const al = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${al}, ${A.orgId}, ${A.propertyId}, ${from}, 'stay', tstzrange(${start}, ${end}, '[)'))`.execute(
      t.admin,
    );
    const r = await call(
      "inventory.moveAllocation",
      {
        allocation_id: al,
        to_unit_id: to,
        effective_at: new Date(Date.now() + 60_000).toISOString(),
        reason: "Máy lạnh hỏng",
      },
      "front_desk",
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const tasks = await tasksOfUnit(from);
    expect(tasks).toEqual([expect.objectContaining({ status: "open", source_type: "move" })]);
    expect(await hk(from)).toBe("dirty");
    expect(await tasksOfUnit(to)).toHaveLength(0);
  });

  it("S-002: đã có việc dọn đang mở → không tạo việc mới, ghi thêm nguồn; việc cũ done/verified thì tạo việc mới và phòng về dirty", async () => {
    const unitId = await newUnit();
    const src = () => ({ orgId: A.orgId, propertyId: A.propertyId, unitId });
    const first = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, { ...src(), source: { type: "stay", id: randomUUID() } }),
    );
    expect(first).toMatchObject({ created: true, status: "open" });
    const s2 = randomUUID();
    const second = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, { ...src(), source: { type: "move", id: s2 } }),
    );
    expect(second).toMatchObject({ taskId: first.taskId, created: false });
    expect((await taskRow(first.taskId)).extra_sources).toEqual([
      expect.objectContaining({ type: "move", id: s2 }),
    ]);
    // Nguồn thêm lặp lại cũng không tạo việc.
    const third = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, { ...src(), source: { type: "move", id: s2 } }),
    );
    expect(third).toMatchObject({ taskId: first.taskId, created: false });
    expect(await tasksOfUnit(unitId)).toHaveLength(1);

    // Việc đã giao: phòng giữ "assigned" khi có nguồn mới (không bị đặt lại dirty).
    await ok(
      call(
        "housekeeping.assignTask",
        { task_id: first.taskId, assignee_membership_id: members.H1?.membershipId },
        "manager",
      ),
    );
    expect(await hk(unitId)).toBe("assigned");
    await asRuntime("manager", (trx) =>
      openCleaningTask(trx, { ...src(), source: { type: "move", id: randomUUID() } }),
    );
    expect(await hk(unitId)).toBe("assigned");

    // Xong + nghiệm thu → việc mới cho sự kiện kế tiếp, phòng về dirty.
    await ok(call("housekeeping.startTask", { task_id: first.taskId }, "H1"));
    await ok(call("housekeeping.completeTask", { task_id: first.taskId }, "H1"));
    await ok(call("housekeeping.verifyTask", { task_id: first.taskId, result: "pass" }, "owner"));
    expect(await hk(unitId)).toBe("inspected");
    const next = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, { ...src(), source: { type: "stay", id: randomUUID() } }),
    );
    expect(next.created).toBe(true);
    expect(next.taskId).not.toBe(first.taskId);
    expect(await hk(unitId)).toBe("dirty");
    expect(await tasksOfUnit(unitId)).toHaveLength(2);
  });

  it("S-002: hai sự kiện song song cho cùng một phòng → đúng một việc mở", async () => {
    const unitId = await newUnit();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        asRuntime("manager", (trx) =>
          openCleaningTask(trx, {
            orgId: A.orgId,
            propertyId: A.propertyId,
            unitId,
            source: { type: "stay", id: randomUUID() },
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.taskId)).size).toBe(1);
    const open = await rows(
      sql<Record<string, unknown>>`select 1 from tasks where unit_id = ${unitId} and status = 'open'`,
    );
    expect(open).toHaveLength(1);
    expect((await taskRow(results[0]?.taskId as string)).extra_sources).toHaveLength(3);
  });

  it("CSDL: hai việc dọn mở cho một phòng bị unique chặn; hai việc cùng nguồn bị unique chặn", async () => {
    const unitId = await newUnit();
    const ins = (src: string | null, srcType = "stay") =>
      sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type, source_id)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'cleaning', ${srcType}, ${src})`.execute(
        t.admin,
      );
    const s = randomUUID();
    await ins(s);
    expect((await pgError(ins(randomUUID()))).code).toBe("23505");
    expect((await pgError(ins(s))).code).toBe("23505");
    // Việc kiểm tra (inspection) không bị giới hạn một-việc-mở.
    await sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'inspection', 'manual')`.execute(
      t.admin,
    );
    // Nguồn không phải manual bắt buộc có source_id.
    expect((await pgError(ins(null))).code).toBe("23514");
  });
});

describe("housekeeping S-003 — danh sách theo tầng và ưu tiên", () => {
  it("S-003: chỉ việc đúng tầng/cơ sở; phòng có khách đến hôm nay xếp trước; mỗi dòng chỉ gồm trường cho phép; không tên/SĐT/tiền", async () => {
    const f2a = await newUnit(floor2);
    const f2b = await newUnit(floor2);
    const f1 = await newUnit(A.floorId);
    // Tạo việc: f2a trước (cũ nhất), f2b sau; f2b có khách đến hôm nay lúc 14:00 giờ VN.
    const tA = await newTask(f2a);
    const tB = await newTask(f2b);
    const tC = await newTask(f1);
    const today = await businessToday();
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await expectedArrival(f2b, `${today}T07:00:00Z`, today, tomorrow.toISOString().slice(0, 10));
    const f2c = await newUnit(floor2); // khách đến NGÀY MAI → không ưu tiên
    const tD = await newTask(f2c);
    const nextDay = new Date(`${today}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDay2 = new Date(`${today}T00:00:00Z`);
    nextDay2.setUTCDate(nextDay2.getUTCDate() + 2);
    await expectedArrival(
      f2c,
      `${nextDay.toISOString().slice(0, 10)}T07:00:00Z`,
      nextDay.toISOString().slice(0, 10),
      nextDay2.toISOString().slice(0, 10),
    );

    const r = await query(
      "housekeeping.listTasks",
      { property_id: A.propertyId, floor_id: floor2, limit: "500" },
      "H1",
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = r.body.data.tasks as Json[];
    const ids = list.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([tA.taskId, tB.taskId, tD.taskId]));
    expect(ids).not.toContain(tC.taskId); // tầng 1
    expect(list.every((x) => x.floor_id === floor2)).toBe(true);
    // Phòng có khách đến hôm nay đứng đầu, kèm giờ đến dự kiến; phòng khách đến ngày mai không ưu tiên.
    expect(list[0]).toMatchObject({
      id: tB.taskId,
      arrival_today: true,
      priority: "high",
      expected_arrival_at: `${today}T07:00:00.000Z`,
    });
    const d = list.find((x) => x.id === tD.taskId);
    expect(d).toMatchObject({ arrival_today: false, priority: "normal", expected_arrival_at: null });
    // Còn lại theo thời gian tạo: tA (cũ) trước tD (mới).
    expect(ids.indexOf(tA.taskId)).toBeLessThan(ids.indexOf(tD.taskId));
    // Trường: đúng danh sách cho phép, không dư; không rò dữ liệu khách/tiền.
    for (const row of list) expect(Object.keys(row).sort()).toEqual([...TASK_VIEW_FIELDS].sort());
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/Khách Đến Hôm Nay|0903334444|079123456789|amount|balance|phone|guest_name/i);
    expect(list.find((x) => x.id === tB.taskId)).toMatchObject({
      unit_id: f2b,
      kind: "cleaning",
      status: "open",
      assigned_to_me: false,
    });

    // Ưu tiên "urgent" đặt tay hơn việc thường (sau nhóm khách đến hôm nay).
    const f2d = await newUnit(floor2);
    const urgent = await call(
      "housekeeping.createTask",
      { unit_id: f2d, priority: "urgent", note: "Khách VIP — ✓ gấp" },
      "manager",
    );
    const r2 = await query("housekeeping.listTasks", { property_id: A.propertyId, floor_id: floor2 }, "H1");
    const ids2 = (r2.body.data.tasks as Json[]).map((x) => x.id);
    expect(ids2[0]).toBe(tB.taskId);
    expect(ids2[1]).toBe(urgent.body.data.task_id);
    expect((r2.body.data.tasks as Json[])[1]).toMatchObject({
      priority: "urgent",
      note: "Khách VIP — ✓ gấp",
    });
  });

  it("S-003 biên: không có việc → mảng rỗng; trạng thái/limit sai → 422; lọc trạng thái và người nhận; kết thúc không nằm trong mặc định", async () => {
    const emptyFloor = randomUUID();
    await sql`insert into floors (id, organization_id, property_id, name, sort_order) values (${emptyFloor}, ${A.orgId}, ${A.propertyId}, 'Tầng trống', 9)`.execute(
      t.admin,
    );
    const empty = await query(
      "housekeeping.listTasks",
      { property_id: A.propertyId, floor_id: emptyFloor },
      "H1",
    );
    expect(empty.body.data.tasks).toEqual([]);
    expect(
      (await query("housekeeping.listTasks", { property_id: A.propertyId, status: "bogus" }, "H1")).status,
    ).toBe(422);
    expect(
      (await query("housekeeping.listTasks", { property_id: A.propertyId, limit: "0" }, "H1")).status,
    ).toBe(422);
    const done = await taskAt("verified");
    const mine = await taskAt("assigned");
    const def = await query("housekeeping.listTasks", { property_id: A.propertyId, limit: "500" }, "H1");
    expect((def.body.data.tasks as Json[]).map((x) => x.id)).not.toContain(done.taskId);
    const verified = await query(
      "housekeeping.listTasks",
      { property_id: A.propertyId, status: "verified", limit: "500" },
      "H1",
    );
    expect((verified.body.data.tasks as Json[]).map((x) => x.id)).toContain(done.taskId);
    const meList = await query(
      "housekeeping.listTasks",
      { property_id: A.propertyId, assignee: "me", limit: "500" },
      "H1",
    );
    const meIds = (meList.body.data.tasks as Json[]).map((x) => x.id);
    expect(meIds).toContain(mine.taskId);
    expect((meList.body.data.tasks as Json[]).every((x) => x.assigned_to_me === true)).toBe(true);
    const h2 = await query(
      "housekeeping.listTasks",
      { property_id: A.propertyId, assignee: "me", limit: "500" },
      "H2",
    );
    expect((h2.body.data.tasks as Json[]).map((x) => x.id)).not.toContain(mine.taskId);
  });
});

describe("housekeeping S-004…S-006, S-011 — giao/tự nhận, tiến độ, chỉ người được giao", () => {
  it("S-004: quản lý giao việc cho H1 → assigned + phòng assigned + audit; buồng phòng không giao việc; người nhận không phải nhân viên buồng phòng → 422", async () => {
    const { taskId, unitId } = await newTask();
    expect(
      (
        await call(
          "housekeeping.assignTask",
          { task_id: taskId, assignee_membership_id: members.H1?.membershipId },
          "H2",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "housekeeping.assignTask",
          { task_id: taskId, assignee_membership_id: members.accountant?.membershipId },
          "manager",
        )
      ).body,
    ).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(
      (
        await call(
          "housekeeping.assignTask",
          { task_id: taskId, assignee_membership_id: members.Hphụ?.membershipId },
          "manager",
        )
      ).status,
    ).toBe(422); // ngoài phạm vi cơ sở
    expect(
      (
        await call(
          "housekeeping.assignTask",
          { task_id: taskId, assignee_membership_id: randomUUID() },
          "manager",
        )
      ).status,
    ).toBe(422);
    expect(await taskRow(taskId)).toMatchObject({ status: "open", assignee_membership_id: null });

    const r = await call(
      "housekeeping.assignTask",
      { task_id: taskId, assignee_membership_id: members.H1?.membershipId },
      "manager",
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      status: "assigned",
      assignee_membership_id: members.H1?.membershipId,
    });
    expect(await taskRow(taskId)).toMatchObject({
      status: "assigned",
      assignee_membership_id: members.H1?.membershipId,
    });
    expect(await hk(unitId)).toBe("assigned");
    expect(await auditCount("housekeeping.task_assigned", taskId)).toBe(1);
    // Đổi người khi còn assigned (chưa bắt đầu).
    expect(
      (
        await call(
          "housekeeping.assignTask",
          { task_id: taskId, assignee_membership_id: members.H2?.membershipId },
          "front_desk",
        )
      ).status,
    ).toBe(200);
    expect((await taskRow(taskId)).assignee_membership_id).toBe(members.H2?.membershipId);
  });

  it("S-004: H1 và H2 cùng tự nhận một việc song song → đúng một người thắng, người kia 409 INVALID_TRANSITION", async () => {
    for (let i = 0; i < 3; i++) {
      const { taskId, unitId } = await newTask();
      const [a, b] = await Promise.all([
        call("housekeeping.claimTask", { task_id: taskId }, "H1"),
        call("housekeeping.claimTask", { task_id: taskId }, "H2"),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, JSON.stringify([a.body, b.body])).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 200 ? "H1" : "H2";
      expect(loser.body).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
      expect((await taskRow(taskId)).assignee_membership_id).toBe(members[winner]?.membershipId);
      expect(await hk(unitId)).toBe("assigned");
      expect(await auditCount("housekeeping.task_claimed", taskId)).toBe(1);
    }
  });

  it("S-004 (Q-02): nhận việc đã có người nhận → 409; lễ tân/kế toán không nhận; owner/manager tự nhận được; ngoài phạm vi → 404", async () => {
    const { taskId } = await newTask();
    await ok(call("housekeeping.claimTask", { task_id: taskId }, "H1"));
    expect(await call("housekeeping.claimTask", { task_id: taskId }, "H2")).toMatchObject({
      status: 409,
      body: { code: "INVALID_TRANSITION" },
    });
    const fresh = await newTask();
    expect((await call("housekeeping.claimTask", { task_id: fresh.taskId }, "front_desk")).status).toBe(403);
    expect((await call("housekeeping.claimTask", { task_id: fresh.taskId }, "accountant")).status).toBe(404);
    expect((await call("housekeeping.claimTask", { task_id: fresh.taskId }, "Hphụ")).status).toBe(404);
    expect((await call("housekeeping.claimTask", { task_id: fresh.taskId }, "manager2")).status).toBe(200);
  });

  it("S-005 + S-011: H1 start → complete {ghi chú}; phòng cleaning rồi clean; audit người + giờ UTC; gửi hoàn tất hai lần cùng Idempotency-Key → 1 chuyển trạng thái, 1 audit, hai phản hồi giống nhau", async () => {
    const { taskId, unitId } = await taskAt("assigned");
    expect((await call("housekeeping.startTask", { task_id: taskId }, "H1")).status).toBe(200);
    expect(await hk(unitId)).toBe("cleaning");
    expect((await taskRow(taskId)).status).toBe("in_progress");

    const key = randomUUID();
    const first = await call(
      "housekeeping.completeTask",
      { task_id: taskId, note: "Đã thay ga — phòng thơm ✓" },
      "H1",
      key,
    );
    const second = await call(
      "housekeeping.completeTask",
      { task_id: taskId, note: "Đã thay ga — phòng thơm ✓" },
      "H1",
      key,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await auditCount("housekeeping.task_completed", taskId)).toBe(1);
    expect(await auditCount("housekeeping.task_started", taskId)).toBe(1);
    const row = await taskRow(taskId);
    expect(row).toMatchObject({
      status: "done",
      done_by: members.H1?.membershipId,
      note: "Đã thay ga — phòng thơm ✓",
    });
    expect(await hk(unitId)).toBe("clean");
    const au = await one(
      sql<{
        actor_person_id: string;
        after: { done_at: string };
      }>`select actor_person_id, after from audit_events where action = 'housekeeping.task_completed' and entity_id = ${taskId}`,
    );
    expect(au.actor_person_id).toBe(members.H1?.personId);
    expect(au.after.done_at).toMatch(/Z$/);
    // Cùng key khác nội dung → IDEMPOTENCY_CONFLICT.
    expect(
      (await call("housekeeping.completeTask", { task_id: taskId, note: "khác" }, "H1", key)).body,
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // Bấm lần nữa với key mới khi đã done → 409 (không chuyển trạng thái thứ hai).
    expect((await call("housekeeping.completeTask", { task_id: taskId }, "H1")).status).toBe(409);
    expect(await auditCount("housekeeping.task_completed", taskId)).toBe(1);
  });

  it("S-005 biên: ghi chú > 2.000 ký tự → 422 (không đổi trạng thái); ghi chú rỗng giữ ghi chú cũ", async () => {
    const { taskId } = await taskAt("in_progress");
    const r = await call("housekeeping.completeTask", { task_id: taskId, note: "x".repeat(2001) }, "H1");
    expect(r.status).toBe(422);
    expect((await taskRow(taskId)).status).toBe("in_progress");
    expect((await call("housekeeping.completeTask", { task_id: taskId, note: "   " }, "H1")).status).toBe(
      200,
    );
  });

  it("S-006: H2 bắt đầu/hoàn tất việc giao cho H1 → 403 FORBIDDEN, trạng thái không đổi; việc chưa giao cũng không phải của H2", async () => {
    const { taskId, unitId } = await taskAt("assigned");
    const r = await call("housekeeping.startTask", { task_id: taskId }, "H2");
    expect(r).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await taskRow(taskId)).toMatchObject({
      status: "assigned",
      assignee_membership_id: members.H1?.membershipId,
    });
    expect(await hk(unitId)).toBe("assigned");
    await ok(call("housekeeping.startTask", { task_id: taskId }, "H1"));
    expect((await call("housekeeping.completeTask", { task_id: taskId }, "H2")).status).toBe(403);
    expect((await taskRow(taskId)).status).toBe("in_progress");
    const open = await newTask();
    expect((await call("housekeeping.startTask", { task_id: open.taskId }, "H2")).status).toBe(403);
    // Quản lý có quyền tiến độ trong phạm vi (ma trận: owner/manager = yes).
    expect((await call("housekeeping.completeTask", { task_id: taskId }, "manager")).status).toBe(200);
    expect((await taskRow(taskId)).done_by).toBe(members.manager?.membershipId);
    // Kế toán không đọc được việc buồng phòng → 404; lễ tân đọc được nhưng không có quyền tiến độ → 403.
    const other = await taskAt("assigned");
    expect((await call("housekeeping.startTask", { task_id: other.taskId }, "accountant")).status).toBe(404);
    expect((await call("housekeeping.startTask", { task_id: other.taskId }, "front_desk")).status).toBe(403);
  });
});

describe("housekeeping S-007…S-009 — nghiệm thu, tự nghiệm thu, chuyển trạng thái sai", () => {
  it("S-007: quản lý nghiệm thu đạt → verified, phòng inspected, verified_by, audit; getUnitStatus ready_for_arrival khi trống và active", async () => {
    const { taskId, unitId } = await taskAt("done");
    expect(await hk(unitId)).toBe("clean");
    const r = await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "manager");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "verified" });
    expect(await taskRow(taskId)).toMatchObject({
      status: "verified",
      verified_by: members.manager?.membershipId,
    });
    expect(await hk(unitId)).toBe("inspected");
    expect(await auditCount("housekeeping.task_verified", taskId)).toBe(1);
    const st = await query("inventory.getUnitStatus", { unit_id: unitId }, "manager");
    expect(st.body.data).toMatchObject({
      housekeeping: "inspected",
      occupancy: "vacant",
      availability: "active",
      ready_for_arrival: true,
    });
  });

  it("S-007: không đạt cần lý do (422); không đạt → về assigned cho cùng người, phòng assigned, lý do vào ghi chú; làm lại rồi đạt (Q-05)", async () => {
    const { taskId, unitId } = await taskAt("done");
    expect(
      (await call("housekeeping.verifyTask", { task_id: taskId, result: "fail" }, "manager")).body,
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      (await call("housekeeping.verifyTask", { task_id: taskId, result: "fail", reason: "  " }, "manager"))
        .status,
    ).toBe(422);
    expect((await taskRow(taskId)).status).toBe("done");
    const r = await call(
      "housekeeping.verifyTask",
      { task_id: taskId, result: "fail", reason: "Còn tóc trong phòng tắm" },
      "manager",
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await taskRow(taskId)).toMatchObject({
      status: "assigned",
      assignee_membership_id: members.H1?.membershipId,
      done_by: null,
      note: "Còn tóc trong phòng tắm",
    });
    expect(await hk(unitId)).toBe("assigned");
    expect(await auditCount("housekeeping.task_rejected", taskId)).toBe(1);
    await ok(call("housekeeping.startTask", { task_id: taskId }, "H1"));
    await ok(call("housekeeping.completeTask", { task_id: taskId }, "H1"));
    await ok(call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "manager"));
    expect(await hk(unitId)).toBe("inspected");
  });

  it("S-007 (Q-01): buồng phòng/kế toán không nghiệm thu; lễ tân chỉ khi cơ sở bật front_desk_can_inspect (mặc định tắt)", async () => {
    const { taskId } = await taskAt("done");
    for (const who of ["H1", "H2"])
      expect(
        (await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, who)).status,
        who,
      ).toBe(403);
    // Kế toán/kỹ thuật không đọc được việc buồng phòng (RLS) → 404 như dữ liệu không tồn tại.
    for (const who of ["accountant", "maintenance"])
      expect(
        (await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, who)).status,
        who,
      ).toBe(404);
    expect(
      (await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "front_desk")).body,
    ).toMatchObject({ code: "FORBIDDEN" });
    expect((await taskRow(taskId)).status).toBe("done");
    await sql`update properties set settings = settings || '{"front_desk_can_inspect": true}'::jsonb where id = ${A.propertyId}`.execute(
      t.admin,
    );
    try {
      expect(
        (await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "front_desk")).status,
      ).toBe(200);
      expect((await taskRow(taskId)).verified_by).toBe(members.front_desk?.membershipId);
      // Bật cờ không mở quyền cho buồng phòng.
      const other = await taskAt("done");
      expect(
        (await call("housekeeping.verifyTask", { task_id: other.taskId, result: "pass" }, "H1")).status,
      ).toBe(403);
    } finally {
      await sql`update properties set settings = settings - 'front_desk_can_inspect' where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
    const again = await taskAt("done");
    expect(
      (await call("housekeeping.verifyTask", { task_id: again.taskId, result: "pass" }, "front_desk")).status,
    ).toBe(403);
  });

  it("S-008: người làm không tự nghiệm thu → 403 SELF_APPROVAL_FORBIDDEN, việc vẫn done; người khác nghiệm thu được; tắt tách quyền thì được tự nghiệm thu", async () => {
    const { taskId, unitId } = await newTask();
    await ok(call("housekeeping.claimTask", { task_id: taskId }, "manager"));
    await ok(call("housekeeping.startTask", { task_id: taskId }, "manager"));
    await ok(call("housekeeping.completeTask", { task_id: taskId }, "manager"));
    const self = await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "manager");
    expect(self).toMatchObject({ status: 403, body: { code: "SELF_APPROVAL_FORBIDDEN" } });
    expect((await taskRow(taskId)).status).toBe("done");
    expect(await hk(unitId)).toBe("clean");
    // Phòng thủ ở CSDL: bỏ qua lớp app, update trực tiếp bằng kết nối runtime của chính người làm vẫn bị chặn.
    const e = await pgError(
      asRuntime("manager", (trx) =>
        sql`update tasks set status = 'verified', verified_by = ${members.manager?.membershipId}, verified_at = now() where id = ${taskId}`.execute(
          trx,
        ),
      ),
    );
    expect(e).toMatchObject({ code: "42501", hint: "SELF_APPROVAL_FORBIDDEN" });
    expect(
      (await call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "manager2")).status,
    ).toBe(200);

    await sql`update properties set settings = settings || '{"separate_task_verification": false}'::jsonb where id = ${A.propertyId}`.execute(
      t.admin,
    );
    try {
      const x = await newTask();
      await ok(call("housekeeping.claimTask", { task_id: x.taskId }, "manager"));
      await ok(call("housekeeping.startTask", { task_id: x.taskId }, "manager"));
      await ok(call("housekeeping.completeTask", { task_id: x.taskId }, "manager"));
      expect(
        (await call("housekeeping.verifyTask", { task_id: x.taskId, result: "pass" }, "manager")).status,
      ).toBe(200);
    } finally {
      await sql`update properties set settings = settings - 'separate_task_verification' where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
  });

  const CASES: { from: Stage; to: string; run: (id: string) => Promise<{ status: number; body: Json }> }[] = [
    { from: "open", to: "done", run: (id) => call("housekeeping.completeTask", { task_id: id }, "manager") },
    {
      from: "open",
      to: "verified",
      run: (id) => call("housekeeping.verifyTask", { task_id: id, result: "pass" }, "manager"),
    },
    {
      from: "verified",
      to: "in_progress",
      run: (id) => call("housekeeping.startTask", { task_id: id }, "H1"),
    },
    {
      from: "cancelled",
      to: "assigned",
      run: (id) =>
        call(
          "housekeeping.assignTask",
          { task_id: id, assignee_membership_id: members.H1?.membershipId },
          "manager",
        ),
    },
    { from: "done", to: "in_progress", run: (id) => call("housekeeping.startTask", { task_id: id }, "H1") },
    // Thêm ngoài bảng ví dụ của SPEC: các cặp dễ nhầm với chuyển hợp lệ khác của máy.
    {
      from: "done",
      to: "assigned",
      run: (id) =>
        call(
          "housekeeping.assignTask",
          { task_id: id, assignee_membership_id: members.H2?.membershipId },
          "manager",
        ),
    },
    {
      from: "in_progress",
      to: "assigned",
      run: (id) =>
        call(
          "housekeeping.assignTask",
          { task_id: id, assignee_membership_id: members.H2?.membershipId },
          "manager",
        ),
    },
    {
      from: "in_progress",
      to: "verified",
      run: (id) => call("housekeeping.verifyTask", { task_id: id, result: "pass" }, "manager"),
    },
    {
      from: "verified",
      to: "cancelled",
      run: (id) => call("housekeeping.cancelTask", { task_id: id, reason: "nhầm" }, "manager"),
    },
    {
      from: "done",
      to: "cancelled",
      run: (id) => call("housekeeping.cancelTask", { task_id: id, reason: "nhầm" }, "manager"),
    },
    {
      from: "cancelled",
      to: "cancelled",
      run: (id) => call("housekeeping.cancelTask", { task_id: id, reason: "lần hai" }, "manager"),
    },
    { from: "assigned", to: "done", run: (id) => call("housekeeping.completeTask", { task_id: id }, "H1") },
    {
      from: "cancelled",
      to: "assigned (tự nhận)",
      run: (id) => call("housekeeping.claimTask", { task_id: id }, "H1"),
    },
    {
      from: "done",
      to: "assigned (tự nhận)",
      run: (id) => call("housekeeping.claimTask", { task_id: id }, "H1"),
    },
  ];
  it.each(CASES)(
    "S-009: $from → $to → 409 INVALID_TRANSITION, trạng thái không đổi, audit lần từ chối",
    async (c) => {
      const { taskId, unitId } = await taskAt(c.from);
      const before = await taskRow(taskId);
      const unitBefore = await hk(unitId);
      const r = await c.run(taskId);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
      const after = await taskRow(taskId);
      expect(after).toEqual(before);
      expect(await hk(unitId)).toBe(unitBefore);
      const denied = await rows(
        sql<{
          reason: string;
          outcome: string;
        }>`select reason, outcome from audit_events where outcome = 'denied' and action = 'command.denied' and correlation_id = ${r.body.correlation_id}`,
      );
      expect(denied).toEqual([{ reason: "INVALID_TRANSITION", outcome: "denied" }]);
    },
  );
});

describe("housekeeping huỷ việc, việc cũ bị thay thế, S-010 sạch ≠ trống", () => {
  it("cancelTask: lý do bắt buộc; buồng phòng 403; phòng assigned/cleaning về dirty (chưa dọn xong); việc đã clean/inspected giữ nguyên", async () => {
    const a = await taskAt("in_progress");
    expect(await hk(a.unitId)).toBe("cleaning");
    expect((await call("housekeeping.cancelTask", { task_id: a.taskId, reason: "x" }, "H1")).status).toBe(
      403,
    );
    expect(
      (await call("housekeeping.cancelTask", { task_id: a.taskId, reason: "  " }, "manager")).status,
    ).toBe(422);
    expect(
      (
        await call(
          "housekeeping.cancelTask",
          { task_id: a.taskId, reason: "Khách ở thêm một đêm" },
          "front_desk",
        )
      ).status,
    ).toBe(200);
    expect(await taskRow(a.taskId)).toMatchObject({ status: "cancelled" });
    expect(await hk(a.unitId)).toBe("dirty");
    // Huỷ xong thì phòng nhận được việc mới.
    expect((await call("housekeeping.createTask", { unit_id: a.unitId }, "manager")).status).toBe(201);
    // Phòng đã clean (việc done) mà việc không huỷ được (done → cancelled không hợp lệ).
    const d = await taskAt("done");
    expect(
      (await call("housekeeping.cancelTask", { task_id: d.taskId, reason: "x" }, "manager")).status,
    ).toBe(409);
    expect(await hk(d.unitId)).toBe("clean");
  });

  it("việc cũ done chờ nghiệm thu bị việc mới thay thế: nghiệm thu muộn không biến phòng bẩn thành 'đã kiểm'", async () => {
    const old = await taskAt("done");
    expect(await hk(old.unitId)).toBe("clean");
    const fresh = await asRuntime("manager", (trx) =>
      openCleaningTask(trx, {
        orgId: A.orgId,
        propertyId: A.propertyId,
        unitId: old.unitId,
        source: { type: "stay", id: randomUUID() },
      }),
    );
    expect(fresh.created).toBe(true);
    expect(await hk(old.unitId)).toBe("dirty");
    await ok(call("housekeeping.verifyTask", { task_id: old.taskId, result: "pass" }, "manager"));
    expect((await taskRow(old.taskId)).status).toBe("verified");
    expect(await hk(old.unitId)).toBe("dirty");
  });

  it("S-010: phòng inspected nhưng có khách đang ở → vẫn occupied, không bán/không sẵn sàng nhận; các lệnh việc không đổi chiếm dụng", async () => {
    const { taskId, unitId } = await taskAt("done");
    const alloc = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${alloc}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay', 'stay', ${randomUUID()},
                      tstzrange(${new Date(Date.now() - 3_600_000)}, ${new Date(Date.now() + 86_400_000)}, '[)'))`.execute(
      t.admin,
    );
    const before = await rows(
      sql<
        Record<string, unknown>
      >`select id, kind, active, during::text as d from allocations where unit_id = ${unitId}`,
    );
    await ok(call("housekeeping.verifyTask", { task_id: taskId, result: "pass" }, "manager"));
    expect(await hk(unitId)).toBe("inspected");
    const st = await query("inventory.getUnitStatus", { unit_id: unitId }, "front_desk");
    expect(st.body.data).toMatchObject({
      housekeeping: "inspected",
      occupancy: "occupied",
      availability: "active",
      sellable: false,
      ready_for_arrival: false,
    });
    expect(
      await rows(
        sql<
          Record<string, unknown>
        >`select id, kind, active, during::text as d from allocations where unit_id = ${unitId}`,
      ),
    ).toEqual(before);
    expect((await one(sql<{ a: string }>`select availability as a from units where id = ${unitId}`)).a).toBe(
      "active",
    );
  });
});

describe("housekeeping createTask thủ công", () => {
  it("createTask: tạo việc dọn/kiểm tra; việc dọn trùng việc mở → trả việc cũ (không tạo mới); phòng không tồn tại/khác tổ chức → 404; buồng phòng 403; ghi chú dài → 422", async () => {
    const unitId = await newUnit();
    const a = await call(
      "housekeeping.createTask",
      { unit_id: unitId, note: "  Phòng 2 giường — Ünïcode ✓  " },
      "front_desk",
    );
    expect(a).toMatchObject({ status: 201, body: { data: { created: true, status: "open" } } });
    expect(await taskRow(a.body.data.task_id)).toMatchObject({ note: "Phòng 2 giường — Ünïcode ✓" });
    expect(await hk(unitId)).toBe("dirty");
    const b = await call("housekeeping.createTask", { unit_id: unitId }, "manager");
    expect(b).toMatchObject({
      status: 200,
      body: { data: { task_id: a.body.data.task_id, created: false } },
    });
    expect((await taskRow(a.body.data.task_id)).extra_sources).toHaveLength(1);
    expect(await tasksOfUnit(unitId)).toHaveLength(1);
    const insp = await call("housekeeping.createTask", { unit_id: unitId, kind: "inspection" }, "manager");
    expect(insp.status).toBe(201);
    expect(await tasksOfUnit(unitId)).toHaveLength(2);
    expect(await hk(unitId)).toBe("dirty"); // kiểm tra không đụng chiều vệ sinh
    expect((await call("housekeeping.createTask", { unit_id: randomUUID() }, "manager")).status).toBe(404);
    expect((await call("housekeeping.createTask", { unit_id: B.unitId }, "manager")).status).toBe(404);
    expect((await call("housekeeping.createTask", { unit_id: await newUnit() }, "H1")).status).toBe(403);
    expect(
      (await call("housekeeping.createTask", { unit_id: await newUnit(), note: "x".repeat(2001) }, "manager"))
        .status,
    ).toBe(422);
    expect((await call("housekeeping.createTask", { unit_id: P2.unitId }, "manager2")).status).toBe(404); // cơ sở CS2 ngoài phạm vi của manager2
  });
});

describe("housekeeping S-020/S-022 — riêng tư và chéo tenant", () => {
  it("S-020: chi tiết việc chỉ có trường cho phép; bảng tasks không có cột tiền/khách/giấy tờ; kế toán/kỹ thuật không đọc được (app 403/404 + RLS 0 hàng)", async () => {
    const { taskId } = await taskAt("done");
    const r = await query("housekeeping.getTask", { task_id: taskId }, "H1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual([...TASK_VIEW_FIELDS].sort());
    const cols = await rows(
      sql<{
        c: string;
      }>`select column_name as c from information_schema.columns where table_name = 'tasks' and table_schema = 'public'`,
    );
    expect(
      cols
        .map((x) => x.c)
        .filter((c) =>
          /amount|price|total|balance|money|phone|email|guest|person_id|document|doc_|cccd|name$/i.test(c),
        ),
    ).toEqual([]);
    for (const who of ["accountant", "maintenance"]) {
      expect((await query("housekeeping.getTask", { task_id: taskId }, who)).status, who).toBe(404);
      expect((await query("housekeeping.listTasks", { property_id: A.propertyId }, who)).status, who).toBe(
        403,
      );
      expect(await visibleRows(who, "tasks"), who).toBe(0);
    }
    expect(await visibleRows("H1", "tasks")).toBeGreaterThan(0);
    // Buồng phòng không phạm vi cơ sở nào: thấy 0 hàng, getTask 404.
    expect(await visibleRows("Hphụ", "tasks")).toBe(0);
    expect((await query("housekeeping.getTask", { task_id: taskId }, "Hphụ")).status).toBe(404);
    expect((await query("housekeeping.listTasks", { property_id: A.propertyId }, "Hphụ")).status).toBe(404);
  });

  it("S-022: việc/cơ sở của tổ chức khác → 404, danh sách không có hàng của B; cơ sở khác trong cùng tổ chức nhưng ngoài phạm vi → 404", async () => {
    const bUnit = B.unitId;
    const tB = randomUUID();
    await sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type)
              values (${tB}, ${B.orgId}, ${B.propertyId}, ${bUnit}, 'cleaning', 'manual')`.execute(t.admin);
    for (const who of ["manager", "H1", "owner"]) {
      expect((await query("housekeeping.getTask", { task_id: tB }, who)).status, who).toBe(404);
      expect((await query("housekeeping.listTasks", { property_id: B.propertyId }, who)).status, who).toBe(
        404,
      );
      for (const cmd of ["claimTask", "startTask", "completeTask"])
        expect((await call(`housekeeping.${cmd}`, { task_id: tB }, who)).status, `${who} ${cmd}`).toBe(404);
    }
    expect((await call("housekeeping.cancelTask", { task_id: tB, reason: "x" }, "owner")).status).toBe(404);
    expect((await call("housekeeping.verifyTask", { task_id: tB, result: "pass" }, "owner")).status).toBe(
      404,
    );
    const leak = await asRuntime(
      "owner",
      async (trx) =>
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from tasks where organization_id <> ${A.orgId}`.execute(trx)
        ).rows[0]?.n,
    );
    expect(leak).toBe(0);
    const list = await query("housekeeping.listTasks", { property_id: A.propertyId, limit: "500" }, "owner");
    expect((list.body.data.tasks as Json[]).some((x) => x.property_id === B.propertyId)).toBe(false);
    expect((await taskRow(tB)).status).toBe("open");

    // Cùng tổ chức, cơ sở CS2: H1 (chỉ CS1) → 404; owner (mọi cơ sở) thấy.
    const tP2 = randomUUID();
    await sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type)
              values (${tP2}, ${A.orgId}, ${P2.propertyId}, ${P2.unitId}, 'cleaning', 'manual')`.execute(
      t.admin,
    );
    expect((await query("housekeeping.getTask", { task_id: tP2 }, "H1")).status).toBe(404);
    expect((await query("housekeeping.listTasks", { property_id: P2.propertyId }, "H1")).status).toBe(404);
    expect((await call("housekeeping.claimTask", { task_id: tP2 }, "H1")).status).toBe(404);
    expect((await query("housekeeping.getTask", { task_id: tP2 }, "owner")).status).toBe(200);
  });
});

describe("housekeeping S-023 — audit cùng transaction; hàng rào CSDL", () => {
  it("S-023: lệnh lỗi không để lại audit thành công/đổi trạng thái; lệnh thành công có đúng một audit có người + trước/sau", async () => {
    const { taskId } = await taskAt("done");
    const before = await auditCount("housekeeping.task_rejected", taskId);
    expect(
      (await call("housekeeping.verifyTask", { task_id: taskId, result: "fail" }, "manager")).status,
    ).toBe(422);
    expect(await auditCount("housekeeping.task_rejected", taskId)).toBe(before);
    expect((await taskRow(taskId)).status).toBe("done");
    await ok(
      call("housekeeping.verifyTask", { task_id: taskId, result: "fail", reason: "Chưa sạch" }, "manager"),
    );
    const au = await one(
      sql<{
        actor_person_id: string;
        before: { status: string };
        after: { status: string };
        reason: string;
        outcome: string;
      }>`
        select actor_person_id, before, after, reason, outcome from audit_events where action = 'housekeeping.task_rejected' and entity_id = ${taskId}`,
    );
    expect(au).toMatchObject({
      actor_person_id: members.manager?.personId,
      before: { status: "done" },
      after: { status: "assigned" },
      reason: "Chưa sạch",
      outcome: "success",
    });
  });

  it("CSDL (RLS + trigger, kết nối runtime): buồng phòng không tạo việc, không nhận việc đã giao, không nhảy trạng thái, không nghiệm thu; việc kết thúc bất biến", async () => {
    const a = await taskAt("assigned"); // giao cho H1
    const stolen = await asRuntime(
      "H2",
      async (trx) =>
        (await sql`update tasks set status = 'in_progress' where id = ${a.taskId} returning id`.execute(trx))
          .rows,
    );
    expect(stolen).toHaveLength(0); // RLS: không thấy là việc của mình → 0 hàng
    const skip = await pgError(
      asRuntime("H1", (trx) =>
        sql`update tasks set status = 'done', done_by = ${members.H1?.membershipId}, done_at = now() where id = ${a.taskId}`.execute(
          trx,
        ),
      ),
    );
    expect(skip).toMatchObject({ code: "23514", hint: "INVALID_TRANSITION" });
    const gift = await pgError(
      asRuntime("H1", (trx) =>
        sql`update tasks set assignee_membership_id = ${members.H2?.membershipId} where id = ${a.taskId}`.execute(
          trx,
        ),
      ),
    );
    expect(gift.code).toBeTruthy(); // WITH CHECK (RLS 42501) hoặc trigger
    const ins = await pgError(
      asRuntime("H1", (trx) =>
        sql`insert into tasks (id, organization_id, property_id, unit_id, kind, source_type)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${a.unitId}, 'inspection', 'manual')`.execute(
          trx,
        ),
      ),
    );
    expect(ins.code).toBe("42501");
    const d = await taskAt("done");
    const ver = await pgError(
      asRuntime("H1", (trx) =>
        sql`update tasks set status = 'verified', verified_by = ${members.H1?.membershipId}, verified_at = now() where id = ${d.taskId}`.execute(
          trx,
        ),
      ),
    );
    expect(ver.code).toBe("42501");
    const fd = await pgError(
      asRuntime("front_desk", (trx) =>
        sql`update tasks set status = 'verified', verified_by = ${members.front_desk?.membershipId}, verified_at = now() where id = ${d.taskId}`.execute(
          trx,
        ),
      ),
    );
    expect(fd).toMatchObject({ code: "42501", hint: "FORBIDDEN" });
    const v = await taskAt("verified");
    const reopen = await pgError(
      asRuntime("manager", (trx) =>
        sql`update tasks set status = 'in_progress' where id = ${v.taskId}`.execute(trx),
      ),
    );
    expect(reopen).toMatchObject({ code: "23514", hint: "INVALID_TRANSITION" });
    const move = await pgError(
      asRuntime("manager", (trx) =>
        sql`update tasks set unit_id = ${A.unitId} where id = ${a.taskId}`.execute(trx),
      ),
    );
    expect(move).toMatchObject({ hint: "DOCUMENT_IMMUTABLE" });
    const noDelete = await pgError(
      asRuntime("owner", (trx) => sql`delete from tasks where id = ${a.taskId}`.execute(trx)),
    );
    expect(noDelete.code).toBe("42501");
    expect((await taskRow(a.taskId)).status).toBe("assigned");
  });
});
