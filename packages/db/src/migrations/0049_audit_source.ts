// PLAN đợt 5 T-405 (CMP-AUDIT-002, IND-SAAS-009): audit "từ đâu" — `audit_events` thêm `source_ip` và `user_agent`.
// - `source_ip`: IP ĐÃ CẮT ở tầng ứng dụng (IPv4 → /24 `a.b.c.0`, IPv6 → /48 `x:y:z::`; xem `anonymizeIp`), KHÔNG lưu IP đầy
//   đủ (cùng quyết định với log bảo mật, SEC-LOG-002). CSDL chặn dạng không phải IP cắt hợp lệ để dòng ghi bằng đường khác
//   cũng không lọt IP đầy đủ. `NULL` = lệnh do worker/hệ thống, hoặc request không xác định được IP.
// - `user_agent`: ≤ 200 ký tự, đã chuẩn hoá NFC ở tầng ứng dụng; CSDL chỉ giữ trần độ dài.
// - Append-only giữ nguyên (trigger 0003: chặn UPDATE/DELETE/TRUNCATE) — thêm cột không chạm trigger. RLS đọc theo quyền
//   (0042 `audit_read_by_role`) áp cho cả hai cột mới vì cùng hàng; không cần policy mới. Hai cột nullable, không giá trị mặc
//   định ⇒ ADD COLUMN không ghi lại bảng (expand-only, an toàn khi triển khai cuốn chiếu).
import { type Kysely, sql } from "kysely";

const UP = `
ALTER TABLE audit_events
  ADD COLUMN source_ip text,
  ADD COLUMN user_agent text;
ALTER TABLE audit_events
  ADD CONSTRAINT ck_audit_source_ip CHECK (
    source_ip IS NULL
    OR source_ip ~ '^(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.0|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::)$'),
  ADD CONSTRAINT ck_audit_user_agent CHECK (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 200);
`;

const DOWN = `
ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS ck_audit_source_ip,
  DROP CONSTRAINT IF EXISTS ck_audit_user_agent;
ALTER TABLE audit_events
  DROP COLUMN IF EXISTS source_ip,
  DROP COLUMN IF EXISTS user_agent;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
