// Quy tắc nhập liệu THUẦN (không I/O, không import) dùng chung hai phía: form ở trình duyệt (`apps/web/components/command/
// command-form.tsx`, qua `@hm/app/form-rules`) và schema Zod của danh mục command (`registry.ts`). Không import zod ở đây để
// bundle trình duyệt không kéo thêm thư viện hay mã server (PLAN đợt 5 T-411, FE-FORM-001). Server vẫn validate lại mọi
// request — phía client chỉ để báo lỗi sớm, không phải ranh giới tin cậy.

const NFC_MAX_DEPTH = 64;

/**
 * Đệ quy chuẩn hoá Unicode NFC cho chuỗi (giá trị và khoá); kiểu khác chuỗi giữ nguyên. Quá sâu (> 64 tầng) trả nguyên — schema
 * strict sẽ từ chối sau. Server chuẩn hoá thân JSON bằng hàm này TRƯỚC khi vào schema (`command-route.ts`), nên client cũng phải
 * gọi nó trước khi kiểm: chuỗi NFD (e + dấu) dài hơn NFC và sẽ bị chặn sai nếu kiểm thô.
 */
export function nfcDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return value.normalize("NFC") as T;
  if (depth > NFC_MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => nfcDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k.normalize("NFC")] = nfcDeep(v, depth + 1);
  return out as T;
}

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
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.hasOwn(shown, name) ? (shown[name] ?? "—") : "—",
  );
}
