// PLAN T-2311 (STD-PRIV-004, CMP-VN-007, CMP-INTL-007, CMP-RIGHTS-007, CMP-PRIV-005; D-123) — quyền chủ thể theo TÀI KHOẢN:
// truy cập (xuất dữ liệu), xoá tài khoản, hạn chế xử lý.
// - `dsar_requests`: một hàng mỗi yêu cầu (loại access|delete|restrict, trạng thái received|verified|processing|completed|rejected,
//   vùng pháp lý, hạn `due_at` do ứng dụng tính từ `dsar_days` của vùng — packages/app/src/privacy/dsar-policy.ts, MỘT nơi). Theo tài
//   khoản như `consent_records` (0068): không `organization_id` (ngoại lệ IND-SAAS-001 ở schema-guards.no-org.json), `subject_user_id`
//   là id `auth."user"` KHÔNG khoá ngoại (ERD §4). Đóng (completed/rejected) ⇔ có `completed_at`. `result_summary` chỉ số đếm/mã lý do
//   (không PII); `legal_retention_note` = phần còn giữ + căn cứ (bắt buộc khi xoá xong). Gói truy cập nằm ở kho object riêng tư,
//   khoá `dsar/<subject_user_id>/<id>.json` (không theo tổ chức — người dùng có thể không thuộc tổ chức nào nên không dùng `files`),
//   có hạn tải `result_expires_at`; quá hạn thì worker xoá object rồi gỡ khoá (`app.dsar_due_results` → `app.dsar_clear_result`).
//   Mỗi tài khoản tối đa MỘT yêu cầu mở cùng loại (index unique một phần) — gửi lại trả yêu cầu đang mở (idempotent).
// - `processing_restrictions`: cờ hạn chế xử lý theo tài khoản (một hàng ⇔ đang hạn chế), trỏ tới yêu cầu restrict đã bật nó.
//   Bộ kiểm đồng ý analytics (privacy/consent.ts) trả TỪ CHỐI khi có cờ. Chưa có luồng gỡ cờ (không cấp DELETE).
// - RLS bật + FORCE theo ngữ cảnh NGƯỜI DÙNG `app.user_id` (`app.current_user_id()`, 0068): `app_runtime` chỉ SELECT/INSERT hàng của
//   chính mình; INSERT theo cột (không `requested_at`/`processing_started_at`/khoá gói/`updated_at`) và policy chỉ cho tạo yêu cầu
//   `verified` (access/delete — danh tính đã xác minh bằng phiên/xác thực lại ở server) hoặc restrict `completed` (bật cờ ngay trong
//   cùng transaction). Không UPDATE/DELETE cho `app_runtime`: mọi chuyển trạng thái sau đó đi qua hàm SECURITY DEFINER của worker.
// - Hàm SECURITY DEFINER (khuôn 0056/0066: `search_path` + `timezone = 'UTC'` cố định, REVOKE PUBLIC, grant hẹp):
//   `app.dsar_sole_owner_orgs()` (app_runtime; đọc `app.current_user_id()` — không nhận id người khác): số tổ chức mà người dùng là
//     owner active DUY NHẤT ⇒ chặn tạo yêu cầu xoá (LAST_OWNER) — chuyển quyền owner hoặc xoá tổ chức trước (T-2312).
//   `app.dsar_claim(now, stale_minutes, limit)` (app_worker): nhận yêu cầu access/delete `verified` (hoặc `processing` treo quá
//     `stale_minutes` — worker chết giữa chừng) theo `due_at` sớm nhất, FOR UPDATE SKIP LOCKED ⇒ nhiều worker không nhận trùng.
//   `app.dsar_export_data(request)` (app_worker): gói JSON dữ liệu của CHÍNH chủ thể (tài khoản, cách đăng nhập không kèm băm/token,
//     phiên, tư cách thành viên + hồ sơ người liên kết, đồng ý, yêu cầu quyền, cờ hạn chế, sự kiện analytics của mình) — một snapshot.
//   `app.dsar_complete_access(request, key, expires_at, summary)` (app_worker): chốt yêu cầu truy cập đang `processing` (false nếu đã
//     bị đóng — worker xoá object vừa ghi). Hạn tải bị chặn trên 7 ngày.
//   `app.dsar_erase_account(request, note)` (app_worker): xoá tài khoản theo D-123 trong MỘT transaction: khoá yêu cầu + tài khoản +
//     membership; còn là owner active duy nhất ⇒ `rejected` (last_owner). Ngược lại: thu hồi mọi phiên (để dấu `revoked_session` như
//     `revokeUserSessions` ⇒ cookie cũ nhận 401 SESSION_REVOKED), xoá `auth.account` (băm mật khẩu, token OAuth), `twoFactor`, mã
//     xác minh/OTP và bộ đếm khoá đăng nhập theo email; ẩn danh `auth."user"` (email ⇒ `deleted+<uuid ngẫu nhiên>@deleted.invalid`
//     — duy nhất, không định danh, miền .invalid RFC 2606; tên ⇒ "***"; ảnh NULL; giữ id); membership còn hiệu lực ⇒ `revoked`
//     (giữ hàng cho FK sổ tiền/audit; kiểm "còn owner" chạy NGAY — `SET CONSTRAINTS … IMMEDIATE`) + một `audit_events` mỗi tổ chức
//     (actor worker); `app.unlink_product_events_actor`; file bản xuất do chính tài khoản yêu cầu ⇒ `files.delete_after` = hôm nay
//     (job `import.retention` xoá object); gói truy cập cũ ⇒ hết hạn ngay (job DSAR xoá object); yêu cầu mở khác của người đó ⇒ `rejected` (account_deleted). GIỮ: hoá đơn/sổ tiền/audit_events/
//     `consent_records` (chỉ còn id bí danh) và `persons` (dữ liệu của cơ sở — bên kiểm soát; ẩn danh theo hạn lưu RET-17).
//   `app.dsar_due_results(now, limit)` + `app.dsar_clear_result(id, key)` (app_worker): hai pha dọn gói hết hạn — xoá object TRƯỚC,
//     gỡ khoá SAU (lỗi kho thì khoá còn, lượt sau thử lại; không để object mồ côi).
//   `app.dsar_metrics(now)` (app_runtime, app_worker): gauge `hm_dsar_overdue` = yêu cầu còn mở (received/verified/processing) quá
//     `due_at`, tổng toàn hệ thống, không nhãn.
// - Index: unique một phần yêu cầu mở theo (người, loại); (người, requested_at) cho danh sách; `due_at` (một phần: còn mở) cho
//   nhận việc + metric; `result_expires_at` (một phần: còn khoá gói) cho dọn; FK `processing_restrictions.request_id`. Bảng mới, rỗng.
// - Down: xoá hàm rồi bảng — mất lịch sử yêu cầu quyền và cờ hạn chế; chỉ dùng khi lùi bản chưa có người dùng thật (tài khoản đã
//   ẩn danh KHÔNG khôi phục được — đúng ý nghĩa của xoá).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE dsar_requests (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('access', 'delete', 'restrict')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'verified', 'processing', 'completed', 'rejected')),
  region text NOT NULL CHECK (region IN ('VN', 'EU', 'UK', 'CA', 'SG', 'TH')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  verified_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  result_summary jsonb CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
  legal_retention_note text CHECK (legal_retention_note IS NULL OR char_length(legal_retention_note) BETWEEN 1 AND 2000),
  result_file_key text,
  result_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_dsar_requests_due CHECK (due_at > requested_at),
  CONSTRAINT ck_dsar_requests_closed CHECK ((status IN ('completed', 'rejected')) = (completed_at IS NOT NULL)),
  CONSTRAINT ck_dsar_requests_verified CHECK (status IN ('received', 'rejected') OR verified_at IS NOT NULL),
  CONSTRAINT ck_dsar_requests_processing CHECK (status <> 'processing' OR processing_started_at IS NOT NULL),
  CONSTRAINT ck_dsar_requests_result CHECK (
    (result_file_key IS NULL) = (result_expires_at IS NULL)
    AND (result_file_key IS NULL
         OR (type = 'access' AND status = 'completed'
             AND result_file_key = 'dsar/' || subject_user_id::text || '/' || id::text || '.json'))),
  CONSTRAINT ck_dsar_requests_delete_note CHECK (type <> 'delete' OR status <> 'completed' OR legal_retention_note IS NOT NULL)
);
CREATE UNIQUE INDEX uq_dsar_requests_open ON dsar_requests (subject_user_id, type)
  WHERE status IN ('received', 'verified', 'processing');
CREATE INDEX ix_dsar_requests_subject_time ON dsar_requests (subject_user_id, requested_at);
CREATE INDEX ix_dsar_requests_due ON dsar_requests (due_at) WHERE status IN ('received', 'verified', 'processing');
CREATE INDEX ix_dsar_requests_result_expires ON dsar_requests (result_expires_at) WHERE result_file_key IS NOT NULL;

ALTER TABLE dsar_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dsar_requests_self_read ON dsar_requests FOR SELECT
  USING (subject_user_id = app.current_user_id());
CREATE POLICY dsar_requests_self_insert ON dsar_requests FOR INSERT
  WITH CHECK (subject_user_id = app.current_user_id()
              AND ((status = 'verified' AND type IN ('access', 'delete')) OR (status = 'completed' AND type = 'restrict')));
REVOKE ALL ON dsar_requests FROM PUBLIC;
GRANT SELECT ON dsar_requests TO app_runtime;
GRANT INSERT (id, subject_user_id, type, status, region, due_at, verified_at, completed_at, result_summary)
  ON dsar_requests TO app_runtime;

CREATE TABLE processing_restrictions (
  subject_user_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES dsar_requests (id) ON DELETE RESTRICT,
  restricted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_processing_restrictions_request ON processing_restrictions (request_id);
ALTER TABLE processing_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_restrictions FORCE ROW LEVEL SECURITY;
CREATE POLICY processing_restrictions_self_read ON processing_restrictions FOR SELECT
  USING (subject_user_id = app.current_user_id());
CREATE POLICY processing_restrictions_self_insert ON processing_restrictions FOR INSERT
  WITH CHECK (subject_user_id = app.current_user_id());
REVOKE ALL ON processing_restrictions FROM PUBLIC;
GRANT SELECT ON processing_restrictions TO app_runtime;
GRANT INSERT (subject_user_id, request_id) ON processing_restrictions TO app_runtime;

CREATE FUNCTION app.dsar_sole_owner_orgs() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT count(*)::int FROM memberships m
    WHERE m.auth_user_id = app.current_user_id() AND m.role = 'owner' AND m.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM memberships o
                      WHERE o.organization_id = m.organization_id AND o.role = 'owner' AND o.status = 'active'
                        AND o.id <> m.id)
  $$;

CREATE FUNCTION app.dsar_claim(p_now timestamptz, p_stale_minutes integer, p_limit integer)
  RETURNS TABLE (id uuid, subject_user_id uuid, type text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT r.id FROM dsar_requests r
      WHERE r.type IN ('access', 'delete')
        AND (r.status = 'verified'
             OR (r.status = 'processing'
                 AND r.processing_started_at < least(p_now, now()) - make_interval(mins => greatest(p_stale_minutes, 1))))
      ORDER BY r.due_at, r.id
      LIMIT least(greatest(p_limit, 1), 100)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE dsar_requests r SET status = 'processing', processing_started_at = now(), updated_at = now()
      FROM due WHERE r.id = due.id
    RETURNING r.id, r.subject_user_id, r.type
  $$;

CREATE FUNCTION app.dsar_export_data(p_request_id uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT r.subject_user_id INTO v_user FROM dsar_requests r
   WHERE r.id = p_request_id AND r.type = 'access' AND r.status = 'processing';
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'format', 'hm-dsar-access/1',
    'generated_at', now(),
    'request_id', p_request_id,
    'account', (
      SELECT jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'email_verified', u."emailVerified",
                                'two_factor_enabled', coalesce(u."twoFactorEnabled", false), 'image', u.image,
                                'created_at', u."createdAt", 'updated_at', u."updatedAt")
        FROM auth."user" u WHERE u.id = v_user),
    'sign_in_methods', coalesce((
      SELECT jsonb_agg(jsonb_build_object('provider', a."providerId", 'created_at', a."createdAt",
                                          'updated_at', a."updatedAt") ORDER BY a."createdAt", a.id)
        FROM auth.account a WHERE a."userId" = v_user), '[]'::jsonb),
    'sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('created_at', s."createdAt", 'expires_at', s."expiresAt",
                                          'ip_address', s."ipAddress", 'user_agent', s."userAgent")
                       ORDER BY s."createdAt", s.id)
        FROM auth."session" s WHERE s."userId" = v_user), '[]'::jsonb),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'organization_id', m.organization_id, 'organization_name', o.name, 'role', m.role,
               'status', m.status, 'valid_from', m.valid_from, 'valid_to', m.valid_to, 'revoked_at', m.revoked_at,
               'created_at', m.created_at,
               'person', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone,
                                            'address', p.address, 'nationality', p.nationality,
                                            'anonymized_at', p.anonymized_at))
             ORDER BY m.created_at, m.id)
        FROM memberships m
        JOIN organizations o ON o.id = m.organization_id
        JOIN persons p ON p.organization_id = m.organization_id AND p.id = m.person_id
       WHERE m.auth_user_id = v_user), '[]'::jsonb),
    'consent_records', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'purpose', c.purpose, 'action', c.action,
                                          'policy_version', c.policy_version, 'channel', c.channel,
                                          'ui_snapshot_hash', c.ui_snapshot_hash, 'recorded_at', c.recorded_at)
                       ORDER BY c.recorded_at, c.seq)
        FROM consent_records c WHERE c.subject_user_id = v_user), '[]'::jsonb),
    'data_requests', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'type', d.type, 'status', d.status, 'region', d.region,
                                          'requested_at', d.requested_at, 'due_at', d.due_at,
                                          'completed_at', d.completed_at)
                       ORDER BY d.requested_at, d.id)
        FROM dsar_requests d WHERE d.subject_user_id = v_user), '[]'::jsonb),
    'processing_restriction', (
      SELECT jsonb_build_object('restricted_at', x.restricted_at)
        FROM processing_restrictions x WHERE x.subject_user_id = v_user),
    'product_events', coalesce((
      SELECT jsonb_agg(jsonb_build_object('organization_id', e.organization_id, 'property_id', e.property_id,
                                          'name', e.name, 'schema_version', e.schema_version, 'props', e.props,
                                          'occurred_at', e.occurred_at) ORDER BY e.occurred_at, e.id)
        FROM product_events e WHERE e.actor_user_id = v_user), '[]'::jsonb)
  );
END $$;

CREATE FUNCTION app.dsar_complete_access(p_request_id uuid, p_key text, p_expires_at timestamptz, p_summary jsonb)
  RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    WITH x AS (
      UPDATE dsar_requests r
         SET status = 'completed', completed_at = now(), result_file_key = p_key,
             result_expires_at = least(greatest(p_expires_at, now() + interval '1 minute'), now() + interval '7 days'),
             result_summary = p_summary, updated_at = now()
       WHERE r.id = p_request_id AND r.type = 'access' AND r.status = 'processing'
      RETURNING 1)
    SELECT count(*) = 1 FROM x
  $$;

CREATE FUNCTION app.dsar_erase_account(p_request_id uuid, p_note text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_user uuid;
  v_email text;
  v_sole integer;
  n_sessions integer;
  n_accounts integer;
  n_mfa integer;
  n_members integer;
  n_events integer;
  n_files integer;
  v_summary jsonb;
BEGIN
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'dsar_erase_account: legal retention note is required' USING ERRCODE = '22023';
  END IF;
  SELECT r.subject_user_id INTO v_user FROM dsar_requests r
   WHERE r.id = p_request_id AND r.type = 'delete' AND r.status = 'processing'
   FOR UPDATE;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT u.email INTO v_email FROM auth."user" u WHERE u.id = v_user FOR UPDATE;
  PERFORM 1 FROM memberships m WHERE m.auth_user_id = v_user ORDER BY m.id FOR UPDATE;
  PERFORM 1 FROM dsar_requests r WHERE r.subject_user_id = v_user ORDER BY r.id FOR UPDATE;

  SELECT count(*)::int INTO v_sole FROM memberships m
   WHERE m.auth_user_id = v_user AND m.role = 'owner' AND m.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM memberships o
                     WHERE o.organization_id = m.organization_id AND o.role = 'owner' AND o.status = 'active'
                       AND o.id <> m.id);
  IF v_sole > 0 THEN
    UPDATE dsar_requests r
       SET status = 'rejected', completed_at = now(), updated_at = now(),
           result_summary = jsonb_build_object('reason', 'last_owner', 'organizations', v_sole)
     WHERE r.id = p_request_id;
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'last_owner', 'organizations', v_sole);
  END IF;

  INSERT INTO auth.revoked_session (token_hash, user_id, expires_at)
  SELECT sha256(convert_to(s.token, 'UTF8')), s."userId", s."expiresAt" FROM auth."session" s WHERE s."userId" = v_user
  ON CONFLICT (token_hash) DO NOTHING;
  DELETE FROM auth."session" s WHERE s."userId" = v_user;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  DELETE FROM auth.account a WHERE a."userId" = v_user;
  GET DIAGNOSTICS n_accounts = ROW_COUNT;
  DELETE FROM auth."twoFactor" f WHERE f."userId" = v_user;
  GET DIAGNOSTICS n_mfa = ROW_COUNT;
  DELETE FROM auth.verification v WHERE v.value = v_user::text;
  IF v_email IS NOT NULL THEN
    DELETE FROM auth.verification v
     WHERE lower(v.identifier) LIKE '%-otp-%'
       AND right(lower(v.identifier), char_length(v_email) + 5) = '-otp-' || lower(v_email);
    DELETE FROM auth.login_throttle t WHERE t.email_hash = sha256(convert_to(lower(btrim(v_email)), 'UTF8'));
  END IF;
  UPDATE auth."user" u
     SET email = 'deleted+' || gen_random_uuid()::text || '@deleted.invalid', name = '***', image = NULL,
         "emailVerified" = false, "twoFactorEnabled" = false, "updatedAt" = now()
   WHERE u.id = v_user;

  -- Deferred last-owner check must run here (definer rights); at COMMIT it would run as app_worker and hit memberships RLS.
  SET CONSTRAINTS trg_memberships_last_owner IMMEDIATE;
  WITH rev AS (
    UPDATE memberships m SET status = 'revoked', revoked_at = now(), version = m.version + 1
     WHERE m.auth_user_id = v_user AND m.status IN ('invited', 'active', 'suspended')
    RETURNING m.id, m.organization_id
  ), aud AS (
    INSERT INTO audit_events (id, organization_id, actor_type, action, entity_type, entity_id, reason, correlation_id)
    SELECT gen_random_uuid(), rev.organization_id, 'worker', 'member.account_deleted', 'membership', rev.id,
           'dsar_delete', 'dsar:' || p_request_id::text
      FROM rev
    RETURNING 1
  )
  SELECT count(*)::int INTO n_members FROM rev;

  n_events := app.unlink_product_events_actor(v_user);

  WITH mine AS (
    SELECT j.organization_id, j.id FROM export_jobs j
      JOIN memberships m ON m.organization_id = j.organization_id AND m.id = j.requested_by
     WHERE m.auth_user_id = v_user
  ), upd AS (
    UPDATE files f
       SET delete_after = (now() AT TIME ZONE 'UTC')::date
      FROM mine
     WHERE f.organization_id = mine.organization_id AND f.owner_type = 'export_job' AND f.owner_id = mine.id
       AND f.status IN ('ready', 'pending_scan')
       AND (f.delete_after IS NULL OR f.delete_after > (now() AT TIME ZONE 'UTC')::date)
    RETURNING 1
  )
  SELECT count(*)::int INTO n_files FROM upd;

  -- 1 minute back: the cleanup right after (worker clock may lag the DB clock) sees the package as expired.
  UPDATE dsar_requests r SET result_expires_at = now() - interval '1 minute', updated_at = now()
   WHERE r.subject_user_id = v_user AND r.result_file_key IS NOT NULL AND r.result_expires_at > now() - interval '1 minute';
  UPDATE dsar_requests r
     SET status = 'rejected', completed_at = now(), updated_at = now(),
         result_summary = jsonb_build_object('reason', 'account_deleted')
   WHERE r.subject_user_id = v_user AND r.id <> p_request_id AND r.status IN ('received', 'verified', 'processing');

  v_summary := jsonb_build_object(
    'sessions_revoked', n_sessions, 'sign_in_methods_removed', n_accounts, 'mfa_removed', n_mfa,
    'memberships_revoked', n_members, 'product_events_unlinked', n_events, 'files_marked_for_deletion', n_files,
    'kept', jsonb_build_array('invoices', 'ledger', 'audit_events', 'consent_records', 'persons'));
  UPDATE dsar_requests r
     SET status = 'completed', completed_at = now(), updated_at = now(), result_summary = v_summary,
         legal_retention_note = p_note
   WHERE r.id = p_request_id;
  RETURN jsonb_build_object('status', 'completed') || v_summary;
END $$;

CREATE FUNCTION app.dsar_due_results(p_now timestamptz, p_limit integer)
  RETURNS TABLE (id uuid, result_file_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT r.id, r.result_file_key FROM dsar_requests r
     WHERE r.result_file_key IS NOT NULL AND r.result_expires_at <= least(p_now, now())
     ORDER BY r.result_expires_at, r.id
     LIMIT least(greatest(p_limit, 1), 1000)
  $$;

CREATE FUNCTION app.dsar_clear_result(p_id uuid, p_key text) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    WITH x AS (
      UPDATE dsar_requests r SET result_file_key = NULL, result_expires_at = NULL, updated_at = now()
       WHERE r.id = p_id AND r.result_file_key = p_key AND r.result_expires_at <= now()
      RETURNING 1)
    SELECT count(*) = 1 FROM x
  $$;

CREATE FUNCTION app.dsar_metrics(p_now timestamptz) RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT 'hm_dsar_overdue'::text, '{}'::jsonb, count(*)::double precision
      FROM dsar_requests r
     WHERE r.status IN ('received', 'verified', 'processing') AND r.due_at < p_now
  $$;

REVOKE ALL ON FUNCTION app.dsar_sole_owner_orgs(), app.dsar_claim(timestamptz, integer, integer),
  app.dsar_export_data(uuid), app.dsar_complete_access(uuid, text, timestamptz, jsonb), app.dsar_erase_account(uuid, text),
  app.dsar_due_results(timestamptz, integer), app.dsar_clear_result(uuid, text), app.dsar_metrics(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dsar_sole_owner_orgs() TO app_runtime;
GRANT EXECUTE ON FUNCTION app.dsar_claim(timestamptz, integer, integer), app.dsar_export_data(uuid),
  app.dsar_complete_access(uuid, text, timestamptz, jsonb), app.dsar_erase_account(uuid, text),
  app.dsar_due_results(timestamptz, integer), app.dsar_clear_result(uuid, text) TO app_worker;
GRANT EXECUTE ON FUNCTION app.dsar_metrics(timestamptz) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.dsar_metrics(timestamptz);
DROP FUNCTION IF EXISTS app.dsar_clear_result(uuid, text);
DROP FUNCTION IF EXISTS app.dsar_due_results(timestamptz, integer);
DROP FUNCTION IF EXISTS app.dsar_erase_account(uuid, text);
DROP FUNCTION IF EXISTS app.dsar_complete_access(uuid, text, timestamptz, jsonb);
DROP FUNCTION IF EXISTS app.dsar_export_data(uuid);
DROP FUNCTION IF EXISTS app.dsar_claim(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.dsar_sole_owner_orgs();
DROP TABLE IF EXISTS processing_restrictions;
DROP TABLE IF EXISTS dsar_requests;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
