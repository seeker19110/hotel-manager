// Kiểu "người đang thao tác" và lỗi truy cập — lõi dùng chung của `access` (xác định người thao tác) và `pipeline`
// (command pipeline, problem+json). Tách khỏi `access/actor.ts` để hai module không import vòng lẫn nhau (ARC-MOD-004).
// Chỉ kiểu và lớp lỗi thuần, không I/O; `access/actor.ts` xuất lại để đường import cũ vẫn dùng được.

export type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "accountant"
  | "housekeeping"
  | "maintenance"
  | "tenant"
  | "platform_support";

export interface Actor {
  authUserId: string;
  orgId: string;
  membershipId: string;
  personId: string;
  role: Role;
  allProperties: boolean;
  propertyIds: readonly string[];
  limits: Readonly<Record<string, number>>;
  mfaRequired: boolean;
  /** Thời điểm đăng nhập của phiên (Better Auth `session.createdAt`) — thao tác nhạy cảm đòi xác thực lại gần đây. */
  authenticatedAt?: Date;
  /**
   * Truy cập hỗ trợ (`platform_support`, D-128): lý do owner ghi khi cấp và mốc hết hiệu lực (`memberships.valid_to`). Chỉ có ở
   * actor hỗ trợ — mọi lần truy cập trang/query của họ được audit kèm lý do này.
   */
  support?: { reason: string; until: Date };
  /** Gói của tổ chức (`organizations.plan`, D-130) — chọn hạn mức tần suất (`plans/`). Thiếu ⇒ gói mặc định. */
  plan?: string;
}

export type AccessErrorCode = "UNAUTHENTICATED" | "NOT_FOUND" | "MFA_REQUIRED" | "ORG_PENDING_DELETION";

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: 401 | 403 | 404 | 423;
  constructor(code: AccessErrorCode, message: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    // ORG_PENDING_DELETION (T-2312, D-125): tổ chức đang chờ xoá — mọi truy cập bị khoá trừ xuất dữ liệu và huỷ yêu cầu.
    this.status =
      code === "UNAUTHENTICATED"
        ? 401
        : code === "NOT_FOUND"
          ? 404
          : code === "ORG_PENDING_DELETION"
            ? 423
            : 403;
  }
}
