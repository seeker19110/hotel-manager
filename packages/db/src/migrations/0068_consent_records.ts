// PLAN T-2310 (CMP-RIGHTS-001, CMP-RIGHTS-004, CMP-VN-001; D-122) — bằng chứng đồng ý theo mục đích, APPEND-ONLY, theo TÀI KHOẢN.
// - `consent_records`: mỗi lần cho hoặc rút đồng ý là MỘT hàng mới (`action` = grant|withdraw); trạng thái hiện tại của
//   (subject_user_id, purpose) = hàng mới nhất theo (`recorded_at`, `seq`). "granted_at"/"withdrawn_at" của PLAN chính là
//   `recorded_at` của hàng grant/withdraw — không cột NULL, không sửa hàng cũ. `seq` (identity) phá hoà khi hai hàng cùng
//   transaction (`now()` bằng nhau). `recorded_at` do CSDL đặt: `app_runtime` chỉ có quyền INSERT theo cột, KHÔNG gồm
//   `recorded_at`/`seq` nên client không lùi/tiến được mốc thời gian của bằng chứng.
// - Không theo tổ chức (đồng ý là của tài khoản, có từ lúc đăng ký — trước khi thuộc tổ chức nào): ngoại lệ IND-SAAS-001 khai ở
//   packages/testkit/src/schema-guards.no-org.json. `subject_user_id` là id `auth."user"` KHÔNG khoá ngoại (ERD §4: không FK từ
//   bảng nghiệp vụ sang `auth`; bằng chứng đồng ý không được chặn việc xoá tài khoản — T-2311 quyết số phận hàng khi xoá).
// - Append-only như `audit_events`: trigger chặn UPDATE/DELETE (mỗi hàng) và TRUNCATE (`app.forbid_mutation`, SQLSTATE 55000).
// - RLS bật + FORCE theo NGỮ CẢNH NGƯỜI DÙNG mới `app.user_id` (đặt bởi `withUserContext` của @hm/db từ phiên đã xác minh ở
//   server, không từ client): `app_runtime` chỉ SELECT/INSERT hàng có `subject_user_id = app.current_user_id()`. Thiếu ngữ cảnh ⇒
//   `app.current_user_id()` ném 42501 USER_CONTEXT_MISSING (cùng khuôn `app.current_org()`), không âm thầm trả rỗng.
//   `app_worker` không có quyền (chưa có job dùng; DSAR T-2311 tự cấp nếu cần).
// - `purpose` CHECK theo danh mục trong mã (packages/app/src/privacy/purposes.ts — chỉ mục đích CẦN đồng ý mới có hàng ở đây);
//   thêm mục đích = migration mới nới CHECK. `channel` ∈ signup|invite|portal|settings. `ui_snapshot_hash` = sha-256 hex của văn
//   bản hiển thị (server tự tính từ catalog, không nhận từ client).
// - Index `(subject_user_id, purpose, recorded_at DESC, seq DESC)` phục vụ "hàng mới nhất" và lịch sử theo người. Bảng mới, rỗng.
// - Down: xoá bảng (trigger/policy đi theo) rồi hàm ngữ cảnh — mất bằng chứng đồng ý nên chỉ dùng khi lùi bản phát hành chưa có
//   người dùng thật (bộ kiểm analytics khi đó về mặc định từ chối).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.user_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.user_id is not set — missing user context' USING ERRCODE = '42501', HINT = 'USER_CONTEXT_MISSING';
  END IF;
  RETURN v::uuid;
END $$;
REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_runtime;

CREATE TABLE consent_records (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  subject_user_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('analytics')),
  action text NOT NULL CHECK (action IN ('grant', 'withdraw')),
  policy_version text NOT NULL CHECK (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\\.[0-9]{1,3})?$'),
  channel text NOT NULL CHECK (channel IN ('signup', 'invite', 'portal', 'settings')),
  ui_snapshot_hash text NOT NULL CHECK (ui_snapshot_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consent_records_subject_purpose_time
  ON consent_records (subject_user_id, purpose, recorded_at DESC, seq DESC);

CREATE TRIGGER trg_consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_consent_records_no_truncate BEFORE TRUNCATE ON consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_records_self_read ON consent_records FOR SELECT
  USING (subject_user_id = app.current_user_id());
CREATE POLICY consent_records_self_insert ON consent_records FOR INSERT
  WITH CHECK (subject_user_id = app.current_user_id());
REVOKE ALL ON consent_records FROM PUBLIC;
GRANT SELECT ON consent_records TO app_runtime;
GRANT INSERT (id, subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash) ON consent_records TO app_runtime;
`;

const DOWN = `
DROP TABLE IF EXISTS consent_records;
DROP FUNCTION IF EXISTS app.current_user_id();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
