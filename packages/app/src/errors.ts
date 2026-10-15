// Danh mục mã lỗi (API-CONTRACT §2: "khi code có, danh mục sinh từ packages/app/src/errors.ts và CI kiểm khớp").
// errors.test.ts kiểm: mọi mã dùng chung của API-CONTRACT có ở đây với cùng HTTP status; mọi `CommandError("X", n)` trong
// mã nguồn có ở đây với cùng n. Thêm mã mới: thêm vào đây + SPEC §6 tương ứng (hoặc bảng chung nếu ≥ 2 SPEC dùng).

export interface ErrorSpec {
  status: number;
  /** Nơi định nghĩa: "contract" = bảng dùng chung API-CONTRACT §2; còn lại là SPEC/ADR/thiết kế nội bộ. */
  source: string;
}

export const ERROR_CODES = {
  // API-CONTRACT §2 — mã dùng chung
  VALIDATION_FAILED: { status: 422, source: "contract" },
  MALFORMED_REQUEST: { status: 400, source: "contract" },
  UNAUTHENTICATED: { status: 401, source: "contract" },
  REAUTH_REQUIRED: { status: 401, source: "contract" },
  FORBIDDEN: { status: 403, source: "contract" },
  NOT_FOUND: { status: 404, source: "contract" },
  IDEMPOTENCY_CONFLICT: { status: 409, source: "contract" },
  ROOM_UNAVAILABLE: { status: 409, source: "contract" },
  INVALID_TRANSITION: { status: 409, source: "contract" },
  VERSION_CONFLICT: { status: 409, source: "contract" },
  OVER_ALLOCATION: { status: 409, source: "contract" },
  PERIOD_LOCKED: { status: 409, source: "contract" },
  LINK_EXPIRED: { status: 410, source: "contract" },
  FILE_TOO_LARGE: { status: 413, source: "contract" },
  FILE_TYPE_NOT_ALLOWED: { status: 415, source: "contract" },
  APPROVAL_LIMIT_EXCEEDED: { status: 403, source: "contract" },
  SELF_APPROVAL_FORBIDDEN: { status: 403, source: "contract" },
  DOCUMENT_IMMUTABLE: { status: 409, source: "contract" },
  CONTEXT_CHANGED: { status: 409, source: "contract" },
  METER_READING_DECREASED: { status: 422, source: "contract" },
  HOLD_EXPIRED: { status: 409, source: "contract" },
  ROOM_OCCUPIED: { status: 409, source: "contract" },
  UNIT_OUT_OF_SERVICE: { status: 409, source: "contract" },
  COMMAND_NOT_FOUND: { status: 404, source: "contract" },
  RATE_LIMITED: { status: 429, source: "contract" },
  INTERNAL: { status: 500, source: "contract" },
  // Riêng tính năng / nội bộ
  ORG_CONTEXT_REQUIRED: { status: 409, source: "SPEC-access-and-property §6" },
  MFA_REQUIRED: { status: 403, source: "SPEC-access-and-property Q-06 (T-006)" },
  LAST_OWNER: { status: 409, source: "SPEC-access-and-property §6" },
  APPROVAL_NOT_EXECUTABLE: { status: 409, source: "PLAN đợt 2 T-102 (loại chưa có executor)" },
  WEBHOOK_SIGNATURE_INVALID: { status: 401, source: "API-CONTRACT §3" },
  LEDGER_UNBALANCED: { status: 422, source: "SPEC-ledger-payments §6" },
  INBOX_HASH_MISMATCH: { status: 409, source: "SPEC-ledger-payments §6" },
  BLOCK_CONFLICT: { status: 409, source: "SPEC-inventory-allocation §6" },
  SHIFT_ALREADY_OPEN: { status: 409, source: "SPEC-ledger-payments §6" },
  SHIFT_NOT_OPEN: { status: 409, source: "SPEC-ledger-payments §6" },
  SHIFT_HAS_PENDING_PAYMENTS: { status: 409, source: "SPEC-ledger-payments §6" },
  EVIDENCE_REQUIRED: { status: 422, source: "SPEC-ledger-payments §6" },
  BANK_TRANSACTION_ALREADY_USED: { status: 409, source: "SPEC-ledger-payments §6" },
  DUPLICATE: { status: 409, source: "unique 23505 chưa có mã nghiệp vụ riêng" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}
