// Lỗi nghiệp vụ → application/problem+json (RFC 9457) theo API-CONTRACT §2.
import { AuthzError, TransitionError } from "@hm/domain";
import { AccessError } from "../access/actor.ts";

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlation_id?: string;
}

/** Lỗi nghiệp vụ có mã — handler ném lớp này (hoặc AuthzError/TransitionError/AccessError). */
export class CommandError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.status = status;
  }
}

const TYPE_BASE = "https://hotel-manager.invalid/errors/";

/** Lỗi ràng buộc Postgres → mã nghiệp vụ (ERD §1 "Vận hành"). */
const PG_CODES: Record<string, { code: string; status: number; title: string }> = {
  "23P01": {
    code: "ROOM_UNAVAILABLE",
    status: 409,
    title: "Phòng đã có người đặt trong khoảng thời gian này",
  },
  "23505": { code: "DUPLICATE", status: 409, title: "Dữ liệu đã tồn tại" },
  "23503": { code: "NOT_FOUND", status: 404, title: "Không tìm thấy" },
  "23514": { code: "VALIDATION_FAILED", status: 422, title: "Dữ liệu không hợp lệ" },
  "42501": { code: "FORBIDDEN", status: 403, title: "Không có quyền" },
};

export function toProblem(err: unknown, correlationId?: string): Problem {
  const base = (code: string, status: number, title: string, detail?: string): Problem => ({
    type: `${TYPE_BASE}${code}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  });
  if (
    err instanceof CommandError ||
    err instanceof AuthzError ||
    err instanceof AccessError ||
    err instanceof TransitionError
  ) {
    return base(err.code, err.status, err.message);
  }
  const pg = err as { code?: string; hint?: string };
  if (typeof pg?.code === "string" && PG_CODES[pg.code]) {
    const m = PG_CODES[pg.code] as { code: string; status: number; title: string };
    const code = pg.hint && /^[A-Z_]+$/.test(pg.hint) ? pg.hint : m.code;
    return base(code, m.status, m.title);
  }
  // Lỗi không dự kiến: chỉ trả correlation_id, không trả stack/chi tiết (API-CONTRACT §2).
  return base("INTERNAL", 500, "Đã có lỗi, vui lòng thử lại hoặc báo hỗ trợ kèm mã tra cứu");
}
