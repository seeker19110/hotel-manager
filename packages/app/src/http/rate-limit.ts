// Giới hạn tần suất dùng bộ đếm trong Postgres (migration 0053, `app.rate_limit_hit`; BE-REL-006, IND-SAAS-008) cho route KHÔNG
// đi qua hạn mức lệnh của pipeline: tải file/nhập liệu (thân lớn, quét mã độc, ghi object) và webhook ngân hàng. Bộ đếm nằm ở
// CSDL nên đúng khi nhiều instance/pool; khoá advisory trong hàm SQL chặn hai kết nối cùng lọt lượt cuối. Vượt ⇒ 429
// RATE_LIMITED + `Retry-After` (số giây tới hết cửa sổ). Lỗi CSDL được ném lên (đóng an toàn: 5xx, không bỏ qua giới hạn).

import type { Kysely } from "kysely";
import type { Actor } from "../access/index.ts";
import { t } from "../i18n.ts";
import { emitSecurity, requestClient } from "../logging/index.ts";
import { rateLimited, rateLimitHit, toProblem } from "../pipeline/index.ts";
import { DEFAULT_PLAN, PLANS } from "../plans/index.ts";
import { problemResponse } from "./command-route.ts";

// Giữ đường import cũ của bộ đếm (đã chuyển sang `pipeline/rate-counter.ts` để `access` dùng chung).
export { RATE_WINDOW_SECONDS, type RateHit, type RateResult, rateLimitHit } from "../pipeline/index.ts";

/**
 * Tải ảnh/PDF (vật dụng, phiếu sự cố, báo chuyển): mỗi thành viên / mỗi tổ chức trong 60 giây. Vượt xa thao tác tay. Theo gói của
 * tổ chức (`plans/`, D-130: route dùng `planLimits(actor.plan)`); các hằng dưới đây = gói mặc định `pilot`.
 */
export const FILE_UPLOAD_PER_MEMBER_PER_MINUTE = PLANS[DEFAULT_PLAN].fileUploadsPerMinute.member;
export const FILE_UPLOAD_PER_ORG_PER_MINUTE = PLANS[DEFAULT_PLAN].fileUploadsPerMinute.org;
/** Nhập liệu (CSV/XLSX tới 10 MB, quét + phân tích nặng): chặt hơn tải ảnh. */
export const IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE = PLANS[DEFAULT_PLAN].importUploadsPerMinute.member;
export const IMPORT_UPLOAD_PER_ORG_PER_MINUTE = PLANS[DEFAULT_PLAN].importUploadsPerMinute.org;
/** Webhook đã xác thực chữ ký: mỗi (nhà cung cấp, tài khoản) — ngân hàng bắn dồn khi đồng bộ vẫn dư. */
export const WEBHOOK_PER_ACCOUNT_PER_MINUTE = 600;
/** Webhook chữ ký SAI: theo nhà cung cấp (không theo tài khoản do kẻ gọi tự chọn ⇒ bảng không phình). Vượt ⇒ 429 thay cho 401. */
export const WEBHOOK_BAD_SIGNATURE_PER_MINUTE = 300;

/**
 * Hạn mức thành viên (kiểm TRƯỚC — kẻ spam chỉ tự chặn mình) rồi tổ chức. Trả `Response` 429 (có `Retry-After`) nếu vượt,
 * ngược lại null. Ghi sự kiện bảo mật `rate_limit.exceeded` (không kèm nội dung).
 */
export async function enforceActorRateLimit(
  db: Kysely<unknown>,
  actor: Actor,
  req: Request,
  correlationId: string,
  rule: { scope: string; perMember: number; perOrg: number },
): Promise<Response | null> {
  const checks = [
    {
      scope: `${rule.scope}:member`,
      subject: actor.membershipId,
      limit: rule.perMember,
      message: t("http.rate_limit.upload_member"),
    },
    {
      scope: `${rule.scope}:org`,
      subject: actor.orgId,
      limit: rule.perOrg,
      message: t("http.rate_limit.upload_org"),
    },
  ];
  for (const c of checks) {
    const r = await rateLimitHit(db, { scope: c.scope, subject: c.subject, limit: c.limit });
    if (r.allowed) continue;
    emitSecurity({
      event: "rate_limit.exceeded",
      outcome: "denied",
      actor,
      target: { type: "route", id: rule.scope },
      reason: "RATE_LIMITED",
      client: requestClient(req.headers),
      correlationId,
    });
    return problemResponse(toProblem(rateLimited(c.message, r.retryAfter), correlationId), correlationId);
  }
  return null;
}
