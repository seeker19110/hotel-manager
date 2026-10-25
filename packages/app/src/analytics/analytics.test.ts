// T-2309 (PM-METRIC-002/003/005): danh mục sự kiện đóng, chống PII (tên trường đen + regex giá trị), giả danh actor ổn định.
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, setAppLogger } from "../logging/index.ts";
import { analyticsActorKey, pseudonymizeActor } from "./actor.ts";
import { COMMAND_EVENTS, trackCommand } from "./commands.ts";
import { EVENT_NAMES, EVENT_SCHEMAS } from "./events.ts";
import { BLACKLISTED_FIELD_WORDS, isBlacklistedField, looksLikePii } from "./pii.ts";
import { AnalyticsError, track, validateEvent } from "./track.ts";

const SECRET = "bi-mat-thu-nghiem-khong-dung-o-production-0123456789";

afterEach(() => setAppLogger(undefined));

describe("danh mục sự kiện (allowlist kiểu đóng)", () => {
  it("5-10 sự kiện, tên doi_tuong.hanh_dong snake_case", () => {
    expect(EVENT_NAMES.length).toBeGreaterThanOrEqual(5);
    expect(EVENT_NAMES.length).toBeLessThanOrEqual(10);
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
  });

  it("thuộc tính của mọi sự kiện chỉ là enum / số nguyên có biên / bool; tên trường không bị cấm", () => {
    for (const name of EVENT_NAMES) {
      const shape = EVENT_SCHEMAS[name].shape as Record<string, { _zod: { def: Record<string, unknown> } }>;
      for (const [field, schema] of Object.entries(shape)) {
        const def = schema._zod.def;
        expect(["enum", "number", "boolean"], `${name}.${field}`).toContain(def.type);
        expect(isBlacklistedField(field), `${name}.${field}`).toBe(false);
        if (def.type === "number") {
          const field_ = schema as unknown as { safeParse(v: unknown): { success: boolean } };
          expect(field_.safeParse(1_000_000).success, `${name}.${field} phải có biên trên`).toBe(false);
          expect(field_.safeParse(-1).success, `${name}.${field} phải có biên dưới`).toBe(false);
        }
      }
    }
  });

  it("sự kiện ngoài danh mục (kể cả tên lạ như __proto__, constructor) → ném", () => {
    for (const bad of ["unknown.event", "", "__proto__", "constructor", "toString", "Lease.Created"])
      expect(() => validateEvent(bad as never, {}), bad).toThrow(AnalyticsError);
  });

  it("thuộc tính đúng schema được chấp nhận", () => {
    expect(validateEvent("payment.recorded", { method: "cash" })).toEqual({ method: "cash" });
    expect(validateEvent("lease.created", { occupant_count: 0, has_end_date: false })).toEqual({
      occupant_count: 0,
      has_end_date: false,
    });
    expect(validateEvent("organization.registered", {})).toEqual({});
  });

  it("sai schema → ném: thiếu, thừa, sai kiểu, ngoài enum, ngoài biên, âm, không nguyên, null, chuỗi tự do", () => {
    const cases: [Parameters<typeof validateEvent>[0], unknown][] = [
      ["payment.recorded", {}],
      ["payment.recorded", { method: "crypto" }],
      ["payment.recorded", { method: "cash", extra: 1 }],
      ["payment.recorded", null],
      ["payment.recorded", []],
      ["payment.recorded", "cash"],
      ["stay.checked_in", { guest_count: 51 }],
      ["stay.checked_in", { guest_count: -1 }],
      ["stay.checked_in", { guest_count: 1.5 }],
      ["stay.checked_in", { guest_count: "3" }],
      ["stay.checked_in", { guest_count: null }],
      ["lease.created", { occupant_count: 1, has_end_date: "yes" }],
      ["organization.registered", { anything: true }],
    ];
    for (const [ev, props] of cases)
      expect(() => validateEvent(ev, props), JSON.stringify(props)).toThrow(AnalyticsError);
  });
});

describe("chống PII", () => {
  it("tên trường trong danh sách đen bị từ chối dù giá trị vô hại (snake, camel, hoa/thường)", () => {
    for (const f of [
      "email",
      "Email",
      "phone",
      "phone_number",
      "phoneNumber",
      "full_name",
      "fullName",
      "name",
      "guest_name",
      "address",
      "home_address",
      "note",
      "reason_note",
      "token",
      "access_token",
      "password",
      "ip",
      "ip_address",
      "user_agent",
      "userAgent",
      "doc_number_cccd",
    ])
      expect(isBlacklistedField(f), f).toBe(true);
    expect(() => validateEvent("payment.recorded", { method: "cash", email: 1 })).toThrow(/blacklisted/);
    expect(() => validateEvent("payment.recorded", { method: "cash", note: true })).toThrow(/blacklisted/);
  });

  it("tên trường hợp lệ không bị chặn nhầm (ship_count, membership_id, guest_count)", () => {
    for (const f of [
      "guest_count",
      "occupant_count",
      "has_end_date",
      "method",
      "ship_count",
      "membership_id",
      "tip",
    ])
      expect(isBlacklistedField(f), f).toBe(false);
    expect(BLACKLISTED_FIELD_WORDS.has("email")).toBe(true);
  });

  it("giá trị giống email hoặc SĐT Việt Nam bị từ chối (kể cả khi nằm trong chuỗi, có dấu phân cách, dạng số)", () => {
    for (const v of [
      "a@example.test",
      "nguyen.van.a+tag@example.com",
      "lien he: a@example.org",
      "0912345678",
      "091 234 5678",
      "091.234.5678",
      "091-234-5678",
      "+84912345678",
      "+84 91 234 5678",
      "84912345678",
      "(028) 3822 1234",
      "02838221234",
      912345678,
      "ghi chu 0900000001 xong",
    ])
      expect(looksLikePii(v), String(v)).toBe(true);
  });

  it("giá trị bình thường không bị coi là PII (số đếm, enum, số điện thoại sai độ dài, 0)", () => {
    for (const v of [
      0,
      1,
      19,
      50,
      "cash",
      "bank_transfer",
      true,
      false,
      null,
      undefined,
      "123456",
      "09123",
      12345678,
    ])
      expect(looksLikePii(v), String(v)).toBe(false);
  });

  it("PII trong giá trị bị chặn TRƯỚC schema và thông báo lỗi không lộ giá trị", () => {
    const secret = "chu.trọ@example.com";
    let err: unknown;
    try {
      validateEvent("payment.recorded", { method: secret });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnalyticsError);
    expect((err as Error).message).toContain("looks like PII");
    expect((err as Error).message).not.toContain("example.com");
    expect((err as Error).message).not.toContain("chu.");

    let err2: unknown;
    try {
      validateEvent("payment.recorded", { method: "cash", "a@example.test": 1 });
    } catch (e) {
      err2 = e;
    }
    expect((err2 as Error).message).not.toContain("a@example.test");
  });
});

describe("giả danh actor (HMAC-SHA256, khoá HKDF)", () => {
  const key = analyticsActorKey(SECRET);

  it("khoá 32 byte, tất định, và KHÁC khoá dẫn xuất cho mục đích khác / bí mật khác", () => {
    expect(key).toHaveLength(32);
    expect(analyticsActorKey(SECRET).equals(key)).toBe(true);
    expect(analyticsActorKey(`${SECRET}x`).equals(key)).toBe(false);
    expect(key.equals(Buffer.from(SECRET))).toBe(false);
  });

  it("cùng người + cùng khoá → cùng giá trị 32 byte", () => {
    const u = randomUUID();
    const a = pseudonymizeActor(key, u);
    expect(a).toHaveLength(32);
    expect(pseudonymizeActor(key, u).equals(a)).toBe(true);
  });

  it("khác người → khác; khác khoá → khác; không chứa userId", () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    expect(pseudonymizeActor(key, u1).equals(pseudonymizeActor(key, u2))).toBe(false);
    expect(pseudonymizeActor(key, u1).equals(pseudonymizeActor(analyticsActorKey(`${SECRET}x`), u1))).toBe(
      false,
    );
    expect(pseudonymizeActor(key, u1).toString("hex")).not.toContain(u1.replaceAll("-", ""));
  });

  it("userId rỗng là lỗi lập trình; Unicode ổn định", () => {
    expect(() => pseudonymizeActor(key, "")).toThrow();
    const u = "người-dùng-Ä-😀";
    expect(pseudonymizeActor(key, u).equals(pseudonymizeActor(key, u))).toBe(true);
  });
});

describe("track(): lỗi lập trình ném, lỗi I/O nuốt và log cảnh báo không PII", () => {
  const key = analyticsActorKey(SECRET);
  const brokenDb = {
    transaction() {
      throw Object.assign(new Error("connection refused 0912345678 a@example.test"), {
        name: "ConnectionError",
      });
    },
  } as unknown as Kysely<unknown>;

  it("sai schema/PII/orgId ném TRƯỚC khi chạm CSDL (db hỏng cũng không được gọi)", async () => {
    const sink = { db: brokenDb, actorKey: key };
    await expect(
      track(sink, { event: "payment.recorded", orgId: randomUUID(), props: { method: "x" } as never }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      track(sink, { event: "nope.event" as never, orgId: randomUUID(), props: {} as never }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      track(sink, { event: "organization.registered", orgId: "khong-phai-uuid", props: {} }),
    ).rejects.toBeInstanceOf(AnalyticsError);
  });

  it("lỗi I/O khi ghi: không ném, log warn chỉ có tên sự kiện + tên lỗi (không message gốc)", async () => {
    const lines: string[] = [];
    setAppLogger(createLogger({ level: "warn", sink: { write: (l: string) => void lines.push(l) } }));
    await expect(
      track(
        { db: brokenDb, actorKey: key },
        { event: "billing_period.issued", orgId: randomUUID(), userId: randomUUID(), props: {} },
      ),
    ).resolves.toBeUndefined();
    const out = lines.join("\n");
    expect(out).toContain("analytics.write_failed");
    expect(out).toContain("billing_period.issued");
    expect(out).toContain("ConnectionError");
    expect(out).not.toContain("0912345678");
    expect(out).not.toContain("a@example.test");
  });
});

describe("ánh xạ lệnh → sự kiện", () => {
  it("mỗi lệnh ánh xạ ra thuộc tính hợp schema với đầu vào điển hình và đầu vào rỗng/thiếu", () => {
    for (const [command, m] of Object.entries(COMMAND_EVENTS)) {
      for (const input of [
        {},
        undefined,
        { guests: [{}], method: "cash", occupants: [], terms: { effective_to: null } },
      ]) {
        expect(
          () => validateEvent(m.event, m.props(input, {})),
          `${command} ${JSON.stringify(input)}`,
        ).not.toThrow();
      }
    }
  });

  it("đếm có chặn trên (không vượt biên schema) và bool đúng", () => {
    const lease = COMMAND_EVENTS["lease.createDraft"];
    expect(
      lease?.props({ occupants: new Array(40).fill({}), terms: { effective_to: "2027-01-01" } }, {}),
    ).toEqual({
      occupant_count: 19,
      has_end_date: true,
    });
    expect(COMMAND_EVENTS["stay.checkIn"]?.props({ guests: new Array(99).fill({}) }, {})).toEqual({
      guest_count: 50,
    });
    expect(COMMAND_EVENTS["payment.record"]?.props({ method: "bank_transfer" }, {})).toEqual({
      method: "bank_transfer",
    });
  });

  it("lỗi lập trình sau khi lệnh đã commit: không ném (không thành 500), log error chỉ tên lệnh + sự kiện", async () => {
    const lines: string[] = [];
    setAppLogger(createLogger({ level: "warn", sink: { write: (l: string) => void lines.push(l) } }));
    const sink = { db: {} as Kysely<unknown>, actorKey: analyticsActorKey(SECRET) };
    await expect(
      trackCommand(sink, {
        command: "billing.issuePeriod",
        orgId: "khong-phai-uuid",
        userId: randomUUID(),
        input: {},
        data: {},
      }),
    ).resolves.toBeUndefined();
    const out = lines.join("\n");
    expect(out).toContain("analytics.invalid_event");
    expect(out).toContain("billing_period.issued");
    expect(out).not.toContain("khong-phai-uuid");
  });

  it("lệnh không có sự kiện → không làm gì (không chạm CSDL)", async () => {
    const sink = { db: {} as Kysely<unknown>, actorKey: analyticsActorKey(SECRET) };
    await expect(
      trackCommand(sink, {
        command: "member.invite",
        orgId: randomUUID(),
        userId: randomUUID(),
        input: {},
        data: {},
      }),
    ).resolves.toBeUndefined();
    await expect(
      trackCommand(sink, {
        command: "__proto__",
        orgId: randomUUID(),
        userId: randomUUID(),
        input: {},
        data: {},
      }),
    ).resolves.toBeUndefined();
  });
});
