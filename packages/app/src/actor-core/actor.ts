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
   * Chỉ với `platform_support` (F-015, D-122): truy cập hỗ trợ CÒN HIỆU LỰC mà actor này dựa vào (chưa thu hồi, chưa hết hạn tại lúc
   * tra). Mọi audit của actor gắn `support_grant_id` + lý do của grant. Không có grant hiệu lực ⇒ `resolveActor` không trả actor.
   */
  supportGrant?: SupportGrantRef;
}

export interface SupportGrantRef {
  id: string;
  reason: string;
  expiresAt: Date;
}

export type AccessErrorCode = "UNAUTHENTICATED" | "NOT_FOUND" | "MFA_REQUIRED";

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: 401 | 403 | 404;
  constructor(code: AccessErrorCode, message: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.status = code === "UNAUTHENTICATED" ? 401 : code === "NOT_FOUND" ? 404 : 403;
  }
}
