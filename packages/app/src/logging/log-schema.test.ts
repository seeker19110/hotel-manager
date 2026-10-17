// BASE-ERR-006 — JSON Schema chung cho MỌI bản ghi log + đối chiếu mọi log phát ra qua các đường chính của ứng dụng.
import { describe, expect, it } from "vitest";
import { type HttpDeps, handleQuery } from "../http/command-route.ts";
import { withHttpMetrics } from "../observability/http-metrics.ts";
import { testServices } from "../server/services.ts";
import { assertLogRecords, LOG_RECORD_SCHEMA, logRecordErrors } from "../testing/log-schema.ts";
import { createLogger } from "./logger.ts";
import { setAppLogger } from "./runtime.ts";
import { emitSecurity, SECURITY_EVENTS } from "./security-events.ts";
import { newTraceContext, runWithTrace } from "./trace.ts";
import { reportRequestError, reportUnexpectedError } from "./unexpected.ts";

const NOW = () => new Date("2026-10-17T01:02:03.456Z");
function capture() {
  const lines: string[] = [];
  const log = createLogger({
    sink: { write: (l) => lines.push(l) },
    now: NOW,
    level: "debug",
    service: "hm-test",
    version: "1.0.0",
    env: "test",
  });
  return { lines, log };
}

const GOOD = {
  ts: "2026-10-17T01:02:03.456Z",
  level: "info",
  severity_number: 9,
  service: "s",
  version: "1",
  env: "test",
  msg: "m",
};
const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SEC = {
  ...GOOD,
  level: "warn",
  severity_number: 13,
  category: "security",
  msg: "auth.login",
  event: "auth.login",
  actor: null,
  target: null,
  outcome: "success",
  source_ip: null,
  user_agent: null,
  reason: null,
  correlation_id: null,
};

describe("log-record.schema.json — mẫu đúng/sai (hàng rào của chính schema)", () => {
  it("mẫu tối thiểu, có trace, sự kiện bảo mật đầy đủ đều hợp lệ", () => {
    expect(logRecordErrors(GOOD)).toEqual([]);
    expect(logRecordErrors({ ...GOOD, trace_id: TID, span_id: "00f067aa0ba902b7" })).toEqual([]);
    expect(logRecordErrors(SEC)).toEqual([]);
    expect(
      logRecordErrors({
        ...SEC,
        source_ip: "203.0.113.0",
        actor: { user_id: "u", org_id: null, membership_id: null, role: null },
      }),
    ).toEqual([]);
    expect(logRecordErrors({ ...GOOD, "exception.type": "Error", "exception.message": "x" })).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["thiếu service", { ...GOOD, service: undefined }],
    ["thiếu msg", { ...GOOD, msg: undefined }],
    ["msg rỗng", { ...GOOD, msg: "" }],
    ["ts không có Z (naive)", { ...GOOD, ts: "2026-10-17T01:02:03.456" }],
    ["ts có offset +07:00 (log phải UTC Z)", { ...GOOD, ts: "2026-10-17T08:02:03.456+07:00" }],
    ["ts không có mili giây", { ...GOOD, ts: "2026-10-17T01:02:03Z" }],
    ["ts là số epoch", { ...GOOD, ts: 1760662923456 }],
    ["level lạ", { ...GOOD, level: "fatal" }],
    ["severity_number không khớp level", { ...GOOD, level: "error" }],
    ["severity_number lạ", { ...GOOD, severity_number: 10 }],
    ["trace_id không có span_id", { ...GOOD, trace_id: TID }],
    ["span_id không có trace_id", { ...GOOD, span_id: "00f067aa0ba902b7" }],
    ["trace_id toàn 0", { ...GOOD, trace_id: "0".repeat(32), span_id: "00f067aa0ba902b7" }],
    ["trace_id chữ hoa", { ...GOOD, trace_id: TID.toUpperCase(), span_id: "00f067aa0ba902b7" }],
    ["span_id sai độ dài", { ...GOOD, trace_id: TID, span_id: "abc" }],
    ["sự kiện bảo mật thiếu actor", { ...SEC, actor: undefined }],
    ["sự kiện bảo mật level info", { ...SEC, level: "info", severity_number: 9 }],
    ["sự kiện bảo mật msg ≠ event", { ...SEC, msg: "auth.logout" }],
    ["sự kiện bảo mật outcome lạ", { ...SEC, outcome: "ok" }],
    ["sự kiện bảo mật chứa IP đầy đủ", { ...SEC, source_ip: "203.0.113.77" }],
    [
      "sự kiện bảo mật actor thừa trường (email)",
      { ...SEC, actor: { user_id: "u", org_id: null, membership_id: null, role: null, email: "a@b.c" } },
    ],
    ["sự kiện bảo mật user_agent > 200", { ...SEC, user_agent: "a".repeat(201) }],
    ["exception.message không có exception.type", { ...GOOD, "exception.message": "x" }],
  ])("sai: %s", (_n, rec) => {
    const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined));
    expect(logRecordErrors(clean).length).toBeGreaterThan(0);
  });

  it("schema đã nạp là tài liệu JSON hợp lệ có $id", () => {
    expect((LOG_RECORD_SCHEMA as { $id?: string }).$id).toMatch(/log-record\.schema\.json$/);
  });
});

describe("mọi log phát ra qua các đường chính đều hợp lệ với schema", () => {
  it("mọi mức, child, fields lồng/mảng/Unicode, lỗi có cause, bí mật bị che", () => {
    const { lines, log } = capture();
    log.debug("gỡ lỗi", { n: 1 });
    log.info("tiếng Việt có dấu 🏨", { phong: "203", ghi_chu: ["a", { b: null }] });
    log
      .child({ correlation_id: "corr-12345678", component: "x" })
      .warn("cảnh báo", { password: "p", email: "an@example.com" });
    log.error("lỗi", { err: new Error("hỏng", { cause: new TypeError("gốc") }) });
    log.error("lỗi không phải Error", { err: "chuỗi" });
    log.info('dòng\nmới\r\nvà "ngoặc"');
    const recs = assertLogRecords(lines, 6);
    expect(recs[3]?.["exception.type"]).toBe("Error");
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("mọi sự kiện bảo mật trong danh mục (kể cả khi thiếu thông tin) — kèm trace", () => {
    const { lines, log } = capture();
    runWithTrace(newTraceContext(), () => {
      for (const event of SECURITY_EVENTS) {
        emitSecurity({ log, event, outcome: "denied" });
        emitSecurity({
          log,
          event,
          outcome: "success",
          actor: { authUserId: "u", orgId: "o", membershipId: "m", role: "owner" },
          target: { type: "x", id: "1" },
          reason: "R",
          client: { ip: "2001:db8:abcd:12::1", userAgent: "UA" },
          correlationId: "corr-12345678",
        });
      }
    });
    const recs = assertLogRecords(lines, SECURITY_EVENTS.length * 2);
    expect(recs.every((r) => typeof r.trace_id === "string")).toBe(true);
  });

  it("reportUnexpectedError / reportRequestError (có traceparent client → incoming_trace_id)", () => {
    const { lines, log } = capture();
    reportUnexpectedError(log, new Error("x"), "corr-12345678");
    reportUnexpectedError(log, { not: "an error" }, "corr-12345678");
    reportRequestError(
      log,
      new Error("render"),
      {
        path: "/a",
        method: "GET",
        headers: { traceparent: `00-${TID}-00f067aa0ba902b7-01`, "x-correlation-id": "corr-12345678" },
      },
      { routePath: "/hop-dong/[id]", routeType: "render" },
    );
    const recs = assertLogRecords(lines, 3);
    expect(recs[2]?.incoming_trace_id).toBe(TID);
    expect(recs[2]).not.toHaveProperty("trace_id");
  });

  it("request qua withHttpMetrics: log trong handler có trace khớp header phản hồi", async () => {
    const { lines, log } = capture();
    const handler = withHttpMetrics("/api/test-trace", async () => {
      log.info("trong handler");
      return new Response("ok");
    });
    const res = await handler(
      new Request("http://x.test/api/test-trace", {
        headers: { traceparent: `00-${TID}-00f067aa0ba902b7-01` },
      }),
    );
    const [rec] = assertLogRecords(lines, 1);
    expect(res.headers.get("traceparent")).toBe(`00-${TID}-${rec?.span_id}-01`);
    expect(rec?.trace_id).toBe(TID);
  });

  it("handleQuery không phiên: 401 + sự kiện auth.unauthenticated mang trace_id trùng header phản hồi", async () => {
    const { lines, log } = capture();
    setAppLogger(log);
    try {
      const deps: HttpDeps = {
        db: {} as HttpDeps["db"],
        getSession: async () => null,
        secureCookies: false,
        services: testServices(),
      };
      const def = { query: "t.q", input: (await import("zod")).z.strictObject({}), run: async () => ({}) };
      const res = await handleQuery(def, new Request("http://x.test/api/v1/t/q"), deps);
      expect(res.status).toBe(401);
      const [rec] = assertLogRecords(lines, 1);
      expect(rec).toMatchObject({
        event: "auth.unauthenticated",
        correlation_id: res.headers.get("x-correlation-id"),
      });
      expect(res.headers.get("traceparent")).toBe(`00-${rec?.trace_id}-${rec?.span_id}-01`);
    } finally {
      setAppLogger(undefined);
    }
  });
});
