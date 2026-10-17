// BASE-ERR-006 — W3C Trace Context level 1: đọc/sinh `traceparent`, gắn `trace_id`/`span_id` vào mọi log của request/job.
import { describe, expect, it } from "vitest";
import { assertLogRecords } from "../testing/log-schema.ts";
import { createLogger } from "./logger.ts";
import { emitSecurity } from "./security-events.ts";
import {
  currentTrace,
  currentTraceparent,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  runJobWithTrace,
  runWithTrace,
  traceForJob,
  traceOfRequest,
  withRequestTrace,
} from "./trace.ts";

const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PID = "00f067aa0ba902b7";
const VALID = `00-${TID}-${PID}-01`;

function capture() {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger({
      sink: { write: (l) => lines.push(l) },
      service: "hm-test",
      version: "0",
      env: "test",
    }),
  };
}

describe("trace — parseTraceparent (W3C level 1)", () => {
  it("hợp lệ: tách trace-id, parent-id, cờ", () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TID, parentId: PID, flags: "01" });
    expect(parseTraceparent(`00-${TID}-${PID}-00`)?.flags).toBe("00");
  });

  it("OWS hai đầu được cắt (RFC 9110 §5.5)", () => {
    expect(parseTraceparent(`  ${VALID}\t`)?.traceId).toBe(TID);
  });

  it("chỉ giữ bit sampled: bit dành riêng bị xoá (02 → 00, 03 → 01, ff → 01)", () => {
    expect(parseTraceparent(`00-${TID}-${PID}-02`)?.flags).toBe("00");
    expect(parseTraceparent(`00-${TID}-${PID}-03`)?.flags).toBe("01");
    expect(parseTraceparent(`00-${TID}-${PID}-ff`)?.flags).toBe("01");
  });

  it("version cao hơn (chưa biết): chấp nhận nếu bốn trường đúng dạng; phần thừa phải bắt đầu bằng '-'", () => {
    expect(parseTraceparent(`01-${TID}-${PID}-01`)?.traceId).toBe(TID);
    expect(parseTraceparent(`01-${TID}-${PID}-01-extra-field`)?.parentId).toBe(PID);
    expect(parseTraceparent(`cc-${TID}-${PID}-01-what-the-future-will-bring`)?.traceId).toBe(TID);
    expect(parseTraceparent(`01-${TID}-${PID}-01extra`)).toBeNull();
  });

  it.each([
    ["version 00 có phần thừa", `00-${TID}-${PID}-01-extra`],
    ["version ff", `ff-${TID}-${PID}-01`],
    ["trace-id toàn 0", `00-${"0".repeat(32)}-${PID}-01`],
    ["parent-id toàn 0", `00-${TID}-${"0".repeat(16)}-01`],
    ["chữ hoa", `00-${TID.toUpperCase()}-${PID}-01`],
    ["chữ hoa ở parent-id", `00-${TID}-${PID.toUpperCase()}-01`],
    ["version chữ hoa", `0A-${TID}-${PID}-01`],
    ["ký tự không phải hex", `00-${"g".repeat(32)}-${PID}-01`],
    ["trace-id thiếu 1 ký tự", `00-${TID.slice(1)}-${PID}-01`],
    ["trace-id thừa 1 ký tự", `00-${TID}0-${PID}-01`],
    ["parent-id thiếu", `00-${TID}-${PID.slice(1)}-01`],
    ["cờ 1 ký tự", `00-${TID}-${PID}-1`],
    ["cờ không phải hex", `00-${TID}-${PID}-zz`],
    ["thiếu dấu gạch", `00${TID}${PID}01`],
    ["dùng dấu gạch dưới", `00_${TID}_${PID}_01`],
    ["hai header nối bằng ', '", `${VALID}, ${VALID}`],
    ["rỗng", ""],
    ["chỉ khoảng trắng", "   "],
    ["chữ số Unicode (không phải ASCII hex)", `00-${"٣".repeat(32)}-${PID}-01`],
    ["byte NUL chèn vào", `00-${TID}-${PID}-0\u00001`],
  ])("không hợp lệ: %s", (_n, v) => {
    expect(parseTraceparent(v)).toBeNull();
  });

  it("null/undefined → null (không ném)", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });
});

describe("trace — newTraceContext/formatTraceparent", () => {
  it("không có cha ⇒ trace mới hợp lệ, không toàn 0, parent null; mỗi lần khác nhau", () => {
    const a = newTraceContext();
    const b = newTraceContext();
    expect(parseTraceparent(formatTraceparent(a))).toEqual({
      traceId: a.traceId,
      parentId: a.spanId,
      flags: "01",
    });
    expect(a.parentSpanId).toBeNull();
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  it("có cha ⇒ cùng trace-id, span MỚI, parentSpanId = parent-id, giữ cờ", () => {
    const parent = parseTraceparent(`00-${TID}-${PID}-00`);
    const c = newTraceContext(parent);
    expect(c).toMatchObject({ traceId: TID, parentSpanId: PID, flags: "00" });
    expect(c.spanId).not.toBe(PID);
    expect(formatTraceparent(c)).toBe(`00-${TID}-${c.spanId}-00`);
  });
});

describe("trace — logger gắn trace_id/span_id (ngoài ngữ cảnh thì không)", () => {
  it("ngoài request/job: không có trường trace; currentTraceparent null", () => {
    const { lines, log } = capture();
    log.info("không ngữ cảnh");
    const [rec] = assertLogRecords(lines, 1);
    expect(rec).not.toHaveProperty("trace_id");
    expect(rec).not.toHaveProperty("span_id");
    expect(currentTrace()).toBeUndefined();
    expect(currentTraceparent()).toBeNull();
  });

  it("trong ngữ cảnh: mọi log (mọi mức, child, security, lỗi) mang trace, kể cả sau await/timer", async () => {
    const { lines, log } = capture();
    const ctx = newTraceContext(parseTraceparent(VALID));
    await runWithTrace(ctx, async () => {
      log.info("a");
      await new Promise((r) => setTimeout(r, 1));
      log.child({ component: "x" }).warn("b");
      await Promise.resolve();
      emitSecurity({ log, event: "auth.login", outcome: "success" });
      log.error("c", { err: new Error("hỏng") });
    });
    log.info("sau khi ra khỏi ngữ cảnh");
    const recs = assertLogRecords(lines, 5);
    for (const r of recs.slice(0, 4)) expect(r).toMatchObject({ trace_id: TID, span_id: ctx.spanId });
    expect(recs[4]).not.toHaveProperty("trace_id");
  });

  it("mã gọi không giả được trace_id/span_id qua fields hay bindings (khoá dành riêng)", () => {
    const { lines, log } = capture();
    const ctx = newTraceContext();
    runWithTrace(ctx, () => {
      log.child({ trace_id: "f".repeat(32) }).info("x", { span_id: "e".repeat(16) });
    });
    log.child({ trace_id: "f".repeat(32), span_id: "e".repeat(16) }).info("y");
    const [a, b] = assertLogRecords(lines, 2);
    expect(a).toMatchObject({ trace_id: ctx.traceId, span_id: ctx.spanId });
    expect(b).not.toHaveProperty("trace_id");
  });

  it("hai ngữ cảnh chạy xen kẽ không lẫn nhau", async () => {
    const { lines, log } = capture();
    const a = newTraceContext();
    const b = newTraceContext();
    await Promise.all([
      runWithTrace(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        log.info("của a");
      }),
      runWithTrace(b, async () => {
        log.info("của b");
      }),
    ]);
    const recs = assertLogRecords(lines, 2);
    expect(recs.find((r) => r.msg === "của a")?.trace_id).toBe(a.traceId);
    expect(recs.find((r) => r.msg === "của b")?.trace_id).toBe(b.traceId);
  });
});

describe("trace — withRequestTrace (request HTTP)", () => {
  const req = (h: Record<string, string> = {}) => new Request("http://x.test/api/v1/a", { headers: h });

  it("nhận traceparent hợp lệ: cùng trace-id, span MỚI, parent = parent-id đến; response trả traceparent khớp", async () => {
    const { lines, log } = capture();
    const res = await withRequestTrace(req({ traceparent: VALID }), async () => {
      log.info("trong request");
      return new Response("ok");
    });
    const h = parseTraceparent(res.headers.get("traceparent"));
    expect(h?.traceId).toBe(TID);
    expect(h?.parentId).not.toBe(PID);
    expect(h?.flags).toBe("01");
    const [rec] = assertLogRecords(lines, 1);
    expect(rec).toMatchObject({ trace_id: TID, span_id: h?.parentId });
  });

  it.each([
    ["thiếu", {}],
    ["sai dạng", { traceparent: "rác" }],
    ["trace-id toàn 0", { traceparent: `00-${"0".repeat(32)}-${PID}-01` }],
    ["version ff", { traceparent: `ff-${TID}-${PID}-01` }],
  ])("traceparent %s ⇒ sinh trace mới hợp lệ (không dùng giá trị client)", async (_n, headers) => {
    const { lines, log } = capture();
    const res = await withRequestTrace(req(headers), async () => {
      log.info("x");
      return new Response("ok");
    });
    const h = parseTraceparent(res.headers.get("traceparent"));
    expect(h).not.toBeNull();
    expect(h?.traceId).not.toBe(TID);
    const [rec] = assertLogRecords(lines, 1);
    expect(rec).toMatchObject({ trace_id: h?.traceId, span_id: h?.parentId });
  });

  it("response có header bất biến (Response.redirect) vẫn nhận traceparent, giữ status/Location", async () => {
    const res = await withRequestTrace(req(), async () => Response.redirect("http://x.test/b", 302));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://x.test/b");
    expect(parseTraceparent(res.headers.get("traceparent"))).not.toBeNull();
  });

  it("gọi lồng cho cùng Request dùng lại một span (không sinh span thứ hai)", async () => {
    const r = req({ traceparent: VALID });
    let inner: string | null = null;
    const res = await withRequestTrace(r, () =>
      withRequestTrace(r, async () => {
        inner = currentTraceparent();
        return new Response("ok");
      }),
    );
    expect(res.headers.get("traceparent")).toBe(inner);
    expect(traceOfRequest(r)?.traceId).toBe(TID);
  });

  it("handler ném lỗi ⇒ ném tiếp (Next trả 500), log trong ngữ cảnh vẫn mang trace", async () => {
    const { lines, log } = capture();
    await expect(
      withRequestTrace(req({ traceparent: VALID }), async () => {
        log.error("lỗi");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(assertLogRecords(lines, 1)[0]).toMatchObject({ trace_id: TID });
  });
});

describe("trace — job worker nối tiếp trace từ outbox", () => {
  it("traceparent hợp lệ từ outbox ⇒ cùng trace-id, span mới; log trong job mang trace đó", async () => {
    const { lines, log } = capture();
    await runJobWithTrace(VALID, async () => {
      await Promise.resolve();
      log.info("job chạy");
    });
    const [rec] = assertLogRecords(lines, 1);
    expect(rec?.trace_id).toBe(TID);
    expect(rec?.span_id).not.toBe(PID);
  });

  it.each([[null], [undefined], [""], ["rác"], [`00-${"0".repeat(32)}-${PID}-01`]])(
    "thiếu/không hợp lệ (%s) ⇒ trace mới",
    (tp) => {
      const c = traceForJob(tp);
      expect(c.traceId).not.toBe(TID);
      expect(c.parentSpanId).toBeNull();
      expect(parseTraceparent(formatTraceparent(c))).not.toBeNull();
    },
  );
});
