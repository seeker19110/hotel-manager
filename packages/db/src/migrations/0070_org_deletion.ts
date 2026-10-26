// PLAN T-2312 (IND-SAAS-006, UX-CONTENT-005; D-125) — vòng đời xoá TỔ CHỨC: yêu cầu → giữ 30 ngày (xuất được, huỷ được) → purge
// mọi bảng theo tổ chức + object kho file → chứng nhận xoá.
// - `organizations`: thêm trạng thái `pending_deletion` + `deletion_requested_at`, `deletion_due_at`, `deletion_requested_by` (id
//   `auth."user"` của owner yêu cầu, không FK — tài khoản có thể bị ẩn danh sau đó). CHECK: chờ xoá ⇔ đủ ba cột; hạn ≥ yêu cầu + 30
//   ngày (CSDL giữ thời hạn, không tin ứng dụng). Chỉ hai hàm SECURITY DEFINER đổi trạng thái (`app.org_request_deletion`,
//   `app.org_cancel_deletion`): `app_runtime` có UPDATE cả bảng (0001, cần cho `settings`) nên trigger BEFORE UPDATE
//   `trg_organizations_lifecycle_guard` chặn đổi `status` và ba cột `deletion_*` khi `current_user` KHÔNG phải role sở hữu bảng
//   (tức không chạy trong hàm definer) — không thì app_runtime tự đặt `pending_deletion` với mốc quá khứ (tới hạn purge ngay) hoặc
//   huỷ yêu cầu không qua owner. Không REVOKE UPDATE rồi cấp theo cột: danh sách cột phải theo kịp mọi cột mới của bảng.
// - Chặn truy cập khi chờ xoá: ở `resolveActor` (packages/app/src/access/actor.ts) — điểm uỷ quyền MỌI request có ngữ cảnh tổ chức
//   (trang, command, query, tải file, export kiểm lại người yêu cầu) — trừ đường được phép rõ ràng (xuất dữ liệu, trạng thái/huỷ
//   yêu cầu). `app.list_my_organizations` vẫn liệt kê tổ chức chờ xoá để owner vào huỷ/xuất (chọn xong thì mọi trang khác bị chặn).
// - `app.purge_organization(org)` (app_worker; SECURITY DEFINER do owner migration sở hữu; search_path + TimeZone cố định): CHỈ tổ chức
//   còn `pending_deletion` và `deletion_due_at <= now()` (đồng hồ CSDL, không nhận mốc từ người gọi). Khoá hàng tổ chức FOR UPDATE
//   (chặn huỷ/ghi đồng thời — FK của hàng mới cần khoá KEY SHARE), xoá MỌI bảng có `organization_id` theo thứ tự FK (danh sách
//   tường minh `PURGE_ORDER` bên dưới; test DB so khớp catalog nên bảng mới không bị sót), đếm hàng mỗi bảng, xoá hàng tổ chức, ghi
//   `org_deletion_certificates`. Cặp `inbox`↔`bank_transactions` (FK vòng, RESTRICT) xoá trong MỘT câu lệnh; `blocks`↔`work_orders`
//   là FK DEFERRABLE. Object kho file: dọn HAI PHA như DSAR — worker lấy khoá (`app.org_purge_file_keys`), xoá object TRƯỚC, rồi mới
//   gọi purge với DANH SÁCH khoá đã xoá (lỗi kho ⇒ không purge, lượt sau thử lại; không để object mồ côi). Trong purge, sau khi khoá
//   hàng tổ chức, còn hàng `files` nào KHÔNG nằm trong danh sách (file mới — vd bản xuất — ghi giữa lúc liệt kê và lúc purge) ⇒
//   trả `{skipped: 'new_files'}`, không xoá gì, lượt sau làm lại; `objects_deleted` của chứng nhận = số object đã thực xoá. Mọi khoá object của tổ chức có tiền tố `<org>/`
//   (ck_files_key_prefix) — gồm file bản xuất (`export_jobs.file_key` trỏ cùng khoá `files`).
// - Lối vượt trigger append-only/bất biến (audit_events, journal_*, invoices, payments, leases… — mọi trigger chặn DELETE trên bảng
//   theo tổ chức): `app.org_purge_active(org)` đúng KHI VÀ CHỈ KHI (1) GUC `app.purge_org` = org, (2) `current_user` là role SỞ HỮU
//   `app.purge_organization` (tức đang chạy bên trong hàm definer — app_runtime/app_worker tự đặt GUC vẫn là chính họ), (3) tổ chức
//   đang chờ xoá và đã tới hạn. Trigger hàng kiểm `OLD.organization_id`; trigger câu lệnh (`*_no_delete`, BEFORE DELETE FOR EACH
//   STATEMENT) không có hàng nên kiểm theo GUC — vẫn cần (2)+(3). TRUNCATE vẫn bị chặn tuyệt đối. `consent_records` (theo tài khoản,
//   không `organization_id`) không bao giờ qua được. Các hàm trigger khác (charge_guard, handover_guard, import_*_guard,
//   lease_*_guard, meter_reading_*_guard, check_last_owner) được chèn MỘT dòng kiểm ở đầu thân (`PURGE_GUARD_LINE`) bằng cách viết
//   lại định nghĩa hiện có (`pg_get_functiondef`) — DOWN gỡ đúng dòng đó.
// - `org_deletion_certificates`: KHÔNG theo tổ chức (ngoại lệ IND-SAAS-001 ở schema-guards.no-org.json; cột là
//   `deleted_organization_id` — tổ chức không còn), không lưu tên tổ chức (băm tên ngắn đoán được bằng từ điển ⇒ bỏ hẳn). counts
//   jsonb {bảng: số hàng}, `digest` = SHA-256 hex của `deleted_organization_id|purged_at(UTC ISO, micro giây)|counts::text`. RLS
//   theo người dùng (`requested_by = app.current_user_id()`, khuôn 0068/0069): chỉ người yêu cầu đọc; append-only (trigger
//   forbid_mutation). Còn lại sau khi tài khoản bị xoá theo DSAR (id giữ nguyên, không PII).
// - `app.org_purge_due(now, limit)` (app_worker): tổ chức tới hạn (least(p_now, now()) — đồng hồ người gọi không kéo hạn sớm hơn
//   CSDL). `app.org_deletion_metrics(now)` (app_runtime, app_worker): gauge `hm_org_pending_deletion{state=waiting|due}`.
// - Down: xoá hàm/bảng/cột mới, khôi phục trigger + `list_my_organizations`; tổ chức đang chờ xoá trở về `active` (mất yêu cầu —
//   chỉ dùng khi lùi bản trước khi có người dùng thật). Tổ chức đã purge KHÔNG khôi phục được (đúng ý nghĩa của xoá).
import { type Kysely, sql } from "kysely";

/** Thứ tự xoá (bảng tham chiếu trước bảng được tham chiếu). Test `org-deletion.db.test.ts` so khớp với catalog. */
export const PURGE_ORDER: readonly string[] = [
  "audit_events",
  "blocks",
  "email_budget_days",
  "exceptions",
  "export_jobs",
  "guest_access_links",
  "idempotency_keys",
  "identity_documents",
  "import_external_refs",
  "import_rows",
  "invitations",
  "journal_lines",
  "lease_occupants",
  "lease_settlements",
  "meter_events",
  "meter_readings",
  "notification_deliveries",
  "notification_preferences",
  "notification_settings",
  "outbox",
  "payment_allocations",
  "payment_claims",
  "period_locks",
  "product_events",
  "property_scopes",
  "rate_plans",
  "reconciliation_breaks",
  "residence_notices",
  "service_prices",
  "shift_discrepancies",
  "tasks",
  "work_orders",
  "handovers",
  "import_batches",
  "invoice_lines",
  "journal_entries",
  "meters",
  "notifications",
  "payments",
  "charges",
  "deposits",
  "files",
  "inbox+bank_transactions",
  "invoices",
  "shifts",
  "billing_periods",
  "lease_versions",
  "receiving_accounts",
  "services",
  "stays",
  "approval_requests",
  "leases",
  "reservation_items",
  "allocations",
  "reservations",
  "memberships",
  "units",
  "floors",
  "persons",
  "room_types",
  "properties",
];

/** Hàm trigger (ngoài forbid_mutation) chặn/kiểm DELETE trên bảng theo tổ chức — được chèn `PURGE_GUARD_LINE`. */
export const PURGE_GUARDED_TRIGGER_FUNCTIONS: readonly string[] = [
  "app.charge_guard()",
  "app.handover_guard()",
  "app.import_batch_guard()",
  "app.import_row_guard()",
  "app.lease_settlement_guard()",
  "app.lease_version_guard()",
  "app.check_last_owner()",
  "app.handover_reading_guard()",
  "app.meter_reading_period_guard()",
];

/** Dòng chèn vào `app.forbid_mutation` (trigger hàng VÀ câu lệnh; bảng không có organization_id như consent_records ⇒ NULL ⇒ chặn). */
export const FORBID_GUARD_LINE =
  "IF TG_OP = 'DELETE' AND app.org_purge_active(CASE WHEN TG_LEVEL = 'ROW' THEN (to_jsonb(OLD) ->> 'organization_id')::uuid " +
  "ELSE nullif(current_setting('app.purge_org', true), '')::uuid END) THEN IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF; " +
  "RETURN NULL; END IF; -- org purge (0070)";

export const PURGE_GUARD_LINE =
  "IF TG_OP = 'DELETE' AND app.org_purge_active(OLD.organization_id) THEN RETURN OLD; END IF; -- org purge (0070)";

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const sqlText = (x: string) => `'${x.replaceAll("'", "''")}'`;
/** Viết lại định nghĩa hàm hiện có, chèn `line` ngay sau BEGIN đầu tiên (bỏ qua nếu đã có). */
const injectGuards = (fns: string, line: string) => `
DO $do$
DECLARE
  f text;
  def text;
BEGIN
  FOREACH f IN ARRAY ARRAY[${fns}] LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position('app.org_purge_active' IN def) > 0 THEN
      CONTINUE;
    END IF;
    def := regexp_replace(def, '\\mBEGIN\\M', 'BEGIN' || chr(10) || '  ' || ${sqlText(line)}, '');
    EXECUTE def;
  END LOOP;
END $do$;`;
/** Gỡ đúng dòng đã chèn. */
const removeGuards = (fns: string, line: string) => `
DO $do$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[${fns}] LOOP
    EXECUTE replace(pg_get_functiondef(f::regprocedure), 'BEGIN' || chr(10) || '  ' || ${sqlText(line)}, 'BEGIN');
  END LOOP;
END $do$;`;

const UP = `
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('active', 'suspended', 'pending_deletion'));
ALTER TABLE organizations
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_due_at timestamptz,
  ADD COLUMN deletion_requested_by uuid;
ALTER TABLE organizations ADD CONSTRAINT ck_organizations_deletion CHECK (
  ((status = 'pending_deletion')
     = (deletion_requested_at IS NOT NULL AND deletion_due_at IS NOT NULL AND deletion_requested_by IS NOT NULL))
  AND (deletion_requested_at IS NOT NULL OR (deletion_due_at IS NULL AND deletion_requested_by IS NULL))
  AND (deletion_due_at IS NULL OR deletion_due_at >= deletion_requested_at + interval '30 days'));
CREATE INDEX ix_organizations_deletion_due ON organizations (deletion_due_at) WHERE status = 'pending_deletion';

CREATE FUNCTION app.organizations_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.status, NEW.deletion_requested_at, NEW.deletion_due_at, NEW.deletion_requested_by)
       IS DISTINCT FROM (OLD.status, OLD.deletion_requested_at, OLD.deletion_due_at, OLD.deletion_requested_by)
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.status/deletion_* change only via app.org_request_deletion/app.org_cancel_deletion'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.organizations_lifecycle_guard() FROM PUBLIC;
CREATE TRIGGER trg_organizations_lifecycle_guard BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.organizations_lifecycle_guard();

CREATE OR REPLACE FUNCTION app.list_my_organizations(p_auth_user_id uuid)
  RETURNS TABLE(organization_id uuid, organization_name text, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
    SELECT o.id, o.name, m.id, m.role
    FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.auth_user_id = p_auth_user_id AND m.status = 'active' AND o.status IN ('active', 'pending_deletion')
      AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
    ORDER BY o.name
  $$;

CREATE TABLE org_deletion_certificates (
  id uuid PRIMARY KEY,
  deleted_organization_id uuid NOT NULL UNIQUE,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  purged_at timestamptz NOT NULL,
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  total_rows bigint NOT NULL CHECK (total_rows >= 1),
  objects_deleted integer NOT NULL CHECK (objects_deleted >= 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_org_deletion_certificates_time CHECK (requested_at <= due_at AND due_at <= purged_at)
);
CREATE INDEX ix_org_deletion_certificates_requester ON org_deletion_certificates (requested_by, purged_at);
ALTER TABLE org_deletion_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_deletion_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY org_deletion_certificates_self_read ON org_deletion_certificates FOR SELECT
  USING (requested_by = app.current_user_id());
REVOKE ALL ON org_deletion_certificates FROM PUBLIC;
GRANT SELECT ON org_deletion_certificates TO app_runtime;
CREATE TRIGGER trg_org_deletion_certificates_append_only BEFORE UPDATE OR DELETE ON org_deletion_certificates
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_org_deletion_certificates_no_truncate BEFORE TRUNCATE ON org_deletion_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE FUNCTION app.purge_organization(p_org uuid, p_deleted_keys text[]) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
BEGIN
  RETURN NULL; -- placeholder: real body below (org_purge_active references this function's owner)
END $$;

CREATE FUNCTION app.org_purge_active(p_org uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v text := current_setting('app.purge_org', true);
BEGIN
  IF p_org IS NULL OR v IS NULL OR v <> p_org::text THEN
    RETURN false;
  END IF;
  -- Executing role must own the purge function (i.e. we are inside the SECURITY DEFINER body); a caller-set GUC is not enough.
  IF current_user <> (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
                       WHERE p.oid = 'app.purge_organization(uuid, text[])'::regprocedure) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = p_org AND o.status = 'pending_deletion' AND o.deletion_due_at <= now());
END $$;

${injectGuards(sqlList(PURGE_GUARDED_TRIGGER_FUNCTIONS), PURGE_GUARD_LINE)}
${injectGuards("'app.forbid_mutation()'", FORBID_GUARD_LINE)}

CREATE OR REPLACE FUNCTION app.purge_organization(p_org uuid, p_deleted_keys text[]) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_order text[] := ARRAY[${sqlList(PURGE_ORDER)}];
  v_org organizations%ROWTYPE;
  v_t text;
  n bigint;
  n2 bigint;
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_objects integer;
  v_now timestamptz := now();
  v_digest text;
  v_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_org FROM organizations o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND OR v_org.status <> 'pending_deletion' OR v_org.deletion_due_at > now() THEN
    RETURN NULL;
  END IF;
  -- Objects are deleted by the worker BEFORE this call; a file row it did not delete (written after it listed keys) ⇒ skip, retry.
  IF EXISTS (SELECT 1 FROM files f
              WHERE f.organization_id = p_org AND NOT (f.storage_key = ANY (coalesce(p_deleted_keys, '{}'::text[])))) THEN
    RETURN jsonb_build_object('skipped', 'new_files');
  END IF;
  SELECT count(*)::int INTO v_objects FROM files f WHERE f.organization_id = p_org;
  PERFORM set_config('app.org_id', p_org::text, true);
  PERFORM set_config('app.purge_org', p_org::text, true);
  -- Deferred last-owner check must fire HERE (definer rights, bypass active), not at COMMIT as app_worker.
  SET CONSTRAINTS trg_memberships_last_owner IMMEDIATE;
  FOREACH v_t IN ARRAY v_order LOOP
    IF v_t = 'inbox+bank_transactions' THEN
      -- RESTRICT FK cycle: both DELETEs in ONE statement; RI checks run at statement end when both sides are gone.
      WITH a AS (DELETE FROM inbox x WHERE x.organization_id = p_org RETURNING 1),
           b AS (DELETE FROM bank_transactions x WHERE x.organization_id = p_org RETURNING 1)
      SELECT (SELECT count(*) FROM a), (SELECT count(*) FROM b) INTO n, n2;
      v_counts := v_counts || jsonb_build_object('inbox', n, 'bank_transactions', n2);
      v_total := v_total + n + n2;
    ELSE
      EXECUTE format('DELETE FROM %I WHERE organization_id = $1', v_t) USING p_org;
      GET DIAGNOSTICS n = ROW_COUNT;
      v_counts := v_counts || jsonb_build_object(v_t, n);
      v_total := v_total + n;
    END IF;
  END LOOP;
  DELETE FROM organizations o WHERE o.id = p_org;
  v_counts := v_counts || jsonb_build_object('organizations', 1);
  v_total := v_total + 1;
  PERFORM set_config('app.purge_org', '', true);
  v_digest := encode(sha256(convert_to(
    p_org::text || '|' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || v_counts::text, 'UTF8')), 'hex');
  INSERT INTO org_deletion_certificates
    (id, deleted_organization_id, requested_by, requested_at, due_at, purged_at, counts, total_rows, objects_deleted, digest)
  VALUES (v_id, p_org, v_org.deletion_requested_by, v_org.deletion_requested_at, v_org.deletion_due_at, v_now, v_counts,
          v_total, v_objects, v_digest);
  RETURN jsonb_build_object('certificate_id', v_id, 'total_rows', v_total, 'objects_deleted', v_objects,
                            'counts', v_counts, 'digest', v_digest);
END $$;

CREATE FUNCTION app.org_purge_due(p_now timestamptz, p_limit integer) RETURNS TABLE (id uuid, due_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT o.id, o.deletion_due_at FROM organizations o
     WHERE o.status = 'pending_deletion' AND o.deletion_due_at <= least(p_now, now())
     ORDER BY o.deletion_due_at, o.id
     LIMIT least(greatest(p_limit, 1), 100)
  $$;

CREATE FUNCTION app.org_purge_file_keys(p_org uuid) RETURNS TABLE (storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT f.storage_key FROM files f
      JOIN organizations o ON o.id = f.organization_id
     WHERE f.organization_id = p_org AND o.status = 'pending_deletion' AND o.deletion_due_at <= now()
     ORDER BY f.storage_key
  $$;

CREATE FUNCTION app.org_request_deletion(p_correlation text)
  RETURNS TABLE (status text, requested_at timestamptz, due_at timestamptz, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_org uuid := app.current_org();
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_user uuid;
  v_person uuid;
  o organizations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM organizations x WHERE x.id = v_org FOR UPDATE;
  SELECT m.auth_user_id, m.person_id INTO v_user, v_person FROM memberships m
   WHERE m.organization_id = v_org AND m.id = v_actor AND m.role = 'owner' AND m.status = 'active'
     AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now());
  IF v_user IS NULL OR o.id IS NULL THEN
    RAISE EXCEPTION 'only an active owner may request organization deletion' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  IF o.status = 'pending_deletion' THEN
    RETURN QUERY SELECT o.status, o.deletion_requested_at, o.deletion_due_at, false;
    RETURN;
  END IF;
  IF o.status <> 'active' THEN
    RAISE EXCEPTION 'organization % is %', v_org, o.status USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  UPDATE organizations x
     SET status = 'pending_deletion', deletion_requested_at = now(), deletion_due_at = now() + interval '30 days',
         deletion_requested_by = v_user, version = x.version + 1
   WHERE x.id = v_org
  RETURNING * INTO o;
  INSERT INTO audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, after, correlation_id)
  VALUES (gen_random_uuid(), v_org, 'user', v_person, 'organization.deletion_requested', 'organization', v_org,
          jsonb_build_object('due_at', o.deletion_due_at), coalesce(nullif(p_correlation, ''), 'org-deletion'));
  RETURN QUERY SELECT o.status, o.deletion_requested_at, o.deletion_due_at, true;
END $$;

CREATE FUNCTION app.org_cancel_deletion(p_correlation text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_org uuid := app.current_org();
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_person uuid;
  o organizations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM organizations x WHERE x.id = v_org FOR UPDATE;
  SELECT m.person_id INTO v_person FROM memberships m
   WHERE m.organization_id = v_org AND m.id = v_actor AND m.role = 'owner' AND m.status = 'active'
     AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now());
  IF v_person IS NULL OR o.id IS NULL THEN
    RAISE EXCEPTION 'only an active owner may cancel organization deletion' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  IF o.status <> 'pending_deletion' THEN
    RETURN false;
  END IF;
  UPDATE organizations x
     SET status = 'active', deletion_requested_at = NULL, deletion_due_at = NULL, deletion_requested_by = NULL,
         version = x.version + 1
   WHERE x.id = v_org;
  INSERT INTO audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, entity_id, before, correlation_id)
  VALUES (gen_random_uuid(), v_org, 'user', v_person, 'organization.deletion_cancelled', 'organization', v_org,
          jsonb_build_object('due_at', o.deletion_due_at), coalesce(nullif(p_correlation, ''), 'org-deletion'));
  RETURN true;
END $$;

CREATE FUNCTION app.org_deletion_metrics(p_now timestamptz) RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT 'hm_org_pending_deletion'::text, jsonb_build_object('state', s.state),
           (SELECT count(*) FROM organizations o
             WHERE o.status = 'pending_deletion'
               AND (o.deletion_due_at <= p_now) = (s.state = 'due'))::double precision
      FROM (VALUES ('waiting'), ('due')) AS s(state)
  $$;

REVOKE ALL ON FUNCTION app.purge_organization(uuid, text[]), app.org_purge_due(timestamptz, integer), app.org_purge_file_keys(uuid),
  app.org_request_deletion(text), app.org_cancel_deletion(text), app.org_deletion_metrics(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_organization(uuid, text[]), app.org_purge_due(timestamptz, integer),
  app.org_purge_file_keys(uuid) TO app_worker;
GRANT EXECUTE ON FUNCTION app.org_request_deletion(text), app.org_cancel_deletion(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.org_deletion_metrics(timestamptz) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.org_deletion_metrics(timestamptz);
DROP FUNCTION IF EXISTS app.org_cancel_deletion(text);
DROP FUNCTION IF EXISTS app.org_request_deletion(text);
DROP FUNCTION IF EXISTS app.org_purge_file_keys(uuid);
DROP FUNCTION IF EXISTS app.org_purge_due(timestamptz, integer);
${removeGuards(sqlList(PURGE_GUARDED_TRIGGER_FUNCTIONS), PURGE_GUARD_LINE)}
${removeGuards("'app.forbid_mutation()'", FORBID_GUARD_LINE)}
DROP FUNCTION IF EXISTS app.org_purge_active(uuid);
DROP FUNCTION IF EXISTS app.purge_organization(uuid, text[]);
DROP TABLE IF EXISTS org_deletion_certificates;
CREATE OR REPLACE FUNCTION app.list_my_organizations(p_auth_user_id uuid)
  RETURNS TABLE(organization_id uuid, organization_name text, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
    SELECT o.id, o.name, m.id, m.role
    FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.auth_user_id = p_auth_user_id AND m.status = 'active' AND o.status = 'active'
      AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
    ORDER BY o.name
  $$;
DROP TRIGGER IF EXISTS trg_organizations_lifecycle_guard ON organizations;
DROP FUNCTION IF EXISTS app.organizations_lifecycle_guard();
DROP INDEX IF EXISTS ix_organizations_deletion_due;
UPDATE organizations
   SET status = 'active', deletion_requested_at = NULL, deletion_due_at = NULL, deletion_requested_by = NULL
 WHERE status = 'pending_deletion';
ALTER TABLE organizations DROP CONSTRAINT ck_organizations_deletion;
ALTER TABLE organizations DROP COLUMN deletion_requested_by, DROP COLUMN deletion_due_at, DROP COLUMN deletion_requested_at;
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text]));
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
