// SEC-LOG-001/002 — sự kiện bảo mật chuẩn hoá: hình dạng cố định, IP đã cắt, không PII/bí mật (thuần, không DB).
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import {
  anonymizeIp,
  auditSource,
  emitSecurity,
  forwardedClientIp,
  requestClient,
  SECURITY_EVENTS,
  sanitizeUserAgent,
  securityEventForProblem,
  securityRecordSchema,
} from "./security-events.ts";

function capture() {
  const lines: string[] = [];
  const log = createLogger({
    sink: { write: (l) => lines.push(l) },
    now: () => new Date("2026-10-16T01:02:03Z"),
    service: "hm-test",
    version: "0.0.0",
    env: "test",
  });
  return { lines, log, rec: (i = 0) => JSON.parse(lines[i] ?? "{}") };
}

describe("logging — anonymizeIp (IP ghi log đã cắt, không băm trần)", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0"],
    ["10.1.2.3", "10.1.2.0"],
    ["::ffff:198.51.100.9", "198.51.100.0"],
    ["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd::"],
    ["2001:0db8:00ab::1", "2001:db8:ab::"],
    ["::1", "0:0:0::"],
    ["fe80::1%eth0", "fe80:0:0::"],
  ])("%s → %s", (ip, out) => {
    expect(anonymizeIp(ip)).toBe(out);
  });

  it.each([[null], [undefined], [""], ["unknown"], ["999.1.1.1"], ["abc:def"], ["1.2.3"]])(
    "không phải IP hợp lệ (%s) → null",
    (ip) => {
      expect(anonymizeIp(ip)).toBeNull();
    },
  );
});

describe("logging — requestClient", () => {
  it("hop PHẢI NHẤT X-Forwarded-For (do proxy tin cậy thêm) + User-Agent; UA cắt 200 ký tự và bỏ ký tự điều khiển", () => {
    const c = requestClient(
      new Headers({
        "x-forwarded-for": " 10.0.0.1 , 203.0.113.7 ",
        "user-agent": `Mozilla\t[ERROR] ${"a".repeat(300)}`,
      }),
    );
    expect(c.ip).toBe("203.0.113.7");
    expect(c.userAgent).toHaveLength(200);
    expect(c.userAgent).not.toMatch(/[\t\r\n]/); // Headers đã chặn CR/LF; tab là ký tự điều khiển duy nhất lọt qua
  });

  it("XFF `1.2.3.4, 10.0.0.9` ⇒ dùng `10.0.0.9` (hop đầu là do client tự khai, giả được)", () => {
    expect(requestClient(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" })).ip).toBe("10.0.0.9");
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }))).toBe("10.0.0.9");
  });

  it("một hop → hop đó; rỗng/chỉ dấu phẩy/khoảng trắng → null; bỏ phần tử rỗng ở cuối", () => {
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "198.51.100.4," }))).toBe("198.51.100.4");
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": " , " }))).toBeNull();
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "" }))).toBeNull();
    expect(forwardedClientIp(new Headers())).toBeNull();
  });

  it("thiếu header → null (không bịa)", () => {
    expect(requestClient(new Headers())).toEqual({ ip: null, userAgent: null });
  });
});

describe("logging — sanitizeUserAgent / auditSource (cột 'từ đâu' của audit, T-405)", () => {
  it("NFC, bỏ ký tự điều khiển, cắt ≤ 200 điểm mã không cắt đôi cặp thay thế, rỗng → null", () => {
    expect(sanitizeUserAgent("Tr\u0069\u0300nh")).toBe("Tr\u00ecnh");
    expect(sanitizeUserAgent("a\u0000b\tc")).toBe("a b c");
    const cut = sanitizeUserAgent("😀".repeat(250)) as string;
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).toBe("😀".repeat(200));
    expect(sanitizeUserAgent("   ")).toBeNull();
    expect(sanitizeUserAgent("")).toBeNull();
    expect(sanitizeUserAgent(null)).toBeNull();
    expect(sanitizeUserAgent(undefined)).toBeNull();
  });

  it("auditSource: IP cắt + UA sạch; không client hoặc IP rác → null từng cột", () => {
    expect(auditSource({ ip: "198.51.100.77", userAgent: " UA " })).toEqual({
      sourceIp: "198.51.100.0",
      userAgent: "UA",
    });
    expect(auditSource({ ip: "2001:db8:1:2:3:4:5:6", userAgent: null })).toEqual({
      sourceIp: "2001:db8:1::",
      userAgent: null,
    });
    expect(auditSource(null)).toEqual({ sourceIp: null, userAgent: null });
    expect(auditSource({ ip: "rác", userAgent: null }).sourceIp).toBeNull();
  });
});

describe("logging — securityEventForProblem", () => {
  it.each([
    [{ status: 401, code: "UNAUTHENTICATED" }, "auth.unauthenticated"],
    [{ status: 401, code: "REAUTH_REQUIRED" }, "auth.reauth_required"],
    [{ status: 403, code: "FORBIDDEN" }, "authz.denied"],
    [{ status: 403, code: "MFA_REQUIRED" }, "authz.denied"],
    [{ status: 429, code: "RATE_LIMITED" }, "rate_limit.exceeded"],
    [{ status: 404, code: "NOT_FOUND" }, null],
    [{ status: 422, code: "VALIDATION_FAILED" }, "input.validation_failed"],
    [{ status: 413, code: "FILE_TOO_LARGE" }, "file.upload_rejected"],
    [{ status: 415, code: "FILE_TYPE_NOT_ALLOWED" }, "file.upload_rejected"],
    [{ status: 422, code: "OTHER" }, null],
    [{ status: 409, code: "IDEMPOTENCY_CONFLICT" }, null],
  ])("%j → %s", (p, name) => {
    expect(securityEventForProblem(p)).toBe(name);
  });
});

describe("logging — emitSecurity theo schema (SEC-LOG-002)", () => {
  it("mọi sự kiện trong danh mục ra đúng một bản ghi hợp lệ với đủ 6 trường chuẩn", () => {
    for (const event of SECURITY_EVENTS) {
      const { lines, rec, log } = capture();
      emitSecurity({
        log,
        event,
        outcome: "denied",
        actor: { authUserId: "u-1", orgId: "o-1", membershipId: "m-1", role: "manager" },
        target: { type: "command", id: "x.y" },
        reason: "FORBIDDEN",
        client: { ip: "203.0.113.77", userAgent: "UA" },
        correlationId: "corr-12345678",
      });
      expect(lines).toHaveLength(1);
      expect(securityRecordSchema.parse(rec())).toMatchObject({
        event,
        msg: event,
        category: "security",
        actor: { user_id: "u-1", org_id: "o-1", membership_id: "m-1", role: "manager" },
        target: { type: "command", id: "x.y" },
        outcome: "denied",
        source_ip: "203.0.113.0",
        user_agent: "UA",
        correlation_id: "corr-12345678",
      });
    }
  });

  it("thiếu thông tin → khoá vẫn có, giá trị null (hình dạng ổn định); IP thô không xuất hiện ở đâu trong dòng log", () => {
    const { lines, rec, log } = capture();
    emitSecurity({
      log,
      event: "auth.unauthenticated",
      outcome: "denied",
      client: { ip: "203.0.113.77", userAgent: null },
    });
    const r = securityRecordSchema.parse(rec());
    expect(r).toMatchObject({
      actor: null,
      target: null,
      user_agent: null,
      reason: null,
      correlation_id: null,
    });
    expect(lines[0]).not.toContain("203.0.113.77");
    expect(r.source_ip).toBe("203.0.113.0");
  });

  it("IP không hợp lệ ('unknown') → source_ip null", () => {
    const { rec, log } = capture();
    emitSecurity({
      log,
      event: "guest_link.denied",
      outcome: "denied",
      client: { ip: "unknown", userAgent: null },
    });
    expect(rec().source_ip).toBeNull();
  });

  it("không để lọt PII/bí mật trong lý do hay UA (che theo logger)", () => {
    const { lines, log } = capture();
    emitSecurity({
      log,
      event: "authz.denied",
      outcome: "denied",
      reason: "email an.nguyen@example.com Bearer abcdef0123456789",
      client: { ip: null, userAgent: "tool 0100005678" },
    });
    expect(lines[0]).not.toContain("an.nguyen");
    expect(lines[0]).not.toContain("abcdef0123456789");
    expect(lines[0]).not.toContain("0100005678");
  });

  it("sink ném lỗi thì emitSecurity không ném (log không làm hỏng nghiệp vụ)", () => {
    const log = createLogger({
      sink: {
        write: () => {
          throw new Error("đĩa đầy");
        },
      },
    });
    expect(() => emitSecurity({ log, event: "authz.denied", outcome: "denied" })).not.toThrow();
  });
});
