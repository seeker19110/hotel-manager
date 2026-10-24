// authorize(actor, action, ctx) — kiểm quyền thuần (không I/O), ARCHITECTURE "Kiểm quyền hai lớp" lớp app.
// Lớp CSDL (RLS) là lớp thứ hai; giao diện chỉ ẩn/hiện.

import { t } from "../i18n.ts";
import { type Action, DEFAULT_LIMITS, grantFor, LIMIT_KIND, type MatrixRole, ROLES } from "./matrix.ts";

export interface AuthzActor {
  personId: string;
  membershipId: string;
  role: string;
  allProperties: boolean;
  propertyIds: readonly string[];
  limits: Readonly<Record<string, number>>;
}

export interface AuthzContext {
  /** Cơ sở của tài nguyên; ngoài phạm vi → NOT_FOUND (không lộ tồn tại). */
  propertyId?: string;
  /** Số tiền (đồng) cho hành động có hạn mức. */
  amount?: number;
  /** Chủ thể của bản ghi (person) cho quyền "own". */
  subjectPersonId?: string;
  /** Người lập yêu cầu — duyệt yêu cầu của chính mình bị cấm. */
  requestedByPersonId?: string;
  /** Hoàn/khấu trừ cọc của lễ tân chỉ khi check-out. */
  atCheckout?: boolean;
}

export type AuthzCode = "FORBIDDEN" | "NOT_FOUND" | "APPROVAL_LIMIT_EXCEEDED" | "SELF_APPROVAL_FORBIDDEN";

export class AuthzError extends Error {
  readonly code: AuthzCode;
  readonly status: 403 | 404;
  constructor(code: AuthzCode, message: string) {
    super(message);
    this.name = "AuthzError";
    this.code = code;
    this.status = code === "NOT_FOUND" ? 404 : 403;
  }
}

export interface AuthzResult {
  grant: "yes" | "limit" | "own" | "read" | "request";
  /** Hạn mức đã áp (đồng), nếu có. */
  limit?: number;
}

export function isMatrixRole(role: string): role is MatrixRole {
  return (ROLES as readonly string[]).includes(role);
}

export function effectiveLimit(actor: AuthzActor, kind: string): number {
  const own = actor.limits[kind];
  if (typeof own === "number") return own;
  const role = isMatrixRole(actor.role) ? actor.role : undefined;
  return (role && DEFAULT_LIMITS[role]?.[kind]) ?? 0;
}

export function authorize(actor: AuthzActor, action: Action, ctx: AuthzContext = {}): AuthzResult {
  // SPEC-portal S-005: người thuê (không có phạm vi cơ sở) gọi API nhân viên → 403 rõ ràng, không phải 404 do phạm vi.
  if (actor.role === "tenant" && grantFor(action, "tenant") === "no")
    throw new AuthzError("FORBIDDEN", t("authz.forbidden"));
  if (ctx.propertyId !== undefined && !actor.allProperties && !actor.propertyIds.includes(ctx.propertyId)) {
    throw new AuthzError("NOT_FOUND", t("authz.not_found"));
  }
  if (!isMatrixRole(actor.role)) throw new AuthzError("FORBIDDEN", t("authz.role_not_allowed"));
  const grant = grantFor(action, actor.role);

  switch (grant) {
    case "no":
      throw new AuthzError("FORBIDDEN", t("authz.forbidden"));
    case "yes":
    case "read":
    case "request":
      if (
        ctx.requestedByPersonId !== undefined &&
        ctx.requestedByPersonId === actor.personId &&
        grant === "yes"
      ) {
        // Owner duyệt yêu cầu do chính mình lập cũng bị cấm (INV-F5) — chỉ khi ngữ cảnh là duyệt.
        throw new AuthzError("SELF_APPROVAL_FORBIDDEN", t("authz.self_approval"));
      }
      return { grant };
    case "own":
      if (ctx.subjectPersonId === undefined || ctx.subjectPersonId !== actor.personId) {
        throw new AuthzError("FORBIDDEN", t("authz.own_records_only"));
      }
      return { grant };
    case "limit": {
      if (ctx.requestedByPersonId !== undefined && ctx.requestedByPersonId === actor.personId) {
        throw new AuthzError("SELF_APPROVAL_FORBIDDEN", t("authz.self_approval"));
      }
      if (
        actor.role === "front_desk" &&
        (action === "deposit.refund" || action === "credit.refund") &&
        !ctx.atCheckout
      ) {
        throw new AuthzError("FORBIDDEN", t("authz.front_desk_refund_checkout_only"));
      }
      const kind = LIMIT_KIND[action] ?? "refund";
      const limit = effectiveLimit(actor, kind);
      if (ctx.amount === undefined || !Number.isInteger(ctx.amount) || ctx.amount < 0) {
        throw new AuthzError("FORBIDDEN", t("authz.amount_required"));
      }
      if (ctx.amount > limit) throw new AuthzError("APPROVAL_LIMIT_EXCEEDED", t("authz.limit_exceeded"));
      return { grant, limit };
    }
  }
}

/**
 * Quyền LẬP yêu cầu duyệt cho một hành động có hạn mức/đề nghị: mọi ô khác "—" trong ma trận (kể cả "Đề nghị" của kế
 * toán) và trong phạm vi cơ sở. Không kiểm số tiền — số tiền chỉ kiểm khi DUYỆT (authorize).
 */
export function authorizeRequest(actor: AuthzActor, action: Action, ctx: { propertyId?: string } = {}): void {
  if (ctx.propertyId !== undefined && !actor.allProperties && !actor.propertyIds.includes(ctx.propertyId)) {
    throw new AuthzError("NOT_FOUND", t("authz.not_found"));
  }
  if (!isMatrixRole(actor.role) || grantFor(action, actor.role) === "no") {
    throw new AuthzError("FORBIDDEN", t("authz.request_forbidden"));
  }
}
