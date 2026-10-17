// Ngữ cảnh trace theo W3C Trace Context level 1 (BASE-ERR-006, OPS-OBS): `trace_id` (16 byte) + `span_id` (8 byte) gắn vào MỌI
// bản ghi log của một request HTTP hoặc một job worker — logger đọc ngữ cảnh hiện tại từ AsyncLocalStorage nên mã nghiệp vụ
// không phải truyền thêm tham số. Nguồn: https://www.w3.org/TR/trace-context-1/ (header `traceparent`, mục 3.2).
//
//   traceparent: 00-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>
//
// Quy tắc nhận (không tin đầu vào): chỉ chữ hex THƯỜNG; version `ff` không hợp lệ; trace-id/parent-id không được toàn số 0;
// version 00 dài đúng 55 ký tự; version cao hơn (chưa biết) vẫn phải bắt đầu bằng bốn trường đúng dạng version 00 và nếu dài hơn
// thì ký tự thứ 56 phải là `-`. Sai bất kỳ điều gì ⇒ BỎ header, sinh trace mới (không chắp vá). Header lặp (Headers.get nối
// bằng ", ") ⇒ sai độ dài ⇒ coi như không hợp lệ. `tracestate` không dùng, không chuyển tiếp. Cờ: chỉ giữ bit `sampled` (0x01),
// các bit dành riêng đặt 0 (level 1 §3.2.2.6).
//
// Mỗi request/job có `span_id` MỚI của chính nó; `parent_span_id` (nếu có) là parent-id của header đến.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface TraceContext {
  /** 32 hex thường, không toàn 0. */
  traceId: string;
  /** 16 hex thường, không toàn 0 — span của request/job hiện tại. */
  spanId: string;
  /** Span cha từ header/outbox (nếu có). */
  parentSpanId: string | null;
  /** 2 hex: chỉ bit sampled (`00`/`01`). */
  flags: string;
}

/** Kết quả đọc một `traceparent` hợp lệ. */
export interface ParsedTraceparent {
  traceId: string;
  parentId: string;
  flags: string;
}

const HEX_LOWER = /^[0-9a-f]+$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** Tên header (hằng để không gõ sai ở nhiều nơi). */
export const TRACEPARENT_HEADER = "traceparent";

/** Đọc `traceparent` theo W3C level 1; không hợp lệ/thiếu ⇒ `null`. */
export function parseTraceparent(value: string | null | undefined): ParsedTraceparent | null {
  if (typeof value !== "string") return null;
  // OWS hai đầu giá trị header do HTTP quy định (RFC 9110 §5.5) — Headers đã cắt, nhưng gọi trực tiếp thì phải chịu được.
  const v = value.trim();
  if (v.length < 55) return null;
  if (v[2] !== "-" || v[35] !== "-" || v[52] !== "-") return null;
  const version = v.slice(0, 2);
  const traceId = v.slice(3, 35);
  const parentId = v.slice(36, 52);
  const flags = v.slice(53, 55);
  if (!HEX_LOWER.test(version) || version === "ff") return null;
  if (version === "00" ? v.length !== 55 : v.length > 55 && v[55] !== "-") return null;
  if (!HEX_LOWER.test(traceId) || traceId === ZERO_TRACE) return null;
  if (!HEX_LOWER.test(parentId) || parentId === ZERO_SPAN) return null;
  if (!HEX_LOWER.test(flags)) return null;
  return { traceId, parentId, flags: (Number.parseInt(flags, 16) & 1) === 1 ? "01" : "00" };
}

function randomHex(bytes: number, zero: string): string {
  for (;;) {
    const h = randomBytes(bytes).toString("hex");
    if (h !== zero) return h;
  }
}

/** Span mới trong trace của `parent` (header/outbox đã parse); không có `parent` ⇒ trace mới (đã lấy mẫu). */
export function newTraceContext(parent?: ParsedTraceparent | null): TraceContext {
  return {
    traceId: parent?.traceId ?? randomHex(16, ZERO_TRACE),
    spanId: randomHex(8, ZERO_SPAN),
    parentSpanId: parent?.parentId ?? null,
    flags: parent?.flags ?? "01",
  };
}

/** `00-<trace-id>-<span-id>-<flags>` — giá trị đặt vào header phản hồi và cột `outbox.traceparent`. */
export function formatTraceparent(c: TraceContext): string {
  return `00-${c.traceId}-${c.spanId}-${c.flags}`;
}

const store = new AsyncLocalStorage<TraceContext>();

/** Ngữ cảnh trace của luồng async hiện tại (`undefined` ngoài request/job). */
export function currentTrace(): TraceContext | undefined {
  return store.getStore();
}

/** `traceparent` của span hiện tại, để lưu cùng sự kiện outbox (job worker nối tiếp trace); ngoài ngữ cảnh ⇒ `null`. */
export function currentTraceparent(): string | null {
  const c = store.getStore();
  return c ? formatTraceparent(c) : null;
}

/** Chạy `fn` trong ngữ cảnh trace `ctx` — mọi log phát ra bên trong (kể cả sau `await`) mang `trace_id`/`span_id`. */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** Trường trace của bản ghi log (rỗng ngoài ngữ cảnh). */
export function traceLogFields(): { trace_id?: string; span_id?: string } {
  const c = store.getStore();
  return c ? { trace_id: c.traceId, span_id: c.spanId } : {};
}

/** Job worker: nối tiếp trace từ `traceparent` của outbox/payload nếu hợp lệ, không thì trace mới. */
export function traceForJob(traceparent: string | null | undefined): TraceContext {
  return newTraceContext(parseTraceparent(traceparent));
}

/** Chạy một job (định kỳ hoặc từ outbox) trong span riêng. */
export function runJobWithTrace<T>(traceparent: string | null | undefined, fn: () => T): T {
  return runWithTrace(traceForJob(traceparent), fn);
}

const byRequest = new WeakMap<Request, TraceContext>();

/** Ngữ cảnh trace của request (đã được `withRequestTrace` gắn); chưa có ⇒ `undefined`. */
export function traceOfRequest(req: Request): TraceContext | undefined {
  return byRequest.get(req);
}

function withTraceparentHeader(res: Response, value: string): Response {
  try {
    res.headers.set(TRACEPARENT_HEADER, value);
    return res;
  } catch {
    // Header bất biến (Response.redirect, phản hồi từ fetch…): dựng bản sao có header mới, giữ nguyên thân/status.
    const headers = new Headers(res.headers);
    headers.set(TRACEPARENT_HEADER, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * Bọc xử lý một request: nhận `traceparent` hợp lệ (không thì sinh mới), chạy `fn` trong ngữ cảnh trace, rồi trả `traceparent`
 * (cùng trace-id, span-id của request này) trong phản hồi. Gọi lồng cho cùng một `Request` dùng lại ngữ cảnh (không sinh span mới).
 * `fn` ném lỗi ⇒ ném tiếp (Next trả 500; log lỗi đã phát bên trong ngữ cảnh nên vẫn mang trace).
 */
export async function withRequestTrace(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const existing = byRequest.get(req);
  if (existing) return fn();
  const ctx = newTraceContext(parseTraceparent(req.headers.get(TRACEPARENT_HEADER)));
  byRequest.set(req, ctx);
  const res = await runWithTrace(ctx, fn);
  return withTraceparentHeader(res, formatTraceparent(ctx));
}
