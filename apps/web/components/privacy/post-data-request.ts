// Gửi yêu cầu quyền chủ thể của CHÍNH người đang đăng nhập (POST /api/v1/me/data-requests — T-2311, D-123). Server lấy người dùng từ
// phiên, tự tính hạn theo vùng; client chỉ gửi loại yêu cầu và (khi xoá) mật khẩu nhập lại để xác thực lại.
import { timedFetch } from "../../lib/fetch-timeout.ts";

export type DataRequestType = "access" | "delete" | "restrict";

export interface DataRequestOutcome {
  ok: boolean;
  status: number;
  /** Mã lỗi problem+json (REAUTH_REQUIRED, LAST_OWNER, RATE_LIMITED…) khi không thành công. */
  code: string | null;
  /** `reason` của REAUTH_REQUIRED: `invalid_password` (sai mật khẩu) | `reauth_required` (cần xác thực lại). */
  reason: string | null;
  result: "created" | "existing" | null;
}

export async function postDataRequest(type: DataRequestType, password?: string): Promise<DataRequestOutcome> {
  const res = await timedFetch("/api/v1/me/data-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(password === undefined ? { type } : { type, password }),
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    reason?: string;
    data?: { status?: "created" | "existing" };
  };
  return {
    ok: res.ok,
    status: res.status,
    code: body.code ?? null,
    reason: body.reason ?? null,
    result: body.data?.status ?? null,
  };
}
