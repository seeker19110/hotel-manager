// PLAN đợt 2 T-109 — hợp đồng: soạn, người ở, giữ chỗ, ký trên Postgres thật (SPEC-lease S-001…S-004, S-008…S-010,
// S-020, S-022…S-024; INV-G4, INV-I1, INV-I3).
import { createHash, randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { receiveDeposit } from "../deposits/deposits.ts";
import { confirmPayment } from "../payments/payments.ts";
import { canonicalJson, executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import { openShift } from "../shifts/shifts.ts";
import {
  addOccupant,
  type CreateDraftInput,
  cancelLease,
  createDraft,
  getLease,
  getPerson,
  holdLease,
  removeOccupant,
  signLease,
  submitForSignature,
  updateDraft,
} from "./lease.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let H: Actor;
let ELEC: string;

async function member(role: string, personId: string = randomUUID(), name = role): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${personId}, ${A.orgId}, ${name}, '0901000000')
            on conflict (id) do nothing`.execute(t.admin);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${personId}, ${role})`.execute(t.admin);
  if (!["tenant", "guest"].includes(role)) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

async function person(name: string, phone: string | null = "0912345678"): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${id}, ${A.orgId}, ${name}, ${phone})`.execute(
    t.admin,
  );
  return id;
}

async function unit(): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, ${`U${id.slice(0, 6)}`})`.execute(
    t.admin,
  );
  return id;
}

function run<T>(
  actor: Actor,
  fn: Parameters<typeof executeCommand<T>>[3],
  key = randomUUID(),
  payload: unknown = { key },
) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "lease.test", idempotencyKey: key, payload, correlationId: "c-lease" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as {
    code: string;
    status: number;
    from?: string;
    to?: string;
    errors?: { path: string; field: string }[];
  };
}

const terms = (over: Partial<CreateDraftInput["terms"]> = {}): CreateDraftInput["terms"] => ({
  effectiveFrom: "2026-11-01",
  effectiveTo: "2027-10-31",
  rentAmount: 3_000_000,
  depositAmount: 3_000_000,
  services: [{ serviceId: ELEC, quantity: 1 }],
  ...over,
});

const draft = (
  a: Actor,
  input: Partial<CreateDraftInput> & Pick<CreateDraftInput, "unitId" | "representativePersonId">,
) =>
  run(a, async (ctx) => ({
    data: await createDraft(ctx, {
      billingStartOn: "2026-11-01",
      signedOn: "2026-10-20",
      terms: terms(),
      ...input,
    }),
  }));

async function pendingLease(unitId?: string, rep?: string) {
  const u = unitId ?? (await unit());
  const p = rep ?? (await person("Người thuê"));
  const { leaseId } = await ok(draft(M, { unitId: u, representativePersonId: p }));
  await ok(run(M, async (ctx) => ({ data: await submitForSignature(ctx, { leaseId }) })));
  return { leaseId, unitId: u, personId: p };
}

const allocationsOf = async (leaseId: string) =>
  (
    await sql<{
      id: string;
      kind: string;
      active: boolean;
      lower: Date;
      upper: Date | null;
      expires_at: Date | null;
    }>`
      select id, kind, active, lower(during) as lower, upper(during) as upper, expires_at from allocations
      where source_type = 'lease' and source_id = ${leaseId} order by created_at`.execute(t.admin)
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ hợp đồng", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
  H = await member("housekeeping");
  ELEC = randomUUID();
  await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
            values (${ELEC}, ${A.orgId}, ${A.propertyId}, 'DIEN', 'Điện', 'metered', 'REV_UTIL', 'electric')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("S-001…S-003 soạn và ký", () => {
  it("S-001: nháp + phiên bản 1, bốn mốc ngày tách biệt, người đại diện, chưa giữ phòng", async () => {
    const u = await unit();
    const a = await person("Người thuê A");
    const r = await ok(draft(M, { unitId: u, representativePersonId: a }));
    expect(r.number).toMatch(/^HD-\d{6}$/);
    const l = await getLease(t.runtime, M, r.leaseId);
    expect(l).toMatchObject({
      status: "draft",
      signed_on: "2026-10-20",
      billing_start_on: "2026-11-01",
      moved_out_on: null,
      representative_person_id: a,
    });
    expect(l.versions).toEqual([
      expect.objectContaining({
        version_no: 1,
        kind: "original",
        rent_amount: 3_000_000,
        deposit_amount: 3_000_000,
        effective_from: "2026-11-01",
        effective_to: "2027-10-31",
        terms_hash: null,
        services: [{ service_id: ELEC, quantity: 1 }],
      }),
    ]);
    expect(l.occupants).toEqual([
      { person_id: a, role: "primary", is_representative: true, from_on: "2026-11-01", to_on: null },
    ]);
    expect(await allocationsOf(r.leaseId)).toEqual([]);
  });

  it("S-001 (đầu vào): lỗi theo trường; lễ tân không lập hợp đồng; buồng phòng không thấy", async () => {
    const u = await unit();
    const a = await person("Người thuê kiểm");
    const noPhone = await person("Không SĐT", null);
    const cases: [Partial<CreateDraftInput>, string][] = [
      [{ terms: terms({ effectiveTo: "2026-10-31" }) }, "terms.effective_to"],
      [{ representativePersonId: noPhone }, "representative_person_id.phone"],
      [
        { terms: terms({ services: [{ serviceId: randomUUID(), quantity: 1 }] }) },
        "terms.services[0].service_id",
      ],
      [{ terms: terms({ rentAmount: -1 }) }, "terms.rent_amount"],
      [{ billingStartOn: "2026-02-30" }, "billing_start_on"],
      [{ occupants: [{ personId: noPhone, role: "co_tenant" }] }, "occupants[0].person_id.phone"],
    ];
    for (const [over, field] of cases) {
      const p = await fails(draft(M, { unitId: u, representativePersonId: a, ...over }));
      expect(p).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
      expect(p.errors?.[0]).toEqual({ path: field, field, code: expect.any(String) });
    }
    expect(await fails(draft(F, { unitId: u, representativePersonId: a }))).toMatchObject({ status: 403 });
    expect(await fails(draft(H, { unitId: u, representativePersonId: a }))).toMatchObject({ status: 403 });
  });

  it("S-002: ký → signed_awaiting_handover, đóng băng điều khoản (SHA-256), allocation lease từ 00:00 giờ VN", async () => {
    const { leaseId, personId } = await pendingLease();
    const wrong = await fails(
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: randomUUID() }) })),
    );
    expect(wrong.errors?.[0]?.field).toBe("signer_person_id");
    const r = await ok(
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: personId }) })),
    );
    expect(r.status).toBe("signed_awaiting_handover");
    const v = await sql<{ terms_snapshot: Record<string, unknown>; terms_hash: string; signed_at: Date }>`
      select terms_snapshot, terms_hash, signed_at from lease_versions where lease_id = ${leaseId}`.execute(
      t.admin,
    );
    const row = v.rows[0] as { terms_snapshot: Record<string, unknown>; terms_hash: string };
    expect(row.terms_hash).toBe(r.termsHash);
    expect(createHash("sha256").update(canonicalJson(row.terms_snapshot)).digest("hex")).toBe(row.terms_hash);
    expect(row.terms_snapshot).toMatchObject({
      rent_amount: 3_000_000,
      effective_from: "2026-11-01",
      signed_on: "2026-10-20",
    });
    const al = await allocationsOf(leaseId);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "lease", active: true, expires_at: null });
    expect(al[0]?.lower.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(al[0]?.upper?.toISOString()).toBe("2027-10-31T17:00:00.000Z");
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'lease.signed' and entity_id = ${leaseId}`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("S-003: sửa điều khoản sau ký → 409 DOCUMENT_IMMUTABLE (lệnh và CSDL); trước ký sửa được", async () => {
    const { leaseId, personId } = await pendingLease();
    await ok(
      run(M, async (ctx) => ({
        data: await updateDraft(ctx, { leaseId, terms: terms({ rentAmount: 3_100_000 }) }),
      })),
    );
    await ok(run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: personId }) })));
    const p = await fails(
      run(M, async (ctx) => ({
        data: await updateDraft(ctx, { leaseId, terms: terms({ rentAmount: 2_800_000 }) }),
      })),
    );
    expect(p).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    const direct = await sql`update lease_versions set rent_amount = 2800000 where lease_id = ${leaseId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    const changeRep = await sql`update leases set billing_start_on = '2026-12-01' where id = ${leaseId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(changeRep)).toMatchObject({ code: "DOCUMENT_IMMUTABLE" });
    const l = await getLease(t.runtime, M, leaseId);
    expect(l.versions[0]?.rent_amount).toBe(3_100_000);
  });

  it("S-004: phòng đã có lưu trú chồng ngày → 409 ROOM_UNAVAILABLE, hợp đồng vẫn pending_signature", async () => {
    const u = await unit();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${u}, 'stay',
                      tstzrange('2026-10-30T07:00:00Z', '2026-11-03T05:00:00Z', '[)'))`.execute(t.admin);
    const { leaseId, personId } = await pendingLease(u);
    const p = await fails(
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: personId }) })),
    );
    expect(p).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect((await getLease(t.runtime, M, leaseId)).status).toBe("pending_signature");
    expect(await allocationsOf(leaseId)).toEqual([]);
  });

  it("100 lệnh ký tranh cùng phòng/khoảng → đúng 1 thành công (INV-I1)", async () => {
    const u = await unit();
    const leases: { leaseId: string; rep: string }[] = [];
    for (let i = 0; i < 100; i++) {
      const rep = await person(`Tranh ${i}`);
      const { leaseId } = await seedLease(t.admin, {
        orgId: A.orgId,
        propertyId: A.propertyId,
        representativePersonId: rep,
        unitId: u,
      });
      await sql`update leases set status = 'pending_signature' where id = ${leaseId}`.execute(t.admin);
      leases.push({ leaseId, rep });
    }
    const results = await Promise.all(
      leases.map((l) =>
        run(M, async (ctx) => ({
          data: await signLease(ctx, { leaseId: l.leaseId, signerPersonId: l.rep }),
        })),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "failed")
        .every((r) => r.status === "failed" && r.problem.code === "ROOM_UNAVAILABLE"),
    ).toBe(true);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from allocations where unit_id = ${u} and active`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
  });
});

describe("S-008…S-010 người ở, PII, quyền đọc", () => {
  it("S-008: thêm người ở chỉ họ tên + SĐT; đúng một người đại diện; rời đi đặt ngày, không xoá", async () => {
    const { leaseId, personId } = await pendingLease();
    const B = await person("Người ở B");
    const child = await person("Trẻ em", null);
    await ok(
      run(M, async (ctx) => ({
        data: await addOccupant(ctx, { leaseId, personId: B, role: "occupant", fromOn: "2026-11-01" }),
      })),
    );
    await ok(
      run(M, async (ctx) => ({
        data: await addOccupant(ctx, { leaseId, personId: child, role: "occupant", fromOn: "2026-11-01" }),
      })),
    );
    const noPhone = await fails(
      run(M, async (ctx) => ({
        data: await addOccupant(ctx, {
          leaseId,
          personId: await person("Đồng thuê", null),
          role: "co_tenant",
          fromOn: "2026-11-01",
        }),
      })),
    );
    expect(noPhone.errors?.[0]?.field).toBe("person_id.phone");
    const dup = await fails(
      run(M, async (ctx) => ({
        data: await addOccupant(ctx, { leaseId, personId: B, role: "occupant", fromOn: "2026-11-01" }),
      })),
    );
    expect(dup).toMatchObject({ code: "VALIDATION_FAILED" });
    const rep = await fails(
      run(M, async (ctx) => ({ data: await removeOccupant(ctx, { leaseId, personId, toOn: "2026-12-01" }) })),
    );
    expect(rep.errors?.[0]?.field).toBe("person_id");
    await ok(
      run(M, async (ctx) => ({
        data: await removeOccupant(ctx, { leaseId, personId: B, toOn: "2026-12-01" }),
      })),
    );
    const l = await getLease(t.runtime, M, leaseId);
    expect(l.occupants.filter((o) => o.is_representative)).toHaveLength(1);
    expect(l.occupants.find((o) => o.person_id === B)?.to_on).toBe("2026-12-01");
    await expect(
      sql`delete from lease_occupants where lease_id = ${leaseId}`.execute(t.admin),
    ).rejects.toThrow();
    // CSDL: thêm người đại diện thứ hai hoặc đại diện khác người đứng hợp đồng → từ chối lúc COMMIT.
    await expect(
      t.admin
        .transaction()
        .execute((trx) =>
          sql`update lease_occupants set to_on = '2026-11-02' where lease_id = ${leaseId} and is_representative`.execute(
            trx,
          ),
        ),
    ).rejects.toMatchObject({ hint: "VALIDATION_FAILED" });
  });

  it("S-009: buồng phòng đọc hồ sơ người thuê → 404, không lộ dữ liệu, audit lần bị từ chối", async () => {
    const a = await person("Người thuê PII", "0987654321");
    await expect(getPerson(t.runtime, H, a)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const raw = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${H.membershipId}, true)`.execute(
        trx,
      );
      return (await sql<{ n: number }>`select count(*)::int as n from persons where id = ${a}`.execute(trx))
        .rows[0]?.n;
    });
    expect(raw).toBe(0);
    const denied = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'person.read' and entity_id = ${a} and outcome = 'denied'`.execute(
      t.admin,
    );
    expect(denied.rows[0]?.n).toBe(1);
    await expect(getPerson(t.runtime, F, a)).resolves.toMatchObject({
      full_name: "Người thuê PII",
      phone: "0987654321",
    });
    // Buồng phòng vẫn đọc được hồ sơ của chính mình.
    await expect(getPerson(t.runtime, H, H.personId)).resolves.toMatchObject({ id: H.personId });
  });

  it("S-010: người thuê chỉ xem hợp đồng mình đứng tên; hợp đồng khác → 404; buồng phòng → 404", async () => {
    const a = await person("Người thuê portal");
    const mine = await pendingLease(undefined, a);
    const other = await pendingLease();
    const T = await member("tenant", a);
    const view = await getLease(t.runtime, T, mine.leaseId);
    expect(view).toMatchObject({ id: mine.leaseId, representative_person_id: a });
    expect(view.versions).toHaveLength(1);
    await expect(getLease(t.runtime, T, other.leaseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getLease(t.runtime, H, mine.leaseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S-020, S-022 chuyển trạng thái và idempotency", () => {
  it("S-020: ký hợp đồng nháp → 409 INVALID_TRANSITION kèm from/to; huỷ có lý do nhả giữ chỗ", async () => {
    const u = await unit();
    const a = await person("Người thuê S-020");
    const { leaseId } = await ok(draft(M, { unitId: u, representativePersonId: a }));
    const p = await fails(
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: a }) })),
    );
    expect(p).toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
      from: "draft",
      to: "signed_awaiting_handover",
    });
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'command.denied' and reason = 'INVALID_TRANSITION'
        and actor_person_id = ${M.personId}`.execute(t.admin);
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(1);
    const direct = await sql`update leases set status = 'active' where id = ${leaseId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "INVALID_TRANSITION" });
    await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId }) })));
    const c = await ok(
      run(M, async (ctx) => ({ data: await cancelLease(ctx, { leaseId, reason: "Khách đổi ý" }) })),
    );
    expect(c.released).toHaveLength(1);
    expect((await allocationsOf(leaseId)).every((x) => !x.active)).toBe(true);
  });

  it("S-022: gửi lại lease.sign cùng key + payload → kết quả cũ, không allocation thứ hai; khác payload → IDEMPOTENCY_CONFLICT", async () => {
    const { leaseId, personId } = await pendingLease();
    const key = randomUUID();
    const payload = { lease_id: leaseId, signer_person_id: personId };
    const sign = (signer: string, body: unknown) =>
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: signer }) }), key, body);
    const first = await sign(personId, payload);
    const again = await sign(personId, payload);
    expect(again).toMatchObject({ status: "committed", replayed: true });
    expect(again.status === "committed" && first.status === "committed" && again.data).toEqual(
      first.status === "committed" ? JSON.parse(JSON.stringify(first.data)) : null,
    );
    expect((await allocationsOf(leaseId)).filter((a) => a.active)).toHaveLength(1);
    await expect(sign(randomUUID(), { ...payload, signer_person_id: "khac" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });
});

describe("S-023, S-024 giữ chỗ hợp đồng", () => {
  const T0 = new Date("2026-10-18T03:00:00Z");

  it("S-023: giữ chỗ TTL 48 giờ, nhận cọc giữ chỗ, ký trước hạn → hold thành lease không khe hở", async () => {
    const { leaseId, personId } = await pendingLease();
    const h = await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId, now: T0 }) })));
    expect(new Date(h.expiresAt).toISOString()).toBe("2026-10-20T03:00:00.000Z");
    const [hold] = await allocationsOf(leaseId);
    expect(hold).toMatchObject({ kind: "hold", active: true });
    expect(hold?.lower.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect((await getLease(t.runtime, M, leaseId)).status).toBe("pending_signature");
    expect(
      await fails(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId, now: T0 }) }))),
    ).toMatchObject({
      code: "INVALID_TRANSITION",
    });

    await ok(
      run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    const dep = await ok(
      run(F, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          leaseId,
          propertyId: A.propertyId,
          payerPersonId: personId,
          amount: 1_000_000,
          method: "cash",
        }),
      })),
    );
    await ok(run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: dep.paymentId }) })));

    const s = await ok(
      run(M, async (ctx) => ({
        data: await signLease(ctx, {
          leaseId,
          signerPersonId: personId,
          now: new Date("2026-10-19T03:00:00Z"),
        }),
      })),
    );
    expect(s.allocationId).toBe(hold?.id);
    const after = await allocationsOf(leaseId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: hold?.id, kind: "lease", active: true, expires_at: null });
    const d = await sql<{
      balance: string;
    }>`select balance from deposits where lease_id = ${leaseId}`.execute(t.admin);
    expect(d.rows[0]?.balance).toBe("1000000");
  });

  it("S-024: phòng đang giữ → người khác 409; hết hạn nhả đúng 1 lần (3 lần chạy job); ký khi hết hạn → HOLD_EXPIRED; cọc không mất", async () => {
    const u = await unit();
    const LH = await pendingLease(u);
    const LK = await pendingLease(u);
    await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId: LH.leaseId, now: T0 }) })));
    expect(
      await fails(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId: LK.leaseId, now: T0 }) }))),
    ).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(await allocationsOf(LK.leaseId)).toEqual([]);
    const dep = await ok(
      run(M, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          leaseId: LH.leaseId,
          propertyId: A.propertyId,
          payerPersonId: LH.personId,
          amount: 1_000_000,
          method: "bank_transfer",
          receivingAccountId: await (async () => {
            const id = randomUUID();
            await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
                      values (${id}, ${A.orgId}, ${A.propertyId}, 'VCB', '****9999', '1019999999', 'CHU TRO')`.execute(
              t.admin,
            );
            return id;
          })(),
          bankTxn: { ref: `FT${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-18T03:30:00Z" },
        }),
      })),
    );
    await ok(run(M, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: dep.paymentId }) })));

    const { expireHolds } = await import("../../../../apps/worker/src/jobs.ts");
    const later = new Date("2026-10-20T03:00:01Z");
    await Promise.all([
      expireHolds(t.worker, later),
      expireHolds(t.worker, later),
      expireHolds(t.worker, later),
    ]);
    const [h] = await allocationsOf(LH.leaseId);
    expect(h).toMatchObject({ active: false });
    const expired = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'allocation.hold_expired' and entity_id = ${h?.id}`.execute(
      t.admin,
    );
    expect(expired.rows[0]?.n).toBe(1);

    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await signLease(ctx, { leaseId: LH.leaseId, signerPersonId: LH.personId, now: later }),
        })),
      ),
    ).toMatchObject({ code: "HOLD_EXPIRED", status: 409 });
    const d = await sql<{
      balance: string;
    }>`select balance from deposits where lease_id = ${LH.leaseId}`.execute(t.admin);
    expect(d.rows[0]?.balance).toBe("1000000");
    // Lễ tân giữ chỗ được (ma trận "lease.hold") sau khi hold cũ đã nhả.
    await ok(run(F, async (ctx) => ({ data: await holdLease(ctx, { leaseId: LK.leaseId, now: later }) })));
  });

  it("hold hết hạn nhưng job chưa chạy: ký → HOLD_EXPIRED; giữ lại rồi ký được", async () => {
    const { leaseId, personId } = await pendingLease();
    await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId, now: T0 }) })));
    const late = new Date("2026-10-21T00:00:00Z");
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await signLease(ctx, { leaseId, signerPersonId: personId, now: late }),
        })),
      ),
    ).toMatchObject({ code: "HOLD_EXPIRED" });
    await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId, now: late }) })));
    await ok(
      run(M, async (ctx) => ({
        data: await signLease(ctx, { leaseId, signerPersonId: personId, now: late }),
      })),
    );
    const al = await allocationsOf(leaseId);
    expect(al.filter((a) => a.active).map((a) => a.kind)).toEqual(["lease"]);
  });

  it("hợp đồng không thời hạn: giữ chỗ và allocation mở cuối", async () => {
    const u = await unit();
    const a = await person("Không thời hạn");
    const { leaseId } = await ok(
      draft(M, { unitId: u, representativePersonId: a, terms: terms({ effectiveTo: null }) }),
    );
    await ok(run(M, async (ctx) => ({ data: await submitForSignature(ctx, { leaseId }) })));
    await ok(run(M, async (ctx) => ({ data: await holdLease(ctx, { leaseId, now: T0 }) })));
    await ok(
      run(M, async (ctx) => ({ data: await signLease(ctx, { leaseId, signerPersonId: a, now: T0 }) })),
    );
    const [al] = await allocationsOf(leaseId);
    expect(al).toMatchObject({ kind: "lease", upper: null });
    expect(O.role).toBe("owner");
  });
});
