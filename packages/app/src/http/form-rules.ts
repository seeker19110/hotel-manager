// Quy tắc nhập liệu THUẦN (không I/O, không import) dùng chung hai phía: form ở trình duyệt (`apps/web/components/command/
// command-form.tsx`, qua `@hm/app/form-rules`) và schema Zod của danh mục command (`registry.ts`). Không import zod ở đây để
// bundle trình duyệt không kéo thêm thư viện hay mã server (PLAN đợt 5 T-411, FE-FORM-001). Server vẫn validate lại mọi
// request — phía client chỉ để báo lỗi sớm, không phải ranh giới tin cậy.

/** Trần số tiền / số nguyên đếm: số nguyên an toàn của JS (đồng, không số lẻ). */
export const MONEY_MAX = Number.MAX_SAFE_INTEGER;

/** Số nguyên không âm ≤ MONEY_MAX từ chuỗi chỉ gồm chữ số; ngoài ra `null`. */
export function parseIntegerInput(s: string): number | null {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= MONEY_MAX ? n : null;
}

/** Tiền nhập kiểu VN: chữ số, cho phép dấu chấm phân cách nghìn đúng nhóm 3 (3.580.000); ngoài ra `null`. */
export function parseMoneyInput(s: string): number | null {
  const t = s.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return parseIntegerInput(t.replaceAll(".", ""));
  return parseIntegerInput(t);
}

/** Số ≥ 0 tối đa 3 chữ số thập phân, dấu chấm (chỉ số công tơ); ngoài ra `null`. */
export function parseDecimalInput(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n <= MONEY_MAX ? n : null;
}

/** Thay `{tên_ô}` trong nhãn xác nhận bằng giá trị đã nhập; ô không có giá trị → "—". Một lượt, không quét lại phần đã thay. */
export function fillConfirmLabel(template: string, shown: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => shown[name] ?? "—");
}
