// Cửa vào định dạng tiền/ngày cho `apps/*` (XC-I18N-003): subpath nhẹ, KHÔNG kéo barrel máy chủ (pg, better-auth) vào bundle
// trình duyệt — `apps/web/lib/format.ts` được import cả từ Client Component.
export * from "@hm/domain/format";
