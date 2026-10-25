// T-2310 (CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004; D-119) — bản ghi đồng ý theo MỤC ĐÍCH, chỉ-thêm.
// - Một hàng = một lần cấp (`grant`) hoặc rút (`withdraw`) đồng ý cho MỘT mục đích của MỘT người dùng. Không sửa tại chỗ: rút đồng ý là
//   thêm một hàng `withdraw`; trạng thái hiện tại = hàng MỚI NHẤT theo (subject_user_id, purpose) — thứ tự theo `id` (identity tăng dần;
//   app khoá tư vấn theo (người, mục đích) trong transaction ghi nên thứ tự `id` = thứ tự commit của cùng người + mục đích).
// - Chủ thể = tài khoản đăng nhập `auth."user".id` cho MỌI kênh: nhân viên/chủ (mật khẩu) và người thuê (OTP email) đều là người dùng
//   Better Auth. Không dùng persons/tổ chức: người dùng có thể chưa thuộc tổ chức nào (đăng ký xong mới tạo tổ chức), và một người dùng
//   thuộc nhiều tổ chức vẫn là MỘT chủ thể. FK RESTRICT: không xoá được tài khoản còn bản ghi đồng ý (xoá tài khoản = T-2311).
// - Danh mục ĐÓNG ở CSDL (CHECK) khớp `packages/app/src/privacy/consent.ts`: purpose ∈ {service_core, product_analytics}; action ∈
//   {grant, withdraw}; channel ∈ {register, invitation, portal, settings}. `policy_version` = phiên bản văn bản chính sách (YYYY-MM-DD[.n]);
//   `ui_snapshot_hash` = SHA-256 hex của đúng văn bản đồng ý đã hiển thị (app băm từ catalog i18n, không nhận từ client).
// - QUYỀN — không phải dữ liệu tổ chức nên KHÔNG dùng `app.current_org()`. RLS bật + FORCE với ngữ cảnh NGƯỜI DÙNG: app đặt
//   `SET LOCAL app.auth_user_id` = id người dùng của PHIÊN đã xác minh ở server (không bao giờ từ thân request) rồi mới đọc/ghi; policy
//   chỉ cho thấy/ghi hàng có `subject_user_id = app.current_auth_user()`. Thiếu ngữ cảnh ⇒ hàm trả NULL ⇒ không thấy/không ghi được gì.
//   app_runtime: SELECT + INSERT (vẫn chịu RLS). app_worker: không quyền (chưa có job cần; T-2311 thêm khi cần, qua hàm phạm vi hẹp).
// - Chỉ-thêm như audit_events (0003): trigger `app.forbid_mutation` chặn UPDATE/DELETE (mỗi hàng) và TRUNCATE kể cả với owner bảng.
// - Index (subject_user_id, purpose, id DESC): trạng thái hiện tại theo người + mục đích, và phục vụ FK subject_user_id.
// - Down: gỡ bảng + hàm ngữ cảnh (mất bằng chứng đồng ý — chỉ dùng khi lùi bản phát hành ngay sau khi áp; không bảng nào tham chiếu).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE FUNCTION app.current_auth_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.auth_user_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION app.current_auth_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_auth_user() TO app_runtime, app_worker;

CREATE TABLE consent_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('service_core', 'product_analytics')),
  action text NOT NULL CHECK (action IN ('grant', 'withdraw')),
  policy_version text NOT NULL CHECK (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\\.[0-9]{1,3})?$'),
  channel text NOT NULL CHECK (channel IN ('register', 'invitation', 'portal', 'settings')),
  ui_snapshot_hash text NOT NULL CHECK (ui_snapshot_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consent_records_subject_purpose ON consent_records (subject_user_id, purpose, id DESC);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_records_self_read ON consent_records FOR SELECT
  USING (subject_user_id = app.current_auth_user());
CREATE POLICY consent_records_self_insert ON consent_records FOR INSERT
  WITH CHECK (subject_user_id = app.current_auth_user());
REVOKE ALL ON consent_records FROM PUBLIC;
GRANT SELECT, INSERT ON consent_records TO app_runtime;

CREATE TRIGGER trg_consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_consent_records_no_truncate BEFORE TRUNCATE ON consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
`;

const DOWN = `
DROP TABLE IF EXISTS consent_records;
DROP FUNCTION IF EXISTS app.current_auth_user();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
