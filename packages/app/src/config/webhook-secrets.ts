// Khoá HMAC webhook (BE-INT-002) — module lá, không import gì để `config/schema.ts` dùng được mà không kéo theo phụ thuộc.
/** Tối thiểu mỗi khoá HMAC của webhook (byte ký tự) và số khoá nhận cùng lúc khi xoay khoá. */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;
export const WEBHOOK_SECRET_MAX_COUNT = 3;

/**
 * `SIM_WEBHOOK_SECRET` là DANH SÁCH khoá phân tách dấu phẩy (BE-INT-002): xoay khoá không gián đoạn = đặt "khoá_mới,khoá_cũ",
 * bên gửi chuyển sang khoá mới, rồi bỏ khoá cũ. Chuỗi rỗng/không đặt ⇒ danh sách rỗng (adapter tắt). Mục rỗng, ngắn
 * hơn `WEBHOOK_SECRET_MIN_LENGTH`, trùng, hay quá `WEBHOOK_SECRET_MAX_COUNT` khoá ⇒ ném lỗi (cấu hình sai thì từ chối khởi động,
 * không lặng lẽ chạy với khoá yếu). Thông điệp lỗi không kèm giá trị khoá.
 */
export function parseWebhookSecrets(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.some((p) => p.length < WEBHOOK_SECRET_MIN_LENGTH))
    throw new Error(
      `mỗi khoá webhook phải có tối thiểu ${WEBHOOK_SECRET_MIN_LENGTH} ký tự (không có mục rỗng)`,
    );
  if (parts.length > WEBHOOK_SECRET_MAX_COUNT)
    throw new Error(`tối đa ${WEBHOOK_SECRET_MAX_COUNT} khoá webhook`);
  if (new Set(parts).size !== parts.length) throw new Error("khoá webhook bị trùng");
  return parts;
}
