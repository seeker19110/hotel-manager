// T-1604 (AUD-PERF-001): `buildPreview` gom truy vấn theo lô — số truy vấn không tăng theo số hợp đồng, kết quả tiền (từng
// dòng, từng đồng) không đổi so với mã cũ. Ảnh chụp `__snapshots__/preview-batch.db.test.ts.snap` được ghi bằng mã CŨ (truy
// vấn trong vòng lặp) trước khi sửa; mọi UUID được thay bằng nhãn ổn định để so được giữa các lần chạy.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { replaceMeter, setServicePrice } from "../metering/meters.ts";
import { executeCommand } from "../pipeline/command.ts";
import { createPeriod, type Preview, previewPeriod } from "./billing.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let counting: Kysely<unknown>;
let queries = 0;

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "billing.test", idempotencyKey: key, payload: { key }, correlationId: "c-preview-batch" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

interface UnitSeed {
  unitId: string;
  leaseId: string;
  moveIn: string;
  em: string;
  wm: string | null;
  v1: string;
}

/**
 * Cơ sở mới với `codes.length` phòng; mỗi phòng một hợp đồng đang thuê (mặc định từ 01/09/2026, 3.000.000 đ), công tơ điện
 * (lắp 1.250) + nước (lắp 30), điều khoản Điện + Nước + Phí khác. `labels` gom nhãn cho mọi UUID để chuẩn hoá ảnh chụp.
 */
async function seedProperty(
  codes: string[],
  opts: {
    start?: Record<string, string>;
    noWaterMeter?: string[];
    services?: Record<string, (s: Record<string, string>) => object[]>;
  } = {},
) {
  const labels = new Map<string, string>();
  const propertyId = randomUUID();
  await sql`insert into properties (id, organization_id, name, template)
            values (${propertyId}, ${A.orgId}, ${`PB ${propertyId.slice(0, 4)}`}, 'rental')`.execute(t.admin);
  const floor = randomUUID();
  const roomType = randomUUID();
  await sql`insert into floors (id, organization_id, property_id, name, sort_order) values (${floor}, ${A.orgId}, ${propertyId}, 'Tầng 1', 1)`.execute(
    t.admin,
  );
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${roomType}, ${A.orgId}, ${propertyId}, 'P', 'Phòng trọ', 2)`.execute(t.admin);
  const svc: Record<string, string> = {};
  for (const [code, name, kind, account, meterKind, price] of [
    ["DIEN", "Điện", "metered", "REV_UTIL", "electric", 3000],
    ["NUOC", "Nước", "metered", "REV_UTIL", "water", 15_000],
    ["PHI", "Phí khác", "fixed_per_unit", "REV_FEE", null, 100_000],
    ["RAC", "Rác", "per_person", "REV_SERVICE", null, 20_000],
    ["CHIA", "Làm chìa", "one_time", "REV_FEE", null, 50_000],
  ] as const) {
    const id = randomUUID();
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
              values (${id}, ${A.orgId}, ${propertyId}, ${code}, ${name}, ${kind}, ${account}, ${meterKind})`.execute(
      t.admin,
    );
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, { serviceId: id, unitPrice: price, effectiveFrom: "2026-01-01" }),
      })),
    );
    svc[code] = id;
    labels.set(id, `svc:${code}`);
  }
  const units: Record<string, UnitSeed> = {};
  for (const code of codes) {
    const unitId = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              values (${unitId}, ${A.orgId}, ${propertyId}, ${floor}, ${roomType}, ${code})`.execute(t.admin);
    const meter = async (kind: string, initial: number) => {
      const id = randomUUID();
      await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
                values (${id}, ${A.orgId}, ${propertyId}, ${unitId}, ${kind}, '2026-01-01', ${initial})`.execute(
        t.admin,
      );
      labels.set(id, `meter:${code}:${kind}`);
      return id;
    };
    const em = await meter("electric", 1250);
    const wm = opts.noWaterMeter?.includes(code) ? null : await meter("water", 30);
    const rep = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${rep}, ${A.orgId}, ${`Người thuê ${code}`})`.execute(
      t.admin,
    );
    labels.set(rep, `person:${code}`);
    const moveIn = opts.start?.[code] ?? "2026-09-01";
    const { leaseId } = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId,
      representativePersonId: rep,
      unitId,
      effectiveFrom: moveIn,
    });
    labels.set(leaseId, `lease:${code}`);
    const terms = opts.services?.[code]?.(svc) ?? [
      { service_id: svc.DIEN, quantity: 1 },
      { service_id: svc.NUOC, quantity: 1 },
      { service_id: svc.PHI, quantity: 1 },
    ];
    const v1 = (
      await sql<{ id: string }>`select id from lease_versions where lease_id = ${leaseId}`.execute(t.admin)
    ).rows[0]?.id as string;
    labels.set(v1, `version:${code}:1`);
    units[code] = { unitId, leaseId, moveIn, em, wm, v1 };
    await t.admin.transaction().execute(async (trx) => {
      await sql`update lease_versions set services = ${JSON.stringify(terms)}::jsonb where lease_id = ${leaseId}`.execute(
        trx,
      );
    });
  }
  /** Ký + bàn giao + đang thuê (sau khi test chỉnh phiên bản/điều khoản nếu cần). */
  const activate = async (code: string) => {
    const u = units[code] as UnitSeed;
    const h = randomUUID();
    await t.admin.transaction().execute(async (trx) => {
      await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}'
                where lease_id = ${u.leaseId} and signed_at is null`.execute(trx);
      await sql`update leases set status = 'pending_signature' where id = ${u.leaseId}`.execute(trx);
      await sql`update leases set status = 'signed_awaiting_handover', signed_on = ${u.moveIn}::date where id = ${u.leaseId}`.execute(
        trx,
      );
      await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                       confirmed_at, source, readings_pending, confirmation_method)
                values (${h}, ${A.orgId}, ${propertyId}, ${u.leaseId}, 'move_in', ${u.moveIn}::date, ${A.ownerMembershipId},
                        now(), 'import', false, 'import')`.execute(trx);
      await sql`update leases set status = 'active' where id = ${u.leaseId}`.execute(trx);
    });
    return h;
  };
  const period = async (month: string) => {
    const id = (await ok(run(O, async (ctx) => ({ data: await createPeriod(ctx, { propertyId, month }) }))))
      .billingPeriodId;
    labels.set(id, "period");
    return id;
  };
  /** Chỉ số kỳ (nháp) ghi thẳng như `meter.recordReading` để seed nhanh. */
  const read = async (meterId: string, periodId: string, value: number, readOn: string) => {
    const id = randomUUID();
    await sql`insert into meter_readings (id, organization_id, property_id, meter_id, billing_period_id, read_on, value, source,
                                          entered_by)
              values (${id}, ${A.orgId}, ${propertyId}, ${meterId}, ${periodId}, ${readOn}::date, ${value}, 'period',
                      ${A.ownerMembershipId})`.execute(t.admin);
    labels.set(id, `reading:${labels.get(meterId)}:period`);
    return id;
  };
  return { propertyId, svc, units, labels, activate, period, read };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Bản xem trước với UUID thay bằng nhãn; bỏ `preview_hash` (băm cả UUID ngẫu nhiên) — so riêng hash bằng `canonical`. */
function normalize(pv: Preview, labels: Map<string, string>) {
  const { preview_hash: _h, billing_period_id: _p, ...rest } = pv;
  return JSON.parse(JSON.stringify(rest).replace(UUID_RE, (id) => labels.get(id) ?? "uuid?"));
}

async function countedPreview(billingPeriodId: string) {
  queries = 0;
  const pv = await previewPeriod(counting, O, { billingPeriodId });
  return { pv, n: queries };
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ xem trước theo lô", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  counting = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: t.runtimeUrl, max: 2 }) }),
    log(e) {
      if (e.level === "query") queries++;
    },
  });
});

afterAll(async () => {
  await counting?.destroy();
  await t.drop();
});

/** Cơ sở `n` phòng điện + nước đủ chỉ số kỳ 10/2026. */
async function uniform(n: number) {
  const codes = Array.from({ length: n }, (_, i) => `R${String(i + 1).padStart(2, "0")}`);
  const P = await seedProperty(codes);
  for (const c of codes) await P.activate(c);
  const id = await P.period("2026-10");
  for (const [i, c] of codes.entries()) {
    const u = P.units[c] as UnitSeed;
    await P.read(u.em, id, 1300 + i * 7, "2026-10-31");
    await P.read(u.wm as string, id, 35 + i, "2026-10-31");
  }
  return { P, id };
}

describe("AUD-PERF-001 — số truy vấn của buildPreview không tăng theo số hợp đồng", () => {
  it("1 và 20 hợp đồng điện + nước: số truy vấn bằng nhau (± hằng nhỏ); kết quả 20 phòng khớp ảnh chụp mã cũ", async () => {
    const one = await uniform(1);
    const twenty = await uniform(20);
    const r1 = await countedPreview(one.id);
    const r20 = await countedPreview(twenty.id);
    expect(r1.pv.items).toHaveLength(1);
    expect(r20.pv.items).toHaveLength(20);
    expect(normalize(r20.pv, twenty.P.labels)).toMatchSnapshot();
    // Hằng nhỏ cho phép: không phụ thuộc N (số bước lùi chuỗi thay công tơ là hằng, không theo số hợp đồng).
    expect(r20.n, `1 hợp đồng: ${r1.n} truy vấn; 20 hợp đồng: ${r20.n}`).toBeLessThanOrEqual(r1.n + 2);
  });
});

describe("AUD-PERF-001 — kết quả tiền không đổi (ảnh chụp mã cũ) với ca biên", () => {
  it("vào giữa tháng, thay công tơ giữa kỳ (1 và 2 lần), thiếu chỉ số/thiếu công tơ, trả phòng, phụ lục, đơn giá riêng, giá đổi trong kỳ", async () => {
    const P = await seedProperty(["U01", "U02", "U03", "U04", "U05", "U06", "U07", "U08", "U09", "U10"], {
      start: { U02: "2026-10-15", U06: "2026-10-01", U10: "2026-10-01" },
      noWaterMeter: ["U08"],
      services: {
        U06: (s) => [
          { service_id: s.DIEN, quantity: 1, unit_price: 3500 },
          { service_id: s.NUOC, quantity: 1 },
          { service_id: s.PHI, quantity: 2 },
          { service_id: s.RAC, quantity: 1 },
          { service_id: s.CHIA, quantity: 1 },
        ],
        U10: (s) => [
          { service_id: s.DIEN, quantity: 1 },
          { service_id: s.NUOC, quantity: 1 },
          { service_id: s.CHIA, quantity: 1 },
        ],
      },
    });
    const u = (c: string) => P.units[c] as UnitSeed;
    // U07: phụ lục từ 16/10 — tiền phòng 3.500.000, bỏ Phí khác, thêm Rác.
    await sql`update lease_versions set effective_to = '2026-10-15' where id = ${u("U07").v1}`.execute(
      t.admin,
    );
    const v2 = randomUUID();
    P.labels.set(v2, "version:U07:2");
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, rent_amount,
                                          deposit_amount, services)
              values (${v2}, ${A.orgId}, ${P.propertyId}, ${u("U07").leaseId}, 2, 'appendix', '2026-10-16', 3500000, 3000000,
                      ${JSON.stringify([
                        { service_id: P.svc.DIEN, quantity: 1 },
                        { service_id: P.svc.NUOC, quantity: 1 },
                        { service_id: P.svc.RAC, quantity: 1 },
                      ])}::jsonb)`.execute(t.admin);
    const handover: Record<string, string> = {};
    for (const c of Object.keys(P.units)) handover[c] = await P.activate(c);
    // U06: 2 người ở ⇒ Rác 2 × 20.000.
    const p2 = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${p2}, ${A.orgId}, 'Người ở cùng U06')`.execute(
      t.admin,
    );
    await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on)
              values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, ${u("U06").leaseId}, ${p2}, 'occupant', false, '2026-10-01')`.execute(
      t.admin,
    );
    // U10: Làm chìa đã có khoản phải thu ở chỗ khác (không thuộc kỳ) ⇒ không tính lại.
    await sql`insert into charges (id, organization_id, property_id, source_type, lease_id, service_id, kind, revenue_account,
                                   description, business_date, unit_price, amount)
              values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, 'lease', ${u("U10").leaseId}, ${P.svc.CHIA}, 'fee', 'REV_FEE',
                      'Làm chìa', '2026-10-01', 50000, 50000)`.execute(t.admin);
    // U01: chỉ số đã duyệt cuối kỳ trước 1.300 / 33 ⇒ lượng tính từ đó (không từ chỉ số lắp).
    for (const [m, v] of [
      [u("U01").em, 1300],
      [u("U01").wm as string, 33],
    ] as const) {
      await sql`insert into meter_readings (id, organization_id, property_id, meter_id, read_on, value, status, source)
                values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, ${m}, '2026-09-30', ${v}, 'approved', 'import')`.execute(
        t.admin,
      );
    }
    // U02: vào 15/10, chỉ số bàn giao nhận phòng 1.280 / 31.
    for (const [m, v] of [
      [u("U02").em, 1280],
      [u("U02").wm as string, 31],
    ] as const) {
      const rid = randomUUID();
      P.labels.set(rid, `reading:${P.labels.get(m)}:move_in`);
      await sql`insert into meter_readings (id, organization_id, property_id, meter_id, handover_id, read_on, value, status, source,
                                            approved_by)
                values (${rid}, ${A.orgId}, ${P.propertyId}, ${m}, ${handover.U02}, '2026-10-15', ${v}, 'approved', 'handover',
                        ${A.ownerMembershipId})`.execute(t.admin);
    }
    // Nước đổi giá 16.000 từ 25/10: hợp đồng trả phòng 20/10 (U05) vẫn giá 15.000 (giá tại ngày cuối của hợp đồng).
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, {
          serviceId: P.svc.NUOC as string,
          unitPrice: 16_000,
          effectiveFrom: "2026-10-25",
        }),
      })),
    );
    const id = await P.period("2026-10");
    // U03: thay công tơ điện 12/10 (cuối 1.300, mới 0) ⇒ 50 + 50 = 100 kWh; nước thay hai lần (05/10: 35 → 0; 20/10: 4 → 0)
    // ⇒ 5 + 4 + 3 = 12 m³ (đi qua 2 bước chuỗi thay).
    const rep = async (meterId: string, occurredOn: string, oldFinalValue: number) => {
      const r = await ok(
        run(O, async (ctx) => ({
          data: await replaceMeter(ctx, { meterId, occurredOn, oldFinalValue, newInitialValue: 0 }),
        })),
      );
      P.labels.set(r.newMeterId, `${P.labels.get(meterId)}:new@${occurredOn}`);
      return r.newMeterId;
    };
    const em3 = await rep(u("U03").em, "2026-10-12", 1300);
    const wm3a = await rep(u("U03").wm as string, "2026-10-05", 35);
    const wm3b = await rep(wm3a, "2026-10-20", 4);
    // U05: trả phòng 20/10 có chỉ số bàn giao trả 1.320 / 40; U09: trả 25/10, biên bản trả không có chỉ số ⇒ dùng chỉ số kỳ.
    for (const [c, out, vals] of [
      ["U05", "2026-10-20", [1320, 40]],
      ["U09", "2026-10-25", null],
    ] as const) {
      await t.admin.transaction().execute(async (trx) => {
        await sql`update leases set status = 'notice_given', planned_move_out_on = ${out}::date where id = ${u(c).leaseId}`.execute(
          trx,
        );
        const h = randomUUID();
        await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                         confirmed_at, confirmation_method)
                  values (${h}, ${A.orgId}, ${P.propertyId}, ${u(c).leaseId}, 'move_out', ${out}::date, ${A.ownerMembershipId}, now(),
                          'in_person')`.execute(trx);
        if (vals) {
          for (const [m, v] of [
            [u(c).em, vals[0]],
            [u(c).wm as string, vals[1]],
          ] as const) {
            const rid = randomUUID();
            P.labels.set(rid, `reading:${P.labels.get(m)}:move_out`);
            await sql`insert into meter_readings (id, organization_id, property_id, meter_id, handover_id, read_on, value, status,
                                                  source, approved_by)
                      values (${rid}, ${A.orgId}, ${P.propertyId}, ${m}, ${h}, ${out}::date, ${v}, 'approved', 'handover',
                              ${A.ownerMembershipId})`.execute(trx);
          }
        }
        await sql`update leases set status = 'settling', moved_out_on = ${out}::date where id = ${u(c).leaseId}`.execute(
          trx,
        );
      });
    }
    // Chỉ số kỳ (31/10). U04 thiếu chỉ số nước; U08 không có công tơ nước.
    const E: Record<string, number> = {
      U01: 1350,
      U02: 1330,
      U04: 1400,
      U05: 1350,
      U06: 1290,
      U07: 1450,
      U08: 1310,
      U09: 1360,
      U10: 1270,
    };
    const W: Record<string, number> = {
      U01: 40,
      U02: 36,
      U05: 42,
      U06: 37,
      U07: 50,
      U09: 39,
      U10: 32,
    };
    for (const [c, v] of Object.entries(E)) await P.read(u(c).em, id, v, "2026-10-31");
    for (const [c, v] of Object.entries(W)) await P.read(u(c).wm as string, id, v, "2026-10-31");
    await P.read(em3, id, 50, "2026-10-31");
    await P.read(wm3b, id, 3, "2026-10-31");

    const { pv, n } = await countedPreview(id);
    const byUnit = (c: string) => pv.items.find((i) => i.unit === c);
    const lines = (c: string) => byUnit(c)?.lines.map((l) => [l.description, l.quantity, l.amount]);
    // Giá trị tính tay cho các ca biên chính (chứng minh độc lập với ảnh chụp).
    expect(lines("U01")?.slice(1, 3)).toEqual([
      ["Điện", "50", 150_000],
      ["Nước", "7", 112_000],
    ]);
    expect(
      byUnit("U03")
        ?.lines.filter((l) => l.kind === "utility")
        .map((l) => l.quantity),
    ).toEqual(["100", "12"]);
    expect(byUnit("U04")?.missing).toEqual(["water"]);
    expect(byUnit("U08")?.missing).toEqual(["water"]);
    expect(lines("U05")?.slice(1, 3)).toEqual([
      ["Điện", "70", 210_000],
      ["Nước", "10", 150_000],
    ]);
    expect(lines("U06")?.map((l) => l[0])).toContain("Làm chìa");
    expect(lines("U10")?.map((l) => l[0])).not.toContain("Làm chìa");
    expect(normalize(pv, P.labels)).toMatchSnapshot();

    // Cùng số liệu ⇒ cùng hash; hai lần xem trước đồng thời cho cùng kết quả.
    const [a, b] = await Promise.all([
      previewPeriod(t.runtime, O, { billingPeriodId: id }),
      previewPeriod(t.runtime, O, { billingPeriodId: id }),
    ]);
    expect(a.preview_hash).toBe(pv.preview_hash);
    expect(b).toEqual(a);
    expect(n).toBeGreaterThan(0);
  });
});
