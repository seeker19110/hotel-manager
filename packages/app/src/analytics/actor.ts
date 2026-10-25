// Định danh giả danh cho sự kiện (PM-METRIC-005): actor_key = HMAC-SHA256(userId) với khoá dẫn xuất HKDF-SHA256 từ MỘT bí mật đã có trong
// cấu hình (BETTER_AUTH_SECRET — không thêm biến môi trường), nhãn riêng nên khoá này khác khoá token lời mời/huỷ đăng ký/phiên.
// Cùng người + cùng khoá ⇒ cùng actor_key (đếm người dùng duy nhất được); khác người hoặc khác bí mật ⇒ khác. Không đảo ngược được nếu không
// có bí mật. LƯU Ý vận hành: xoay bí mật thì actor_key mới KHÔNG khớp hàng cũ (đếm người duy nhất đứt đoạn; `forgetAnalyticsActor` không tìm
// thấy hàng cũ) — hàng cũ tự hết hạn theo RET-19 (13 tháng).
import { createHmac, hkdfSync } from "node:crypto";

const LABEL = "hm-analytics-actor-v1";

export function analyticsActorKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), LABEL, 32));
}

/** HMAC-SHA256(userId) — 32 byte. `userId` rỗng là lỗi lập trình (mọi người dùng rỗng sẽ gộp một actor). */
export function pseudonymizeActor(key: Buffer, userId: string): Buffer {
  if (userId.length === 0) throw new Error("analytics: userId is empty");
  return createHmac("sha256", key).update(userId).digest();
}
