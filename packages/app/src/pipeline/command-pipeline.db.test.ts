// T-008 — command pipeline trên Postgres thật: INV-G5 (idempotency), INV-G6 (audit + outbox cùng transaction),
// SEC-LOG-007 (audit append-only), DB-TX-002 (retry 40001), COMMAND_NOT_FOUND.
import { randomUUID } from "node:crypto";
import { REQUEST_TX_RETRY } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type CommandContext, executeCommand, getCommandResult } from "./command.ts";
import { CommandError } from "./problem.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let staff: Actor;

async function counts(orgId: string) {
  const r = await sql<{ a: number; o: number; p: number }>`
    select (select count(*) from audit_events where organization_id = ${orgId} and outcome = 'success')::int as a,
           (select count(*) from outbox where organization_id = ${orgId})::int as o,
           (select count(*) from persons where organization_id = ${orgId} and full_name like 'KH %')::int as p`.execute(
    t.admin,
  );
  return r.rows[0] as { a: number; o: number; p: number };
}

/** Command mẫu: tạo một cá nhân + audit + outbox. */
function createPerson(name: string) {
  return async (ctx: CommandContext) => {
    const id = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${id}, ${ctx.actor.orgId}, ${name})`.execute(
      ctx.trx,
    );
    await ctx.audit({
      action: "person.created",
      entityType: "person",
      entityId: id,
      after: { full_name: name },
    });
    await ctx.emit({
      eventType: "person.created",
      aggregateType: "person",
      aggregateId: id,
      payload: { person_id: id },
    });
    return { data: { id }, httpStatus: 201 };
  };
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS pipeline");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  const user = await seedAuthUser(t.admin, `bp+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Buồng phòng')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role) values (${randomUUID()}, ${A.orgId}, ${user}, ${person}, 'housekeeping')`.execute(
    t.admin,
  );
  staff = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: false });
});

afterAll(async () => {
  await t.drop();
});

describe("idempotency (INV-G5)", () => {
  it("cùng key + cùng payload gửi 2 lần → một hiệu lực, lần 2 trả kết quả cũ", async () => {
    const before = await counts(A.orgId);
    const key = randomUUID();
    const req = {
      command: "person.create",
      idempotencyKey: key,
      payload: { name: "KH Một" },
      correlationId: "c-1",
    };
    const r1 = await executeCommand(t.runtime, owner, req, createPerson("KH Một"));
    const r2 = await executeCommand(t.runtime, owner, req, createPerson("KH Một"));
    expect(r1).toMatchObject({ status: "committed", httpStatus: 201, replayed: false });
    expect(r2).toMatchObject({ status: "committed", httpStatus: 201, replayed: true });
    expect(r2.status === "committed" && r1.status === "committed" && r2.data).toEqual(
      r1.status === "committed" && r1.data,
    );
    const after = await counts(A.orgId);
    expect(after).toEqual({ a: before.a + 1, o: before.o + 1, p: before.p + 1 });
  });

  it("100 request song song cùng key → đúng 1 hiệu lực nghiệp vụ", async () => {
    const before = await counts(A.orgId);
    const key = randomUUID();
    const req = {
      command: "person.create",
      idempotencyKey: key,
      payload: { name: "KH Song song" },
      correlationId: "c-p",
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => executeCommand(t.runtime, owner, req, createPerson("KH Song song"))),
    );
    expect(results.every((r) => r.status === "committed")).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const after = await counts(A.orgId);
    expect(after).toEqual({ a: before.a + 1, o: before.o + 1, p: before.p + 1 });
  });

  it("cùng key + khác payload → 409 IDEMPOTENCY_CONFLICT", async () => {
    const key = randomUUID();
    await executeCommand(
      t.runtime,
      owner,
      { command: "person.create", idempotencyKey: key, payload: { name: "KH A" }, correlationId: "c" },
      createPerson("KH A"),
    );
    await expect(
      executeCommand(
        t.runtime,
        owner,
        { command: "person.create", idempotencyKey: key, payload: { name: "KH B" }, correlationId: "c" },
        createPerson("KH B"),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("thiếu/sai Idempotency-Key → 400 MALFORMED_REQUEST", async () => {
    await expect(
      executeCommand(
        t.runtime,
        owner,
        { command: "person.create", idempotencyKey: undefined, payload: {}, correlationId: "c" },
        createPerson("x"),
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_REQUEST", status: 400 });
  });
});

describe("audit + outbox cùng transaction (INV-G6)", () => {
  it("handler lỗi nghiệp vụ → rollback hết (không người, không outbox), kết quả failed lưu lại và replay trả cùng lỗi", async () => {
    const before = await counts(A.orgId);
    const key = randomUUID();
    const failing = async (ctx: CommandContext) => {
      await createPerson("KH Rollback")(ctx);
      throw new CommandError("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ");
    };
    const req = {
      command: "person.create",
      idempotencyKey: key,
      payload: { name: "KH Rollback" },
      correlationId: "c-r",
    };
    const r1 = await executeCommand(t.runtime, owner, req, failing);
    expect(r1).toMatchObject({ status: "failed", httpStatus: 422, problem: { code: "VALIDATION_FAILED" } });
    expect(await counts(A.orgId)).toEqual(before);
    const denied = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where command_id = ${key} and outcome = 'denied'`.execute(
      t.admin,
    );
    expect(denied.rows[0]?.n).toBe(1);
    const r2 = await executeCommand(t.runtime, owner, req, createPerson("KH Rollback"));
    expect(r2).toMatchObject({ status: "failed", replayed: true, problem: { code: "VALIDATION_FAILED" } });
    expect(await counts(A.orgId)).toEqual(before);
  });

  it("vi phạm ràng buộc CSDL được dịch sang mã nghiệp vụ (không lộ SQL)", async () => {
    const r = await executeCommand(
      t.runtime,
      owner,
      {
        command: "unit.create",
        idempotencyKey: randomUUID(),
        payload: { code: "101" },
        correlationId: "c-u",
      },
      async (ctx) => {
        await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, '101')`.execute(
          ctx.trx,
        );
        return { data: null };
      },
    );
    expect(r).toMatchObject({ status: "failed", httpStatus: 409 });
    expect(JSON.stringify(r)).not.toMatch(/duplicate key|uq_units_code/);
  });
});

describe("retry lỗi serialization (DB-TX-002)", () => {
  it("40001 lần đầu → tự chạy lại và thành công một lần", async () => {
    let calls = 0;
    const before = await counts(A.orgId);
    const r = await executeCommand(
      t.runtime,
      owner,
      {
        command: "person.create",
        idempotencyKey: randomUUID(),
        payload: { name: "KH Retry" },
        correlationId: "c-s",
      },
      async (ctx) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("could not serialize access"), { code: "40001" });
        return createPerson("KH Retry")(ctx);
      },
    );
    expect(r.status).toBe("committed");
    expect(calls).toBe(2);
    expect((await counts(A.orgId)).p).toBe(before.p + 1);
  });
});

describe("retry lỗi transaction thật trên Postgres (DB-TX-002, ARC-RES-002)", () => {
  /** Chốt chặn cho hai lệnh: cả hai đã giữ khoá đầu của mình thì mới cùng xin khoá thứ hai ⇒ deadlock thật. */
  function barrier(n: number) {
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    return async () => {
      if (++arrived === n) open();
      await gate;
    };
  }

  async function twoPersons(): Promise<[string, string]> {
    const ids: [string, string] = [randomUUID(), randomUUID()];
    for (const id of ids)
      await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, ${`KH khoá ${id.slice(0, 4)}`})`.execute(
        t.admin,
      );
    return ids;
  }

  const lock = (ctx: CommandContext, id: string) =>
    sql`select id from persons where organization_id = ${ctx.actor.orgId} and id = ${id} for update`.execute(
      ctx.trx,
    );

  it("deadlock thật (40P01) giữa hai lệnh khoá chéo → nạn nhân tự chạy lại, cả hai commit; chờ có jitter trong trần", async () => {
    const [p1, p2] = await twoPersons();
    const before = await counts(A.orgId);
    const waits: number[] = [];
    const attempts = { x: 0, y: 0 };
    const meet = barrier(2);
    const run = (who: "x" | "y", first: string, second: string) =>
      executeCommand(
        t.runtime,
        owner,
        {
          command: "person.create",
          idempotencyKey: randomUUID(),
          payload: { who },
          correlationId: `c-dl-${who}`,
          // Jitter xác định: random = 0,8 ⇒ chờ = 0,8 · min(250, 25) = 20 ms; hàm chờ ghi lại, không ngủ thật.
          retry: { random: () => 0.8, sleep: async (ms) => void waits.push(ms) },
        },
        async (ctx) => {
          const n = ++attempts[who];
          await lock(ctx, first);
          if (n === 1) await meet(); // chỉ lần đầu: lần chạy lại không còn đối thủ giữ khoá chéo
          await lock(ctx, second);
          return createPerson(`KH Deadlock ${who}`)(ctx);
        },
      );
    const [rx, ry] = await Promise.all([run("x", p1, p2), run("y", p2, p1)]);
    expect(rx.status).toBe("committed");
    expect(ry.status).toBe("committed");
    // Đúng một nạn nhân: tổng 3 lần chạy handler, một lần chờ.
    expect(attempts.x + attempts.y).toBe(3);
    expect(waits).toEqual([20]);
    // Mỗi lệnh chỉ có MỘT hiệu lực dù handler của nạn nhân chạy 2 lần.
    const after = await counts(A.orgId);
    expect(after).toEqual({ a: before.a + 2, o: before.o + 2, p: before.p + 2 });
  });

  it("40001 mãi → chạy đúng maxAttempts lần rồi ném lỗi; transaction rollback, không để lại dấu vết", async () => {
    const before = await counts(A.orgId);
    const key = randomUUID();
    let calls = 0;
    const err = await executeCommand(
      t.runtime,
      owner,
      { command: "person.create", idempotencyKey: key, payload: {}, correlationId: "c-40001-mai" },
      async (ctx) => {
        calls++;
        await createPerson("KH Không bao giờ")(ctx);
        throw Object.assign(new Error("could not serialize access"), { code: "40001" });
      },
    ).catch((e: unknown) => e);
    // Không tiêm retry → chính sách mặc định REQUEST_TX_RETRY (chờ thật ≤ 250 ms mỗi lần): đúng số lần, không tác dụng phụ.
    expect((err as { code?: string }).code).toBe("40001");
    expect(calls).toBe(REQUEST_TX_RETRY.maxAttempts);
    expect(await counts(A.orgId)).toEqual(before);
    const k =
      await sql`select 1 from idempotency_keys where organization_id = ${A.orgId} and key = ${key}`.execute(
        t.admin,
      );
    expect(k.rows).toHaveLength(0);
  });

  it("lỗi vĩnh viễn (23505 / lỗi nghiệp vụ 422) → KHÔNG chạy lại, không chờ", async () => {
    for (const make of [
      () => Object.assign(new Error("duplicate"), { code: "23505" }),
      () => new CommandError("VALIDATION_FAILED", 422, "sai dữ liệu"),
    ]) {
      const waits: number[] = [];
      let calls = 0;
      await executeCommand(
        t.runtime,
        owner,
        {
          command: "person.create",
          idempotencyKey: randomUUID(),
          payload: {},
          correlationId: "c-vinh-vien",
          retry: { sleep: async (ms) => void waits.push(ms) },
        },
        async () => {
          calls++;
          throw make();
        },
      ).catch(() => {});
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it("trần thời gian: đồng hồ tiêm cho thấy hết ngân sách → bỏ cuộc sớm, ít lần chạy hơn maxAttempts", async () => {
    let clock = 0;
    let calls = 0;
    const err = await executeCommand(
      t.runtime,
      owner,
      {
        command: "person.create",
        idempotencyKey: randomUUID(),
        payload: {},
        correlationId: "c-tran",
        retry: {
          policy: { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 100, maxElapsedMs: 150 },
          random: () => 1,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      },
      async () => {
        calls++;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      },
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("40P01");
    expect(calls).toBe(2); // lần 1 → chờ 100 (còn 150) → lần 2 → còn 50 ≤ 100 ⇒ dừng
  });
});

describe("audit append-only (SEC-LOG-007)", () => {
  it("app_runtime không UPDATE/DELETE được audit_events", async () => {
    await expect(
      sql`select set_config('app.org_id', ${A.orgId}, false); update audit_events set reason = 'sửa'`.execute(
        t.runtime,
      ),
    ).rejects.toThrow();
    await expect(
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
        await sql`delete from audit_events`.execute(trx);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("kể cả owner bảng cũng bị trigger chặn sửa/xoá/truncate", async () => {
    await expect(sql`update audit_events set reason = 'x'`.execute(t.admin)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_events`.execute(t.admin)).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit_events`.execute(t.admin)).rejects.toThrow(/append-only/);
  });

  it("audit che dữ liệu nhạy cảm trước khi ghi", async () => {
    const key = randomUUID();
    await executeCommand(
      t.runtime,
      owner,
      { command: "person.update", idempotencyKey: key, payload: {}, correlationId: "c-m" },
      async (ctx) => {
        await ctx.audit({
          action: "person.updated",
          entityType: "person",
          after: { phone: "0100005678", cccd_number: "001234567890" },
        });
        return { data: null };
      },
    );
    const r = await sql<{
      after: Record<string, string>;
    }>`select after from audit_events where command_id = ${key}`.execute(t.admin);
    expect(r.rows[0]?.after).toEqual({ phone: "010****678", cccd_number: "***" });
  });
});

describe("GET /api/v1/commands/{id}", () => {
  it("người tạo xem được; người khác (không phải quản lý) → COMMAND_NOT_FOUND; id lạ → COMMAND_NOT_FOUND", async () => {
    const key = randomUUID();
    await executeCommand(
      t.runtime,
      owner,
      { command: "person.create", idempotencyKey: key, payload: { n: 1 }, correlationId: "c" },
      createPerson("KH Xem"),
    );
    expect(await getCommandResult(t.runtime, owner, key)).toMatchObject({
      status: "committed",
      httpStatus: 201,
    });
    await expect(getCommandResult(t.runtime, staff, key)).rejects.toMatchObject({
      code: "COMMAND_NOT_FOUND",
      status: 404,
    });
    await expect(getCommandResult(t.runtime, owner, randomUUID())).rejects.toMatchObject({
      code: "COMMAND_NOT_FOUND",
    });
  });
});
