// PLAN T-2309 (PM-METRIC-003/005/006; D-118) — schema allowlist + `track()` không cần CSDL: payload hợp lệ/sai/thừa khoá, khoá và
// giá trị PII, tên lạ, phiên bản cũ vẫn hợp lệ, đồng ý mặc định TỪ CHỐI, hành vi dev (ném) so với production (bỏ + log, không ném).
// SĐT/email trong test dùng số/miền mẫu đã khai (docs/compliance/test-data.md).
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, setAppLogger } from "../logging/index.ts";
import { EVENTS, type EventRegistry } from "./events.ts";
import {
  type AnalyticsDb,
  configureAnalytics,
  denyAllConsent,
  resetAnalytics,
  type TrackContext,
  track,
} from "./track.ts";
import {
  type AnalyticsErrorCode,
  AnalyticsValidationError,
  assertRegistrySafe,
  isPiiKey,
  looksLikePii,
  validateEvent,
} from "./validate.ts";

const ID = "3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ID2 = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const VALID: Record<string, Record<string, unknown>> = {
  "billing_period.created": { billing_period_id: ID },
  "billing_period.issued": { billing_period_id: ID, invoice_count: 12 },
  "stay.check_in_started": { source: "walk_in" },
  "stay.checked_in": { source: "reservation", stay_id: ID, reservation_id: ID2, guest_count: 2 },
  "core_task.completed": { task: "billing_period_issued" },
};

function code(fn: () => unknown): AnalyticsErrorCode | "no_error" {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnalyticsValidationError) return e.code;
    throw e;
  }
  return "no_error";
}
const val = (name: string, props: unknown, version?: number) => () =>
  validateEvent(EVENTS, name, props, version);

/** CSDL giả: chạm vào là test đỏ (chứng minh không ghi khi từ chối/không hợp lệ). */
const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched");
    },
  },
) as AnalyticsDb;
const ctx = (over: Partial<TrackContext> = {}): TrackContext => ({
  db: untouchedDb,
  organizationId: ID,
  ...over,
});

afterEach(() => {
  resetAnalytics();
  setAppLogger(undefined);
});

describe("registry allowlist", () => {
  it("có đúng các sự kiện đo chỉ số PROJECT.md §2 và qua rà an toàn", () => {
    expect(Object.keys(EVENTS).sort()).toEqual(
      [
        "billing_period.created",
        "billing_period.issued",
        "core_task.completed",
        "stay.check_in_started",
        "stay.checked_in",
      ].sort(),
    );
    expect(() => assertRegistrySafe(EVENTS)).not.toThrow();
    for (const [name, def] of Object.entries(EVENTS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(def.owner.length).toBeGreaterThan(0);
      expect(def.metric).toMatch(/^M-0\d$/);
      expect(Object.hasOwn(def.versions, def.current)).toBe(true);
      for (const v of Object.values(def.versions)) expect(v.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("không khoá thuộc tính nào của allowlist thuộc danh sách đen PII", () => {
    for (const def of Object.values(EVENTS))
      for (const v of Object.values(def.versions))
        for (const key of Object.keys(v.props)) expect(isPiiKey(key), key).toBe(false);
  });

  it("assertRegistrySafe bắt registry sai: khoá PII, tên lạ, current thiếu, enum giống PII, cận hỏng", () => {
    const base = { owner: "x", metric: "M-01", current: 1 };
    const mk = (name: string, props: Record<string, unknown>, current = 1): EventRegistry =>
      ({
        [name]: { ...base, current, versions: { 1: { addedOn: "2026-10-25", props } } },
      }) as unknown as EventRegistry;
    const uuid = { type: { kind: "uuid" }, required: true };
    expect(() => assertRegistrySafe(mk("a.b", { user_email: uuid }))).toThrow(/PII/);
    expect(() => assertRegistrySafe(mk("A.b", { x: uuid }))).toThrow(/object\.action/);
    expect(() => assertRegistrySafe(mk("nodot", { x: uuid }))).toThrow(/object\.action/);
    expect(() => assertRegistrySafe(mk("a.b", { x: uuid }, 2))).toThrow(/current version/);
    expect(() =>
      assertRegistrySafe(
        mk("a.b", { x: { type: { kind: "enum", values: ["a@example.com"] }, required: true } }),
      ),
    ).toThrow(/enum value/);
    expect(() =>
      assertRegistrySafe(mk("a.b", { x: { type: { kind: "int", min: 5, max: 1 }, required: true } })),
    ).toThrow(/range/);
    expect(() => assertRegistrySafe(mk("a.b", { CamelKey: uuid }))).toThrow(/snake_case/);
  });
});

describe("validateEvent", () => {
  it.each(Object.entries(VALID))("%s: payload hợp lệ qua, giữ phiên bản hiện tại", (name, props) => {
    const r = validateEvent(EVENTS, name, props);
    expect(r).toEqual({ name, version: 1, props });
  });

  it("thuộc tính tuỳ chọn vắng mặt/undefined được; có mặt thì phải đúng kiểu", () => {
    expect(
      validateEvent(EVENTS, "stay.check_in_started", { source: "walk_in", reservation_id: undefined }).props,
    ).toEqual({
      source: "walk_in",
    });
    expect(
      validateEvent(EVENTS, "stay.check_in_started", { source: "reservation", reservation_id: ID }).props,
    ).toEqual({ source: "reservation", reservation_id: ID });
    expect(code(val("stay.check_in_started", { source: "walk_in", reservation_id: "xyz" }))).toBe(
      "invalid_type",
    );
  });

  it("tên ngoài allowlist (kể cả khoá nguyên mẫu) → unknown_event", () => {
    for (const n of [
      "",
      "foo.bar",
      "billing_period.deleted",
      "constructor",
      "__proto__",
      "toString",
      "BILLING_PERIOD.CREATED",
    ])
      expect(code(val(n, {})), n).toBe("unknown_event");
  });

  it("phiên bản không có → unknown_version", () => {
    expect(code(val("billing_period.created", { billing_period_id: ID }, 2))).toBe("unknown_version");
    expect(code(val("billing_period.created", { billing_period_id: ID }, 0))).toBe("unknown_version");
  });

  it("props không phải object thường (null, mảng, chuỗi, số, Map) → invalid_props", () => {
    for (const p of [null, undefined, [], "x", 1, new Map()])
      expect(code(val("core_task.completed", p)), String(p)).toBe("invalid_props");
  });

  it("thiếu thuộc tính bắt buộc → missing_prop (kể cả props rỗng)", () => {
    expect(code(val("billing_period.issued", { billing_period_id: ID }))).toBe("missing_prop");
    expect(code(val("core_task.completed", {}))).toBe("missing_prop");
    expect(code(val("core_task.completed", { task: undefined }))).toBe("missing_prop");
  });

  it("thừa khoá → unknown_prop", () => {
    expect(code(val("core_task.completed", { task: "stay_checked_in", extra: 1 }))).toBe("unknown_prop");
    expect(code(val("billing_period.created", { billing_period_id: ID, property_id: ID }))).toBe(
      "unknown_prop",
    );
  });

  it("sai kiểu/cận: uuid sai, enum lạ, số thực/NaN/Infinity/âm/vượt cận/chuỗi/null/boolean", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["billing_period.created", { billing_period_id: "not-a-uuid" }],
      ["billing_period.created", { billing_period_id: 123 }],
      ["billing_period.created", { billing_period_id: null }],
      ["core_task.completed", { task: "other_task" }],
      ["core_task.completed", { task: 1 }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: 1.5 }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: Number.NaN }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: Number.POSITIVE_INFINITY }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: -1 }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: 100_001 }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: "3" }],
      ["billing_period.issued", { billing_period_id: ID, invoice_count: true }],
      ["stay.checked_in", { source: "reservation", stay_id: ID, reservation_id: ID, guest_count: 0 }],
    ];
    for (const [n, p] of bad) expect(code(val(n, p)), `${n} ${JSON.stringify(p)}`).toBe("invalid_type");
    // ca biên hợp lệ: 0 hoá đơn, cận trên
    expect(
      validateEvent(EVENTS, "billing_period.issued", { billing_period_id: ID, invoice_count: 0 }).props
        .invoice_count,
    ).toBe(0);
    expect(
      validateEvent(EVENTS, "billing_period.issued", { billing_period_id: ID, invoice_count: 100_000 }).props
        .invoice_count,
    ).toBe(100_000);
  });

  it("khoá thuộc danh sách đen PII → pii_key (ưu tiên hơn 'khoá lạ'; theo từ, hoa/thường, camelCase)", () => {
    const keys = [
      "email",
      "Email",
      "user_email",
      "phone",
      "phoneNumber",
      "mobile",
      "name",
      "full_name",
      "fullName",
      "firstname",
      "address",
      "token",
      "access_token",
      "note",
      "notes",
      "comment",
      "description",
      "ip",
      "ip_address",
      "ipAddress",
      "user_agent",
      "userAgent",
      "cccd",
      "password",
      "birthday",
    ];
    for (const k of keys)
      expect(code(val("core_task.completed", { task: "stay_checked_in", [k]: "x" })), k).toBe("pii_key");
    // cả khi khoá PII đi kèm payload thiếu: vẫn báo PII trước
    expect(code(val("core_task.completed", { email: ID }))).toBe("pii_key");
  });

  it("isPiiKey không báo nhầm khoá an toàn", () => {
    for (const k of [
      "property_id",
      "billing_period_id",
      "invoice_count",
      "guest_count",
      "stay_id",
      "source",
      "task",
      "membership_id",
      "rename_to",
      "description_id".replace("description_id", "stay_id"),
    ])
      expect(isPiiKey(k), k).toBe(false);
  });

  it("giá trị chuỗi giống email/SĐT VN → pii_value (ở bất kỳ khoá nào, kể cả uuid/enum)", () => {
    const values = [
      "an.nguyen@example.com",
      "x@example.org",
      "gọi 0912345678 nhé",
      "0912345678",
      "0912.345.678",
      "0912 345 678",
      "+84 912 345 678",
      "84-912-345-678",
      "(+84) 912 345 678",
      "02838123456",
    ];
    for (const v of values) {
      expect(looksLikePii(v), v).toBe(true);
      expect(code(val("billing_period.created", { billing_period_id: v })), v).toBe("pii_value");
      expect(code(val("core_task.completed", { task: v })), v).toBe("pii_value");
    }
  });

  it("uuid hợp lệ không bị coi là SĐT dù chứa dãy số dài; chuỗi vô hại không bị báo", () => {
    const tricky = "09123456-7890-4abc-8def-012345678901";
    expect(looksLikePii(tricky)).toBe(false);
    expect(
      validateEvent(EVENTS, "billing_period.created", { billing_period_id: tricky }).props.billing_period_id,
    ).toBe(tricky);
    for (const v of ["walk_in", "stay_checked_in", "12", "2026-10-25", ""])
      expect(looksLikePii(v), v).toBe(false);
  });

  it("lỗi không lộ giá trị payload", () => {
    try {
      validateEvent(EVENTS, "billing_period.created", { billing_period_id: "0912345678" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("0912345678");
      expect((e as AnalyticsValidationError).field).toBe("billing_period_id");
    }
  });

  it("payload phiên bản cũ vẫn validate theo hình dạng của chính nó; phiên bản mới đòi thuộc tính mới", () => {
    const uuid = { type: { kind: "uuid" }, required: true };
    const reg = {
      "stay.checked_in": {
        owner: "stay",
        metric: "M-03",
        current: 2,
        versions: {
          1: { addedOn: "2026-10-25", props: { stay_id: uuid } },
          2: {
            addedOn: "2027-01-10",
            props: { stay_id: uuid, guest_count: { type: { kind: "int", min: 1, max: 50 }, required: true } },
          },
        },
      },
    } as unknown as EventRegistry;
    expect(() => assertRegistrySafe(reg)).not.toThrow();
    expect(validateEvent(reg, "stay.checked_in", { stay_id: ID }, 1)).toEqual({
      name: "stay.checked_in",
      version: 1,
      props: { stay_id: ID },
    });
    // mặc định = current (v2): payload cũ thiếu guest_count
    expect(code(() => validateEvent(reg, "stay.checked_in", { stay_id: ID }))).toBe("missing_prop");
    expect(validateEvent(reg, "stay.checked_in", { stay_id: ID, guest_count: 2 }).version).toBe(2);
    // v1 không có guest_count ⇒ thừa khoá
    expect(code(() => validateEvent(reg, "stay.checked_in", { stay_id: ID, guest_count: 2 }, 1))).toBe(
      "unknown_prop",
    );
  });
});

describe("track() — đồng ý, dev/production, không chạm CSDL khi không ghi", () => {
  it("MẶC ĐỊNH từ chối: dropped no_consent, không lỗi, không chạm CSDL", async () => {
    expect(await track("core_task.completed", { task: "stay_checked_in" }, ctx())).toEqual({
      status: "dropped",
      reason: "no_consent",
    });
    expect(await denyAllConsent({ organizationId: ID, actorUserId: null, purpose: "analytics" })).toBe(false);
  });

  it("bộ kiểm đồng ý nhận đúng tổ chức/người/mục đích; chỉ `true` thật mới cho ghi", async () => {
    const seen: unknown[] = [];
    const consent = (q: unknown) => {
      seen.push(q);
      return "yes" as unknown as boolean; // truthy nhưng không phải true ⇒ không tính là đồng ý
    };
    const r = await track("core_task.completed", { task: "stay_checked_in" }, ctx({ actorUserId: ID2 }), {
      consent,
    });
    expect(r).toEqual({ status: "dropped", reason: "no_consent" });
    expect(seen).toEqual([{ organizationId: ID, actorUserId: ID2, purpose: "analytics" }]);
  });

  it("bộ kiểm đồng ý ném lỗi ⇒ coi như không đồng ý (fail closed), không ném ra ngoài", async () => {
    const consent = () => {
      throw new Error("consent store down");
    };
    expect(await track("core_task.completed", { task: "stay_checked_in" }, ctx(), { consent })).toEqual({
      status: "dropped",
      reason: "no_consent",
    });
  });

  it("configureAnalytics nối bộ kiểm toàn cục; resetAnalytics trả về mặc định từ chối", async () => {
    const calls: number[] = [];
    configureAnalytics({
      consent: () => {
        calls.push(1);
        return false;
      },
    });
    await track("core_task.completed", { task: "stay_checked_in" }, ctx());
    expect(calls).toHaveLength(1);
    resetAnalytics();
    await track("core_task.completed", { task: "stay_checked_in" }, ctx());
    expect(calls).toHaveLength(1);
  });

  it("kiểm hợp lệ chạy TRƯỚC đồng ý: payload sai ném ở dev dù chưa có đồng ý", async () => {
    await expect(track("core_task.completed", { task: "x" }, ctx())).rejects.toBeInstanceOf(
      AnalyticsValidationError,
    );
    await expect(
      track("core_task.completed", { task: "stay_checked_in", email: "a@example.com" }, ctx()),
    ).rejects.toMatchObject({ code: "pii_key" });
    await expect(track("nope.nope" as never, {}, ctx())).rejects.toMatchObject({ code: "unknown_event" });
  });

  it("ngữ cảnh sai (org/cơ sở/người không phải uuid, thời điểm hỏng) → invalid_context", async () => {
    const p = { task: "stay_checked_in" };
    for (const bad of [
      { organizationId: "x" },
      { propertyId: "x" },
      { actorUserId: "x" },
      { occurredAt: new Date(Number.NaN) },
    ])
      await expect(track("core_task.completed", p, ctx(bad))).rejects.toMatchObject({
        code: "invalid_context",
      });
  });

  it("production (strict=false): lỗi hợp lệ KHÔNG ném — bỏ sự kiện, trả dropped invalid, log không lộ giá trị", async () => {
    const lines: string[] = [];
    setAppLogger(createLogger({ level: "warn", sink: { write: (l) => void lines.push(l) } }));
    const r = await track("billing_period.created", { billing_period_id: "0912345678" }, ctx(), {
      strict: false,
    });
    expect(r).toEqual({ status: "dropped", reason: "invalid" });
    const r2 = await track("khong.co" as never, { email: "a@example.com" }, ctx(), { strict: false });
    expect(r2).toEqual({ status: "dropped", reason: "invalid" });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("0912345678");
    expect(lines.join("\n")).not.toContain("example.com");
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      msg: "analytics.event_invalid",
      event: "billing_period.created",
      code: "pii_value",
    });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: "(unknown)", code: "unknown_event" });
  });

  it("NODE_ENV=production tự chuyển sang không ném", async () => {
    setAppLogger(createLogger({ level: "error", sink: { write: () => {} } }));
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await track("core_task.completed", { task: "x" }, ctx())).toEqual({
        status: "dropped",
        reason: "invalid",
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
