// Ghi lỗi không dự kiến cho web (BASE-ERR-002): đủ để chẩn đoán (loại, thông điệp, stack, cause, correlation_id) mà không
// kèm bí mật/PII — logger đã che khoá nhạy cảm và chuỗi kết nối/token trong thông điệp và stack.
import { type Logger, redact } from "./logger.ts";

/** Lỗi 5xx trong route handler/command: `err` là `Error` ⇒ logger nâng thành `exception.type/message/stacktrace/cause`. */
export function reportUnexpectedError(log: Logger, err: unknown, correlationId: string): void {
  log.error("lỗi không dự kiến", {
    correlation_id: correlationId,
    // Không phải Error (throw "chuỗi", throw {…}) vẫn ghi được: bọc để có stack tại điểm ghi.
    err: err instanceof Error ? err : new Error(`giá trị bị ném không phải Error: ${describeThrown(err)}`),
  });
}

function describeThrown(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 200);
  try {
    return JSON.stringify(redact(v))?.slice(0, 200) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

/** Phần mô tả request do Next `onRequestError` truyền (cấu trúc tối thiểu; không phụ thuộc kiểu của `next`). */
export interface RequestErrorInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface RequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

const CORRELATION = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Lỗi chưa bắt khi Next render trang/route (hook `onRequestError` của `instrumentation.ts`). Ghi MẪU route (`/hop-dong/[id]`),
 * không ghi đường dẫn thật (có thể chứa id/token), không ghi header (cookie, authorization) hay query.
 */
export function reportRequestError(
  log: Logger,
  err: unknown,
  request: RequestErrorInfo,
  context: RequestErrorContext,
): void {
  const raw = request.headers["x-correlation-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const digest = (err as { digest?: unknown } | null)?.digest;
  log.error("lỗi render/route không dự kiến", {
    ...(header && CORRELATION.test(header) ? { correlation_id: header } : {}),
    method: request.method,
    route: context.routePath ?? "(không rõ)",
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource,
    ...(typeof digest === "string" ? { digest } : {}),
    err: err instanceof Error ? err : new Error(`giá trị bị ném không phải Error: ${describeThrown(err)}`),
  });
}
