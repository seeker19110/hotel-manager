// Lỗi nghiệp vụ → application/problem+json (RFC 9457) theo API-CONTRACT §2.
import { AuthzError, TransitionError } from "@hm/domain";
import type { Transaction } from "kysely";
import { AccessError } from "../access/actor.ts";

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlation_id?: string;
  /** Mở rộng RFC 9457: yêu cầu duyệt đã lập khi vượt hạn mức (SPEC-access S-017). */
  approval_request_id?: string;
  /** Mở rộng: thanh toán đã dùng giao dịch ngân hàng này (SPEC-ledger S-029). */
  payment_id?: string;
  /** Mở rộng INVALID_TRANSITION: trạng thái hiện tại và trạng thái muốn chuyển (SPEC-lease S-020). */
  from?: string;
  to?: string;
  /** Lỗi theo trường (422): `path` theo API-CONTRACT §2, `field` theo SPEC — cùng giá trị. */
  errors?: FieldError[];
}

export interface FieldError {
  path: string;
  field: string;
  code: string;
}

/** Trường mở rộng tĩnh gắn vào problem (RFC 9457). */
export type ProblemExtensions = Partial<
  Pick<Problem, "approval_request_id" | "payment_id" | "from" | "to" | "errors">
>;

/** 422 VALIDATION_FAILED chỉ đúng một trường sai (SPEC-access S-001, SPEC-lease S-007/S-025). */
export function fieldError(field: string, code: string, message: string): CommandError {
  return new CommandError("VALIDATION_FAILED", 422, message, {
    extensions: { errors: [{ path: field, field, code }] },
  });
}

/**
 * Ghi kèm khi lệnh THẤT BẠI (vd. lập yêu cầu duyệt khi vượt hạn mức): chạy trong transaction lưu kết quả lỗi — transaction
 * nghiệp vụ đã rollback — đúng một lần cho mỗi Idempotency-Key; trả trường mở rộng gắn vào problem.
 */
export type FailurePersist = (
  trx: Transaction<unknown>,
) => Promise<Partial<Pick<Problem, "approval_request_id">>>;

/** Lỗi nghiệp vụ có mã — handler ném lớp này (hoặc AuthzError/TransitionError/AccessError). */
export class CommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly persist: FailurePersist | undefined;
  readonly extensions: ProblemExtensions;
  constructor(
    code: string,
    status: number,
    message: string,
    opts: { persist?: FailurePersist; extensions?: ProblemExtensions } = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.status = status;
    this.persist = opts.persist;
    this.extensions = opts.extensions ?? {};
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

/**
 * Trigger/constraint gắn HINT = mã nghiệp vụ (ERD §1 "Vận hành"): HTTP status theo mã (API-CONTRACT §2), không theo lớp
 * lỗi Postgres — vd. `55000` + DOCUMENT_IMMUTABLE là 409, `23514` + INVALID_TRANSITION là 409 (không phải 422).
 */
const HINT_STATUS: Record<string, { status: number; title: string }> = {
  DOCUMENT_IMMUTABLE: { status: 409, title: "Chứng từ đã phát hành/ký không được sửa" },
  EVIDENCE_REQUIRED: { status: 422, title: "Cần chứng cứ thanh toán" },
  INVALID_TRANSITION: { status: 409, title: "Chuyển trạng thái không hợp lệ" },
  LAST_OWNER: { status: 409, title: "Tổ chức phải còn ít nhất một owner" },
  // SPEC-ledger S-003: lỗi hệ thống, 500 GIỮ mã (để cảnh báo/tra cứu) và đi đường lỗi không dự kiến (onUnexpectedError).
  LEDGER_UNBALANCED: { status: 500, title: "Lỗi hệ thống khi ghi sổ. Thao tác chưa được lưu." },
  PERIOD_LOCKED: { status: 409, title: "Kỳ đã khoá. Cần chứng từ điều chỉnh có duyệt." },
  VALIDATION_FAILED: { status: 422, title: "Dữ liệu không hợp lệ" },
  TENANT_CONTEXT_MISSING: { status: 500, title: "Thiếu ngữ cảnh tổ chức" },
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
  if (err instanceof CommandError) return { ...base(err.code, err.status, err.message), ...err.extensions };
  if (err instanceof TransitionError)
    return { ...base(err.code, err.status, err.message), from: err.from, to: err.to };
  if (err instanceof AuthzError || err instanceof AccessError) return base(err.code, err.status, err.message);
  const pg = err as { code?: string; hint?: string };
  const hinted = typeof pg?.hint === "string" ? HINT_STATUS[pg.hint] : undefined;
  if (typeof pg?.code === "string" && hinted && pg.hint) {
    // Lỗi cấu hình hệ thống (thiếu ngữ cảnh) vẫn che như lỗi nội bộ; sổ lệch giữ mã theo SPEC.
    if (hinted.status >= 500 && pg.hint !== "LEDGER_UNBALANCED")
      return base("INTERNAL", 500, "Đã có lỗi, vui lòng thử lại hoặc báo hỗ trợ kèm mã tra cứu");
    return base(pg.hint, hinted.status, hinted.title);
  }
  if (typeof pg?.code === "string" && PG_CODES[pg.code]) {
    const m = PG_CODES[pg.code] as { code: string; status: number; title: string };
    const code = pg.hint && /^[A-Z_]+$/.test(pg.hint) ? pg.hint : m.code;
    return base(code, m.status, m.title);
  }
  // Lỗi không dự kiến: chỉ trả correlation_id, không trả stack/chi tiết (API-CONTRACT §2).
  return base("INTERNAL", 500, "Đã có lỗi, vui lòng thử lại hoặc báo hỗ trợ kèm mã tra cứu");
}
