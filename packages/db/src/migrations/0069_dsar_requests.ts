// T-2311 (STD-PRIV-004, CMP-RIGHTS-007, CMP-INTL-007, CMP-PRIV-005, CMP-VN-007; D-120, D-124) — yêu cầu của chủ thể dữ liệu (DSAR).
// - `dsar_requests`: MỘT hàng = một yêu cầu truy cập (`access`), xoá tài khoản (`delete`) hoặc bật/tắt hạn chế xử lý (`restrict`) của
//   CHÍNH người dùng đăng nhập. `due_at` = `received_at` + hạn theo vùng (`packages/app/src/privacy/dsar-policy.ts`, app tính — CSDL chỉ
//   chặn `due_at > received_at`). `result` là jsonb KHÔNG PII: số dòng theo kho, kho giữ lại + lý do (≤ 4 KB, phải là object).
//   `status`: received → completed | rejected; `completed_at` có ⇔ status khác `received` (CHECK).
// - `processing_restrictions`: có hàng = người dùng đang hạn chế xử lý (GDPR Art. 18; Luật 91/2025 Đ.4) ⇒ `track()` bỏ qua actor; tắt =
//   xoá hàng. Không cột nào khác (bật/tắt nào cũng ghi một `dsar_requests` kind `restrict` làm vết).
// - QUYỀN theo NGƯỜI DÙNG như consent_records (0068): RLS bật + FORCE, policy `subject_user_id = app.current_auth_user()`; app đặt
//   `SET LOCAL app.auth_user_id` = id người dùng của PHIÊN đã xác minh. app_runtime: dsar_requests SELECT + INSERT (không UPDATE — hoàn tất
//   yêu cầu xoá đi qua hàm của worker); processing_restrictions SELECT + INSERT + DELETE. app_worker: không quyền bảng trực tiếp.
// - Hàm SECURITY DEFINER phạm vi hẹp:
//     · app_runtime (chỉ dữ liệu của `app.current_auth_user()`, không nhận id người từ ngoài):
//         `app.dsar_sole_owner_orgs()` — số tổ chức mà người gọi là owner active DUY NHẤT (owner khác đang chờ xoá không tính) ⇒ chặn xoá.
//         `app.dsar_my_memberships()` — thành viên của người gọi ở MỌI tổ chức (RLS theo tổ chức không cho đọc xuyên tổ chức) cho bản xuất.
//     · app_runtime: `app.dsar_actor_event_summary(p_actor)` — đếm sự kiện sản phẩm theo actor_key giả danh (HMAC bằng bí mật server; app
//       tính từ id của PHIÊN). Chỉ trả tên sự kiện + số đếm + mốc thời gian, không thuộc tính, không tổ chức.
//     · app_worker: `app.dsar_open_erasures(p_limit)` (yêu cầu xoá đang chờ) và `app.dsar_complete_erasure(p_request, p_analytics_rows)` —
//       kết thúc mọi membership (kèm audit_events từng tổ chức, actor worker), ẩn danh hồ sơ người liên kết KHÔNG gắn chứng từ tiền/hợp
//       đồng/lưu trú, xoá phiên/phương thức đăng nhập/2FA/xác minh còn sót, ẩn danh auth user, rồi đóng yêu cầu với `result`.
//       Lúc thực hiện đã thành owner duy nhất (LAST_OWNER) ⇒ hoàn tác và đóng yêu cầu `rejected` (`result.rejected_reason =
//       'last_owner'`) thay vì ném mỗi lượt.
//       GIỮ: consent_records (bằng chứng đồng ý, D-124), chứng từ tiền + hồ sơ người gắn chứng từ (nghĩa vụ kế toán), audit_events.
//     · app_runtime + app_worker: `app.dsar_metrics(p_now)` — `hm_dsar_overdue` (số yêu cầu quá hạn chưa xong, không nhãn).
// - `SET CONSTRAINTS trg_memberships_last_owner IMMEDIATE` trong hàm xoá: ràng buộc "còn owner active" (trigger hoãn tới COMMIT) phải
//   chạy NGAY trong ngữ cảnh hàm — lúc COMMIT người gọi là app_worker, không có ngữ cảnh tổ chức nên RLS memberships sẽ ném
//   TENANT_CONTEXT_MISSING thay vì kiểm đúng.
// - Index: (subject_user_id, received_at DESC) cho lịch sử + FK; (due_at) một phần cho yêu cầu đang mở (metric, worker).
// - Down: gỡ hàm và hai bảng (mất vết yêu cầu — chỉ dùng khi lùi bản phát hành ngay sau khi áp; không bảng nào tham chiếu).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE dsar_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('access', 'delete', 'restrict')),
  region text NOT NULL CHECK (region ~ '^([A-Z]{2}|DEFAULT)$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'completed', 'rejected')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 4096),
  CONSTRAINT ck_dsar_requests_due CHECK (due_at > received_at),
  CONSTRAINT ck_dsar_requests_completed CHECK ((status = 'received') = (completed_at IS NULL))
);
CREATE INDEX ix_dsar_requests_subject ON dsar_requests (subject_user_id, received_at DESC);
CREATE INDEX ix_dsar_requests_open_due ON dsar_requests (due_at) WHERE completed_at IS NULL;
ALTER TABLE dsar_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dsar_requests_self_read ON dsar_requests FOR SELECT
  USING (subject_user_id = app.current_auth_user());
CREATE POLICY dsar_requests_self_insert ON dsar_requests FOR INSERT
  WITH CHECK (subject_user_id = app.current_auth_user());
REVOKE ALL ON dsar_requests FROM PUBLIC;
GRANT SELECT, INSERT ON dsar_requests TO app_runtime;

CREATE TABLE processing_restrictions (
  subject_user_id uuid PRIMARY KEY REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  restricted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE processing_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_restrictions FORCE ROW LEVEL SECURITY;
CREATE POLICY processing_restrictions_self ON processing_restrictions FOR ALL
  USING (subject_user_id = app.current_auth_user()) WITH CHECK (subject_user_id = app.current_auth_user());
REVOKE ALL ON processing_restrictions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON processing_restrictions TO app_runtime;

CREATE FUNCTION app.dsar_sole_owner_orgs() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(DISTINCT m.organization_id)::int FROM memberships m
    WHERE app.current_auth_user() IS NOT NULL
      AND m.auth_user_id = app.current_auth_user() AND m.role = 'owner' AND m.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM memberships o
        WHERE o.organization_id = m.organization_id AND o.role = 'owner' AND o.status = 'active'
          AND o.auth_user_id IS DISTINCT FROM m.auth_user_id
          AND NOT EXISTS (SELECT 1 FROM dsar_requests d
                          WHERE d.subject_user_id = o.auth_user_id AND d.kind = 'delete' AND d.status = 'received'))
  $$;

CREATE FUNCTION app.dsar_my_memberships()
  RETURNS TABLE (organization_id uuid, organization_name text, role text, status text, valid_from timestamptz,
                 valid_to timestamptz, revoked_at timestamptz, person_full_name text, person_email text, person_phone text,
                 person_address text, person_nationality text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.organization_id, o.name, m.role, m.status, m.valid_from, m.valid_to, m.revoked_at,
           p.full_name, p.email, p.phone, p.address, p.nationality::text
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    JOIN persons p ON p.organization_id = m.organization_id AND p.id = m.person_id
    WHERE app.current_auth_user() IS NOT NULL AND m.auth_user_id = app.current_auth_user()
    ORDER BY m.created_at, m.id
  $$;

CREATE FUNCTION app.dsar_actor_event_summary(p_actor bytea)
  RETURNS TABLE (event text, n integer, first_at timestamptz, last_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT e.event, count(*)::int, min(e.occurred_at), max(e.occurred_at) FROM product_events e
    WHERE p_actor IS NOT NULL AND octet_length(p_actor) = 32 AND e.actor_key = p_actor
    GROUP BY e.event ORDER BY e.event
  $$;

CREATE FUNCTION app.dsar_open_erasures(p_limit integer)
  RETURNS TABLE (request_id uuid, subject_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.id, d.subject_user_id FROM dsar_requests d
    WHERE d.kind = 'delete' AND d.status = 'received'
    ORDER BY d.due_at, d.id
    LIMIT least(greatest(p_limit, 1), 100)
  $$;

CREATE FUNCTION app.dsar_complete_erasure(p_request uuid, p_analytics_rows integer) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid;
  v_sessions int; v_accounts int; v_two_factor int; v_verifications int; v_memberships int;
  v_persons_anon int; v_persons_kept int; v_consents int; v_restrictions int;
  v_result jsonb;
  v_hint text;
BEGIN
  SELECT d.subject_user_id INTO v_user FROM dsar_requests d
  WHERE d.id = p_request AND d.kind = 'delete' AND d.status = 'received'
  FOR UPDATE;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  -- LAST_OWNER: see header comment (rejected, not re-raised every run).
  BEGIN

  INSERT INTO auth.revoked_session (token_hash, user_id, expires_at)
    SELECT sha256(convert_to(s.token, 'UTF8')), s."userId", s."expiresAt" FROM auth."session" s WHERE s."userId" = v_user
    ON CONFLICT (token_hash) DO NOTHING;
  DELETE FROM auth."session" WHERE "userId" = v_user;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM auth.account WHERE "userId" = v_user;
  GET DIAGNOSTICS v_accounts = ROW_COUNT;
  DELETE FROM auth."twoFactor" WHERE "userId" = v_user;
  GET DIAGNOSTICS v_two_factor = ROW_COUNT;
  DELETE FROM auth.verification WHERE position(v_user::text IN identifier) > 0;
  GET DIAGNOSTICS v_verifications = ROW_COUNT;

  SET CONSTRAINTS public.trg_memberships_last_owner IMMEDIATE;
  WITH ended AS (
    UPDATE memberships m SET status = 'revoked', revoked_at = now(), version = m.version + 1
    WHERE m.auth_user_id = v_user AND m.status <> 'revoked'
    RETURNING m.organization_id, m.id
  ), audited AS (
    INSERT INTO audit_events (id, organization_id, actor_type, action, entity_type, entity_id, correlation_id, after)
    SELECT gen_random_uuid(), e.organization_id, 'worker', 'membership.revoked', 'membership', e.id,
           'dsar:' || p_request::text, jsonb_build_object('reason', 'account_deleted')
    FROM ended e
    RETURNING 1
  )
  SELECT count(*)::int INTO v_memberships FROM audited;

  WITH linked AS (
    SELECT DISTINCT p.organization_id, p.id FROM memberships m
    JOIN persons p ON p.organization_id = m.organization_id AND p.id = m.person_id
    WHERE m.auth_user_id = v_user AND p.anonymized_at IS NULL
  ), classified AS (
    SELECT l.organization_id, l.id,
      (EXISTS (SELECT 1 FROM memberships o WHERE o.organization_id = l.organization_id AND o.person_id = l.id
                 AND o.auth_user_id IS DISTINCT FROM v_user AND o.status <> 'revoked')
       OR (SELECT st.last_end IS NOT NULL OR st.open FROM app.retention_stay_lease_state(l.organization_id, l.id) st)
       OR EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = l.organization_id AND i.payer_person_id = l.id)
       OR EXISTS (SELECT 1 FROM payments x WHERE x.organization_id = l.organization_id AND x.payer_person_id = l.id)
       OR EXISTS (SELECT 1 FROM deposits x WHERE x.organization_id = l.organization_id AND x.payer_person_id = l.id)
       OR EXISTS (SELECT 1 FROM payment_claims x WHERE x.organization_id = l.organization_id AND x.person_id = l.id)
       OR EXISTS (SELECT 1 FROM journal_lines x WHERE x.organization_id = l.organization_id AND x.person_id = l.id)
       OR EXISTS (SELECT 1 FROM identity_documents x
                  WHERE x.organization_id = l.organization_id AND x.person_id = l.id AND x.anonymized_at IS NULL)
      ) AS keep
    FROM linked l
  ), anon AS (
    UPDATE persons p
    SET anonymized_at = now(), full_name = '—', phone = NULL, email = NULL, address = NULL, nationality = NULL,
        version = p.version + 1
    FROM classified c WHERE NOT c.keep AND p.organization_id = c.organization_id AND p.id = c.id
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM anon), (SELECT count(*)::int FROM classified WHERE keep)
    INTO v_persons_anon, v_persons_kept;

  DELETE FROM processing_restrictions WHERE subject_user_id = v_user;
  GET DIAGNOSTICS v_restrictions = ROW_COUNT;

  UPDATE auth."user"
  SET name = '—', email = 'deleted-' || v_user::text || '@deleted.invalid', "emailVerified" = false, image = NULL,
      "twoFactorEnabled" = false, "updatedAt" = now()
  WHERE id = v_user;

  SELECT count(*)::int INTO v_consents FROM consent_records c WHERE c.subject_user_id = v_user;

  v_result := jsonb_build_object(
    'erased', jsonb_build_object(
      'auth_sessions', v_sessions, 'auth_accounts', v_accounts, 'auth_two_factor', v_two_factor,
      'auth_verifications', v_verifications, 'memberships_ended', v_memberships, 'persons_anonymized', v_persons_anon,
      'processing_restrictions', v_restrictions, 'product_events', greatest(coalesce(p_analytics_rows, 0), 0),
      'auth_user', 'anonymized'),
    'retained', jsonb_build_array(
      jsonb_build_object('store', 'consent_records', 'rows', v_consents, 'reason', 'legal_obligation_consent_proof'),
      jsonb_build_object('store', 'persons', 'rows', v_persons_kept, 'reason', 'accounting_records_retention'),
      jsonb_build_object('store', 'financial_records', 'reason', 'accounting_records_retention'),
      jsonb_build_object('store', 'audit_events', 'reason', 'security_audit_trail'),
      jsonb_build_object('store', 'dsar_requests', 'reason', 'dsar_accountability')),
    'outside_repo', jsonb_build_array(
      jsonb_build_object('store', 'backups', 'reason', 'expires_per_RET_10')));

  UPDATE dsar_requests SET status = 'completed', completed_at = now(), result = v_result WHERE id = p_request;
  RETURN v_result;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    IF v_hint IS DISTINCT FROM 'LAST_OWNER' THEN
      RAISE;
    END IF;
  END;
  v_result := jsonb_build_object('rejected_reason', 'last_owner',
                                 'detail', 'subject_is_sole_active_owner_transfer_ownership_first');
  UPDATE dsar_requests SET status = 'rejected', completed_at = now(), result = v_result WHERE id = p_request;
  RETURN v_result;
END $$;

CREATE FUNCTION app.dsar_metrics(p_now timestamptz)
  RETURNS TABLE (name text, labels jsonb, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'hm_dsar_overdue'::text, '{}'::jsonb, count(*)::float8 FROM dsar_requests d
    WHERE d.completed_at IS NULL AND d.due_at < p_now
  $$;

REVOKE ALL ON FUNCTION app.dsar_sole_owner_orgs(), app.dsar_my_memberships(), app.dsar_actor_event_summary(bytea),
  app.dsar_open_erasures(integer), app.dsar_complete_erasure(uuid, integer), app.dsar_metrics(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dsar_sole_owner_orgs(), app.dsar_my_memberships(), app.dsar_actor_event_summary(bytea)
  TO app_runtime;
GRANT EXECUTE ON FUNCTION app.dsar_open_erasures(integer), app.dsar_complete_erasure(uuid, integer) TO app_worker;
GRANT EXECUTE ON FUNCTION app.dsar_metrics(timestamptz) TO app_runtime, app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.dsar_metrics(timestamptz);
DROP FUNCTION IF EXISTS app.dsar_complete_erasure(uuid, integer);
DROP FUNCTION IF EXISTS app.dsar_open_erasures(integer);
DROP FUNCTION IF EXISTS app.dsar_actor_event_summary(bytea);
DROP FUNCTION IF EXISTS app.dsar_my_memberships();
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
