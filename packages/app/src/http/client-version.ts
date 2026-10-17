// Phiên bản client tối thiểu (SPEC-pwa S-009, Q-02): client web gửi `X-App-Version: <semver build>` kèm mỗi command; server so với
// mức tối thiểu của bản triển khai — thấp hơn ⇒ 426 CLIENT_OUTDATED, KHÔNG ghi gì, UI hiện nút "Cập nhật".
// Mức tối thiểu lấy từ `apps/web/package.json` (`hm.minClientVersion`), không qua biến môi trường: nâng mức = đổi mã + phát hành.
// Quy ước: không có header (script/API client/test không tự khai phiên bản) ⇒ cho qua; có header mà không phải semver ⇒ coi là
// quá cũ (chặt hơn: client tự khai phải khai đúng).

export const CLIENT_VERSION_HEADER = "x-app-version";

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `major.minor.patch` (bỏ phần tiền phát hành/build) hoặc null khi không đúng semver. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Âm: a < b; 0: bằng; dương: a > b (theo major, minor, patch). */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Client có quá cũ không. `header` = giá trị `X-App-Version` (null = không gửi); `min` = mức tối thiểu (undefined/rỗng/sai định dạng
 * ⇒ không bắt buộc, tránh khoá nhầm toàn bộ người dùng vì cấu hình hỏng).
 */
export function isClientOutdated(header: string | null | undefined, min: string | null | undefined): boolean {
  if (header === null || header === undefined) return false;
  const minV = min ? parseVersion(min) : null;
  if (!minV) return false;
  const got = parseVersion(header);
  return got === null || compareVersions(got, minV) < 0;
}
