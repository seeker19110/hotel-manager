// T-2312 (IND-SAAS-006, UX-CONTENT-005; D-121) — vòng đời xoá tổ chức: yêu cầu → chờ 30 ngày (chỉ đọc + xuất, huỷ một bước) → purge →
// chứng nhận xoá.
// - `organizations`: thêm `deletion_requested_at`, `deletion_due_at` (= requested + ĐÚNG 30 ngày — CHECK), `deletion_requested_by` (id auth
//   user của owner yêu cầu; KHÔNG FK — người này có thể xoá tài khoản sau đó, chứng nhận vẫn phải tra được), `deleted_at` (lúc purge; ≥ hạn).
//   Trigger `app.organization_deletion_guard`: với vai trò app (app_runtime/app_worker) chỉ OWNER (`app.actor_role()`) đổi được ba cột
//   yêu cầu; không ai đặt `deleted_at` ngoài hàm purge (SECURITY DEFINER); tổ chức đã purge thì bất biến với vai trò app.
// - `org_deletion_certificates`: chứng nhận xoá — CHỦ Ý KHÔNG FK tới `organizations` (chứng nhận phải sống sau purge, kể cả khi sau này hàng
//   tổ chức bị xoá hẳn lúc hết hạn giữ chứng từ). `content` là văn bản JSON (object) và `content_sha256` = sha256(UTF-8 của `content`) —
//   CHECK bảo đảm băm khớp; người nhận tự băm lại tệp tải về để đối chiếu. Append-only (forbid_mutation). RLS bật + FORCE (tenant_isolation
//   + 3 policy support_read_only_* như mọi bảng có organization_id — 0071/TM-12); KHÔNG cấp quyền bảng cho vai trò app: owner cũ đọc qua
//   `app.org_deletion_my_certificates()` (theo `app.current_auth_user()` = người đã yêu cầu xoá).
// - Kế hoạch purge `app.org_purge_plan()` (hằng): MỖI bảng có organization_id (+ organizations) đúng một hành động — `delete` (xoá hàng
//   của tổ chức, theo thứ tự con trước cha), `anonymize` (giữ hàng, bỏ dữ liệu cá nhân) hoặc `retain` (giữ kèm lý do). Test đối chiếu
//   catalog (org-deletion.db.test.ts) đỏ khi bảng mới chưa được xếp loại. GIỮ (D-116/D-117, D-125): chứng từ tiền + bảng làm căn cứ/được
//   chứng từ tham chiếu (FK RESTRICT) theo hạn kế toán 10 năm (RET-*), audit_events/support_grants (vết an ninh; audit tham chiếu grant),
//   thông báo lưu trú (nghĩa vụ Luật Cư trú). Phần giữ vẫn chịu job hạn giữ hiện có (ẩn danh người/inbox theo RET-*).
// - Hàm chỉ app_worker gọi (SECURITY DEFINER, đặt `app.org_id` cục bộ transaction):
//     · `app.org_deletion_due(p_now, p_limit)` — lô tổ chức tới hạn (≤ 100/lượt; mỗi tổ chức purge trong MỘT transaction riêng).
//     · `app.org_purge_kept_object_keys(p_org)` — khoá object PHẢI GIỮ (file được bảng giữ tham chiếu: ảnh công tơ, chứng từ chuyển khoản,
//       hồ sơ thông báo lưu trú). Worker liệt kê object theo tiền tố `<org>/` và xoá mọi object còn lại TRƯỚC khi gọi purge CSDL.
//     · `app.org_purge_execute(p_org, p_now, p_objects_deleted, p_objects_retained)` — chưa tới hạn/đã huỷ ⇒ NULL; đã purge ⇒ trả lại
//       chứng nhận cũ dạng `text` = đúng chuỗi đã băm (chạy lại idempotent); còn lại: xoá/ẩn danh theo kế hoạch, thu hồi mọi membership, ghi chứng nhận + audit
//       `organization.purged` trong cùng transaction.
//   app_runtime: `app.org_deletion_my_certificates()`.
//   Mốc của hai hàm trên bị chặn trên bởi đồng hồ CSDL (`least(p_now, now())`, như 0066/0067). Trigger guard bắt
//   `deletion_requested_at` mới ≈ now() (lệch < 60 giây) — owner không lùi ngày yêu cầu để purge ngay.
// - `app.check_last_owner` bỏ qua tổ chức đã purge (mọi membership bị thu hồi có chủ đích). Down khôi phục thân hàm cũ.
// - Down: gỡ hàm/bảng/cột (mất chứng nhận — chỉ dùng khi lùi ngay sau khi áp).
import { type Kysely, sql } from "kysely";

const NOT_SUPPORT = `((SELECT app.actor_role()) IS DISTINCT FROM 'platform_support')`;

/** Bảng có `files` mà purge GIỮ (FK RESTRICT tới files) — object của chúng được giữ trừ `import_batches` (chỉ giữ hàng, xoá nội dung). */
const KEPT_FILE_REFS = `
  SELECT x.new_photo_file_id FROM meter_events x WHERE x.organization_id = p_org
  UNION SELECT x.old_photo_file_id FROM meter_events x WHERE x.organization_id = p_org
  UNION SELECT x.photo_file_id FROM meter_readings x WHERE x.organization_id = p_org
  UNION SELECT x.proof_file_id FROM payment_claims x WHERE x.organization_id = p_org
  UNION SELECT x.evidence_file_id FROM residence_notices x WHERE x.organization_id = p_org
  UNION SELECT x.export_file_id FROM residence_notices x WHERE x.organization_id = p_org`;

const UP = `
ALTER TABLE organizations
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_due_at timestamptz,
  ADD COLUMN deletion_requested_by uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT ck_organizations_deletion CHECK (
    (deletion_requested_at IS NULL) = (deletion_due_at IS NULL)
    AND (deletion_requested_at IS NULL) = (deletion_requested_by IS NULL)
    AND (deletion_due_at IS NULL OR deletion_due_at = deletion_requested_at + interval '30 days')
    AND (deleted_at IS NULL OR (deletion_due_at IS NOT NULL AND deleted_at >= deletion_due_at)));
CREATE INDEX ix_organizations_deletion_due ON organizations (deletion_due_at)
  WHERE deletion_due_at IS NOT NULL AND deleted_at IS NULL;

CREATE FUNCTION app.organization_deletion_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user NOT IN ('app_runtime', 'app_worker') THEN
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'tổ chức % đã xoá', OLD.id USING ERRCODE = '55000', HINT = 'ORG_DELETED';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'chỉ job purge đặt deleted_at' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  IF (NEW.deletion_requested_at, NEW.deletion_due_at, NEW.deletion_requested_by)
       IS DISTINCT FROM (OLD.deletion_requested_at, OLD.deletion_due_at, OLD.deletion_requested_by)
     AND coalesce((SELECT app.actor_role()) <> 'owner', true) THEN
    RAISE EXCEPTION 'chỉ owner yêu cầu/huỷ xoá tổ chức' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  -- Mốc yêu cầu phải là "bây giờ" (lệch < 60 giây với giờ CSDL): owner không lùi ngày yêu cầu để purge ngay (bỏ qua 30 ngày ân hạn).
  IF NEW.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     AND abs(extract(epoch FROM (NEW.deletion_requested_at - now()))) >= 60 THEN
    RAISE EXCEPTION 'thời điểm yêu cầu xoá phải là hiện tại' USING ERRCODE = '22007', HINT = 'INVALID_DELETION_TIME';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_organizations_deletion_guard BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.organization_deletion_guard();

CREATE OR REPLACE FUNCTION app.check_last_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
BEGIN
  -- T-2312: tổ chức đã purge — mọi membership bị thu hồi có chủ đích.
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = org AND o.deleted_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = org AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'tổ chức % không còn owner active', org USING ERRCODE = '23514', HINT = 'LAST_OWNER';
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE org_deletion_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  purged_at timestamptz NOT NULL,
  content text NOT NULL CHECK (length(content) <= 65536 AND jsonb_typeof(content::jsonb) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_org_deletion_certificates_org UNIQUE (organization_id),
  CONSTRAINT ck_org_deletion_certificates_hash CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  CONSTRAINT ck_org_deletion_certificates_times CHECK (due_at > requested_at AND purged_at >= due_at)
);
CREATE INDEX ix_org_deletion_certificates_requested_by ON org_deletion_certificates (requested_by, purged_at DESC);
CREATE TRIGGER trg_org_deletion_certificates_append_only BEFORE UPDATE OR DELETE ON org_deletion_certificates
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_org_deletion_certificates_no_truncate BEFORE TRUNCATE ON org_deletion_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
ALTER TABLE org_deletion_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_deletion_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_deletion_certificates
  USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org());
CREATE POLICY support_read_only_insert ON org_deletion_certificates AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ${NOT_SUPPORT};
CREATE POLICY support_read_only_update ON org_deletion_certificates AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ${NOT_SUPPORT} WITH CHECK ${NOT_SUPPORT};
CREATE POLICY support_read_only_delete ON org_deletion_certificates AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ${NOT_SUPPORT};
REVOKE ALL ON org_deletion_certificates FROM PUBLIC;

-- Kế hoạch purge: mọi bảng có organization_id + organizations, đúng một hành động. Thứ tự (ord) của 'delete' = con trước cha.
CREATE FUNCTION app.org_purge_plan()
  RETURNS TABLE (ord integer, table_name text, action text, reason text)
  LANGUAGE sql IMMUTABLE AS $$
    VALUES
      (10, 'product_events', 'delete', NULL),
      (20, 'notification_deliveries', 'delete', NULL),
      (30, 'notifications', 'delete', NULL),
      (40, 'notification_preferences', 'delete', NULL),
      (50, 'notification_settings', 'delete', NULL),
      (60, 'guest_access_links', 'delete', NULL),
      (70, 'invitations', 'delete', NULL),
      (80, 'export_jobs', 'delete', NULL),
      (90, 'idempotency_keys', 'delete', NULL),
      (100, 'outbox', 'delete', NULL),
      (110, 'email_budget_days', 'delete', NULL),
      (120, 'exceptions', 'delete', NULL),
      (130, 'tasks', 'delete', NULL),
      (140, 'blocks', 'delete', NULL),
      (150, 'work_orders', 'delete', NULL),
      (160, 'identity_documents', 'delete', NULL),
      (170, 'property_scopes', 'delete', NULL),
      (180, 'rate_plans', 'delete', NULL),
      (190, 'service_prices', 'delete', NULL),
      (200, 'files', 'delete', 'files_referenced_by_retained_records_kept'),
      (300, 'organizations', 'anonymize', 'tombstone_for_retained_records'),
      (310, 'persons', 'anonymize', 'accounting_records_retention'),
      (320, 'memberships', 'anonymize', 'referenced_by_retained_records'),
      (330, 'import_rows', 'anonymize', 'import_trail_raw_removed'),
      (400, 'invoices', 'retain', 'accounting_records_retention'),
      (401, 'invoice_lines', 'retain', 'accounting_records_retention'),
      (402, 'payments', 'retain', 'accounting_records_retention'),
      (403, 'payment_allocations', 'retain', 'accounting_records_retention'),
      (404, 'payment_claims', 'retain', 'accounting_records_retention'),
      (405, 'deposits', 'retain', 'accounting_records_retention'),
      (406, 'journal_entries', 'retain', 'accounting_records_retention'),
      (407, 'journal_lines', 'retain', 'accounting_records_retention'),
      (408, 'charges', 'retain', 'accounting_records_retention'),
      (409, 'billing_periods', 'retain', 'accounting_records_retention'),
      (410, 'period_locks', 'retain', 'accounting_records_retention'),
      (411, 'bank_transactions', 'retain', 'accounting_records_retention'),
      (412, 'inbox', 'retain', 'accounting_records_retention'),
      (413, 'receiving_accounts', 'retain', 'accounting_records_retention'),
      (414, 'reconciliation_breaks', 'retain', 'accounting_records_retention'),
      (415, 'shifts', 'retain', 'accounting_records_retention'),
      (416, 'shift_discrepancies', 'retain', 'accounting_records_retention'),
      (417, 'lease_settlements', 'retain', 'accounting_records_retention'),
      (418, 'approval_requests', 'retain', 'accounting_records_retention'),
      (419, 'meters', 'retain', 'accounting_records_retention'),
      (420, 'meter_readings', 'retain', 'accounting_records_retention'),
      (421, 'meter_events', 'retain', 'accounting_records_retention'),
      (422, 'handovers', 'retain', 'accounting_records_retention'),
      (423, 'services', 'retain', 'accounting_records_retention'),
      (430, 'leases', 'retain', 'referenced_by_retained_records'),
      (431, 'lease_versions', 'retain', 'referenced_by_retained_records'),
      (432, 'lease_occupants', 'retain', 'referenced_by_retained_records'),
      (433, 'reservations', 'retain', 'referenced_by_retained_records'),
      (434, 'reservation_items', 'retain', 'referenced_by_retained_records'),
      (435, 'allocations', 'retain', 'referenced_by_retained_records'),
      (436, 'stays', 'retain', 'referenced_by_retained_records'),
      (437, 'properties', 'retain', 'referenced_by_retained_records'),
      (438, 'floors', 'retain', 'referenced_by_retained_records'),
      (439, 'room_types', 'retain', 'referenced_by_retained_records'),
      (440, 'units', 'retain', 'referenced_by_retained_records'),
      (441, 'import_batches', 'retain', 'referenced_by_retained_records'),
      (442, 'import_external_refs', 'retain', 'referenced_by_retained_records'),
      (450, 'residence_notices', 'retain', 'legal_residence_notice_record'),
      (460, 'audit_events', 'retain', 'security_audit_trail'),
      (461, 'support_grants', 'retain', 'security_audit_trail'),
      (470, 'org_deletion_certificates', 'retain', 'deletion_certificate')
  $$;

CREATE FUNCTION app.org_deletion_due(p_now timestamptz, p_limit integer)
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.id FROM organizations o
    WHERE o.deletion_due_at IS NOT NULL AND o.deleted_at IS NULL AND o.deletion_due_at <= least(p_now, now())
    ORDER BY o.deletion_due_at, o.id
    LIMIT least(greatest(p_limit, 1), 100)
  $$;

CREATE FUNCTION app.org_purge_kept_object_keys(p_org uuid)
  RETURNS TABLE (storage_key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('app.org_id', p_org::text, true);
  RETURN QUERY
    SELECT f.storage_key FROM files f
    WHERE f.organization_id = p_org AND f.id IN (${KEPT_FILE_REFS})
    ORDER BY f.storage_key;
END $$;

CREATE FUNCTION app.org_purge_execute(p_org uuid, p_now timestamptz, p_objects_deleted integer, p_objects_retained integer)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o organizations%ROWTYPE;
  r record;
  n integer;
  v_erased jsonb := '{}'::jsonb;
  v_retained jsonb := '[]'::jsonb;
  v_persons_anon integer;
  v_persons_kept integer;
  v_members integer;
  v_import_rows integer;
  v_content text;
  v_cert uuid := gen_random_uuid();
  -- Mốc bị chặn trên bởi đồng hồ CSDL (như 0066/0067): p_now tương lai không làm tổ chức "tới hạn" sớm.
  v_now timestamptz := least(p_now, now());
BEGIN
  PERFORM set_config('app.org_id', p_org::text, true);
  SELECT * INTO o FROM organizations WHERE id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF o.deleted_at IS NOT NULL THEN
    RETURN (SELECT c.content FROM org_deletion_certificates c WHERE c.organization_id = p_org);
  END IF;
  IF o.deletion_due_at IS NULL OR o.deletion_due_at > v_now THEN
    RETURN NULL;
  END IF;

  -- Đánh dấu đã purge TRƯỚC (check_last_owner bỏ qua tổ chức đã purge); tên → giá trị không định danh.
  UPDATE organizations SET deleted_at = v_now, name = '—', settings = '{}'::jsonb, version = version + 1 WHERE id = p_org;

  FOR r IN SELECT p.table_name FROM app.org_purge_plan() p WHERE p.action = 'delete' AND p.table_name <> 'files' ORDER BY p.ord LOOP
    EXECUTE format('DELETE FROM %I WHERE organization_id = $1', r.table_name) USING p_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_erased := v_erased || jsonb_build_object(r.table_name, n);
  END LOOP;
  DELETE FROM files f WHERE f.organization_id = p_org
    AND f.id NOT IN (SELECT z FROM (${KEPT_FILE_REFS} UNION SELECT x.file_id FROM import_batches x WHERE x.organization_id = p_org) AS k(z)
                     WHERE z IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_erased := v_erased || jsonb_build_object('files', n, 'objects', greatest(coalesce(p_objects_deleted, 0), 0));

  SET CONSTRAINTS public.trg_memberships_last_owner IMMEDIATE;
  UPDATE memberships m SET status = 'revoked', revoked_at = coalesce(m.revoked_at, v_now), version = m.version + 1
  WHERE m.organization_id = p_org AND m.status <> 'revoked';
  GET DIAGNOSTICS v_members = ROW_COUNT;

  -- Người gắn chứng từ tiền/lưu trú/hợp đồng: giữ họ tên (đối chiếu chứng từ), bỏ liên lạc; còn lại ẩn danh hẳn.
  WITH cls AS (
    SELECT p.id,
      ((SELECT st.last_end IS NOT NULL OR st.open FROM app.retention_stay_lease_state(p_org, p.id) st)
       OR EXISTS (SELECT 1 FROM invoices x WHERE x.organization_id = p_org AND x.payer_person_id = p.id)
       OR EXISTS (SELECT 1 FROM payments x WHERE x.organization_id = p_org AND x.payer_person_id = p.id)
       OR EXISTS (SELECT 1 FROM deposits x WHERE x.organization_id = p_org AND x.payer_person_id = p.id)
       OR EXISTS (SELECT 1 FROM payment_claims x WHERE x.organization_id = p_org AND x.person_id = p.id)
       OR EXISTS (SELECT 1 FROM journal_lines x WHERE x.organization_id = p_org AND x.person_id = p.id)) AS keep
    FROM persons p WHERE p.organization_id = p_org AND p.anonymized_at IS NULL
  ), upd AS (
    UPDATE persons p
    SET full_name = CASE WHEN c.keep THEN p.full_name ELSE '—' END,
        nationality = CASE WHEN c.keep THEN p.nationality ELSE NULL END,
        anonymized_at = CASE WHEN c.keep THEN NULL ELSE v_now END,
        phone = NULL, email = NULL, address = NULL, version = p.version + 1
    FROM cls c WHERE p.organization_id = p_org AND p.id = c.id
    RETURNING c.keep
  )
  SELECT count(*) FILTER (WHERE NOT keep)::int, count(*) FILTER (WHERE keep)::int INTO v_persons_anon, v_persons_kept FROM upd;

  UPDATE import_rows x SET raw = '{}'::jsonb, data = NULL
  WHERE x.organization_id = p_org AND (x.raw <> '{}'::jsonb OR x.data IS NOT NULL);
  GET DIAGNOSTICS v_import_rows = ROW_COUNT;

  v_erased := v_erased || jsonb_build_object('persons_anonymized', v_persons_anon, 'persons_contacts_removed', v_persons_kept,
                                             'memberships_revoked', v_members, 'import_rows_raw_removed', v_import_rows,
                                             'organization_name', 1);

  FOR r IN SELECT p.table_name, p.reason FROM app.org_purge_plan() p
           WHERE p.action IN ('retain', 'anonymize') AND p.table_name NOT IN ('organizations', 'org_deletion_certificates')
           ORDER BY p.ord LOOP
    EXECUTE format('SELECT count(*)::int FROM %I WHERE organization_id = $1', r.table_name) INTO n USING p_org;
    IF n > 0 THEN
      v_retained := v_retained || jsonb_build_array(jsonb_build_object('store', r.table_name, 'rows', n, 'reason', r.reason));
    END IF;
  END LOOP;
  v_retained := v_retained || jsonb_build_array(
    jsonb_build_object('store', 'organizations', 'rows', 1, 'reason', 'tombstone_for_retained_records'),
    jsonb_build_object('store', 'objects', 'rows', greatest(coalesce(p_objects_retained, 0), 0),
                       'reason', 'files_referenced_by_retained_records_kept'));

  v_content := jsonb_build_object(
    'certificate_id', v_cert,
    'certificate_version', 1,
    'organization_id', p_org,
    'requested_at', o.deletion_requested_at,
    'due_at', o.deletion_due_at,
    'purged_at', v_now,
    'erased', v_erased,
    'retained', v_retained,
    'outside_repo', jsonb_build_array(
      jsonb_build_object('store', 'backups', 'reason', 'expires_per_RET_10'),
      jsonb_build_object('store', 'logs', 'reason', 'no_personal_data_logged_expires_per_retention_policy')))::text;

  INSERT INTO org_deletion_certificates (id, organization_id, requested_by, requested_at, due_at, purged_at, content, content_sha256)
  VALUES (v_cert, p_org, o.deletion_requested_by, o.deletion_requested_at, o.deletion_due_at, v_now, v_content,
          encode(sha256(convert_to(v_content, 'UTF8')), 'hex'));

  INSERT INTO audit_events (id, organization_id, actor_type, action, entity_type, entity_id, correlation_id, after)
  VALUES (gen_random_uuid(), p_org, 'worker', 'organization.purged', 'organization', p_org, 'org-purge:' || p_org::text,
          jsonb_build_object('certificate_id', v_cert, 'content_sha256', encode(sha256(convert_to(v_content, 'UTF8')), 'hex')));

  RETURN v_content;
END $$;

CREATE FUNCTION app.org_deletion_my_certificates()
  RETURNS TABLE (id uuid, organization_id uuid, requested_at timestamptz, due_at timestamptz, purged_at timestamptz,
                 content text, content_sha256 text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.id, c.organization_id, c.requested_at, c.due_at, c.purged_at, c.content, c.content_sha256
    FROM org_deletion_certificates c
    WHERE app.current_auth_user() IS NOT NULL AND c.requested_by = app.current_auth_user()
    ORDER BY c.purged_at DESC, c.id
    LIMIT 50
  $$;

REVOKE ALL ON FUNCTION app.org_purge_plan(), app.org_deletion_due(timestamptz, integer), app.org_purge_kept_object_keys(uuid),
  app.org_purge_execute(uuid, timestamptz, integer, integer), app.org_deletion_my_certificates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.org_purge_plan(), app.org_deletion_due(timestamptz, integer), app.org_purge_kept_object_keys(uuid),
  app.org_purge_execute(uuid, timestamptz, integer, integer) TO app_worker;
GRANT EXECUTE ON FUNCTION app.org_deletion_my_certificates() TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.org_deletion_my_certificates();
DROP FUNCTION IF EXISTS app.org_purge_execute(uuid, timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.org_purge_kept_object_keys(uuid);
DROP FUNCTION IF EXISTS app.org_deletion_due(timestamptz, integer);
DROP FUNCTION IF EXISTS app.org_purge_plan();
DROP TABLE IF EXISTS org_deletion_certificates;
CREATE OR REPLACE FUNCTION app.check_last_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = org AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'tổ chức % không còn owner active', org USING ERRCODE = '23514', HINT = 'LAST_OWNER';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_organizations_deletion_guard ON organizations;
DROP FUNCTION IF EXISTS app.organization_deletion_guard();
DROP INDEX IF EXISTS ix_organizations_deletion_due;
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS ck_organizations_deletion,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS deletion_requested_by,
  DROP COLUMN IF EXISTS deletion_due_at,
  DROP COLUMN IF EXISTS deletion_requested_at;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
