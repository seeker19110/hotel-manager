// T-2308 (STD-PRIV-005, XC-GREEN-007; D-116) — dọn/ẩn danh theo hạn cho các bảng còn thiếu job. Hạn giữ là ĐỀ XUẤT của kỹ thuật,
// CHỜ DPIA/pháp lý duyệt (docs/ops/retention-policy.md, docs/privacy/data-map.yaml). Số ngày/tháng/năm do worker truyền vào từ
// `packages/app/src/retention/policy.ts` (MỘT nguồn); hàm ở đây chỉ có SÀN an toàn. Cùng mẫu 0056: mỗi việc một hàm SECURITY DEFINER
// phạm vi hẹp, chỉ app_worker gọi; mốc bị chặn trên bởi đồng hồ CSDL (`least(p_now, now())`); số ngày tối thiểu 1; theo LÔ
// (`p_limit` 1…5000, SKIP LOCKED); so sánh nghiêm ngặt "<" (hàng đúng mốc còn giữ); chạy lại không làm gì thêm (idempotent).
//   - `app.purge_notifications(p_now, p_days, p_limit)`: thông báo trong ứng dụng tạo quá `p_days` ngày VÀ không còn lần gửi
//     (`notification_deliveries` FK RESTRICT; lần gửi được dọn trước bởi `app.purge_notification_deliveries`, lần gửi chưa xong giữ
//     thông báo cha).
//   - `app.purge_worker_heartbeats(p_now, p_days, p_limit)`: nhịp worker không cập nhật quá `p_days` ngày (tên worker đã bỏ).
//   - `app.purge_auth_sessions(p_now, p_days, p_limit)`: phiên Better Auth (`auth."session"`) hết hạn (`expiresAt`) quá `p_days` ngày.
//   - `app.purge_auth_verifications(p_now, p_days, p_limit)`: mã xác minh (`auth."verification"`) hết hạn quá `p_days` ngày.
//   - `app.purge_guest_access_links(p_now, p_days, p_limit)`: link khách kết thúc (hết hạn `expires_at` hoặc thu hồi `revoked_at`,
//     lấy mốc SỚM hơn) quá `p_days` ngày. Không bảng nào tham chiếu `guest_access_links` (đã kiểm FK); audit_events ghi id dạng
//     giá trị, không FK — vết kiểm toán không bị phá.
//   - `app.purge_inbox_raw(p_now, p_years, p_limit)`: inbox (sổ phụ ngân hàng thô) là CHỨNG TỪ TIỀN, bị `bank_transactions` và
//     `reconciliation_breaks` tham chiếu (FK RESTRICT) và có trigger cấm xoá (`trg_inbox_no_delete`) ⇒ KHÔNG xoá dòng, chỉ làm rỗng
//     cột thô `raw` → '{}' (giữ `provider_event_id` chống trùng, `payload_hash` làm bằng chứng toàn vẹn, liên kết giao dịch). Hạn:
//     Luật Kế toán 88/2015 Đ.41 (chưa xác minh bản gốc) — giữ tối thiểu 10 năm; cách hiểu CHẶT: tính từ hết năm (dương lịch, giờ VN) chứa lúc nhận
//     (`received_at`), không từ chính lúc nhận (năm tài chính khác năm dương lịch: chưa xác minh). Hàng `pending` không bao giờ bị
//     đụng. `app.inbox_immutable` được nới HẸP đúng một đường: `raw` → '{}' khi hàng đã qua sàn 10 năm và không `pending`; mọi sửa
//     nội dung khác vẫn bị chặn.
//   - `app.anonymize_identity_documents(p_now, p_months, p_limit)`: giấy tờ của người KHÔNG còn quan hệ lưu trú/thuê đang hiệu lực
//     (lượt ở `expected`/`in_house`; đặt phòng `draft`/`held`/`confirmed`/`in_house`; hợp đồng chưa `closed`/`cancelled` — đứng tên
//     hoặc người ở cùng) và quan hệ CUỐI kết thúc quá `p_months` tháng ⇒ đặt `anonymized_at`, xoá số mã hoá/băm/4 số cuối, quốc
//     tịch, `file_id` (CHECK `ck_identity_documents_anonymized`). `retention_until` (nếu có) là hạn giữ tối thiểu: chưa qua thì
//     không đụng. File ảnh (chỉ file `owner_type = 'identity_document'`): đặt `files.delete_after` = hôm nay (UTC) để job
//     `import.retention` xoá object rồi đánh dấu `deleted` — SQL không xoá object.
//   - `app.anonymize_persons(p_now, p_years, p_limit)`: GIỮ dòng (FK RESTRICT từ sổ tiền, hợp đồng, lượt ở…) — đặt `anonymized_at`,
//     thay họ tên bằng nhãn trung tính '—', null SĐT/email/địa chỉ/quốc tịch (cột PII của `persons` theo data-map) khi: không còn
//     quan hệ đang hiệu lực (như trên + membership `invited`/`active`/`suspended`, hoá đơn còn nợ, cọc còn số dư, thanh toán
//     `pending`, báo chuyển khoản `submitted`, phiếu bảo trì chưa xong), không còn giấy tờ chưa ẩn danh, và mốc quan hệ cuối
//     (tiền/thuê/lưu trú/thành viên/bảo trì; không có thì lúc tạo) quá `p_years` năm. Số tiền, khoá ngoại không đổi.
// Hàm phụ `app.retention_stay_lease_state` / `app.retention_person_state` (không SECURITY DEFINER, không cấp cho ai) trả
// (còn hiệu lực?, mốc kết thúc cuối) cho một người. Mốc kết thúc dùng `updated_at` của dòng đã kết thúc (≥ lúc trả phòng/đóng) —
// lệch về phía GIỮ LÂU hơn, an toàn.
// - Index cho truy vấn dọn: `ix_notifications_created_at`, `ix_guest_access_links_ended` (biểu thức mốc kết thúc),
//   `ix_inbox_raw_retention` (phần chưa làm rỗng), `ix_auth_session_expires`, `ix_auth_verification_expires`,
//   `ix_stays_additional_guests` (GIN — tìm lượt ở theo người ở cùng).
// - Khoá bảng: CREATE INDEX thường chặn ghi bảng đích ngắn; `lock_timeout` 5 s như 0048/0056.
// - Down: gỡ hàm, index; trả `app.inbox_immutable` về bản 0005. Dữ liệu đã xoá/ẩn danh không khôi phục được (đã quá hạn giữ).
import { type Kysely, sql } from "kysely";

/** Mốc "hết năm chứa lúc nhận + N năm" ⇒ hàng nhận TRƯỚC đầu năm (năm hiện tại − N) giờ VN mới hết hạn giữ. Sàn N = 10 (luật). */
const inboxCutoff = (at: string, years: string) =>
  `((date_trunc('year', (${at}) AT TIME ZONE 'Asia/Ho_Chi_Minh') - make_interval(years => greatest(${years}, 10))) AT TIME ZONE 'Asia/Ho_Chi_Minh')`;

const INBOX_IMMUTABLE_0005 = `
CREATE OR REPLACE FUNCTION app.inbox_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account IS DISTINCT FROM OLD.account
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.raw IS DISTINCT FROM OLD.raw OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'nội dung inbox % không được sửa', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.bank_transaction_id IS NOT NULL AND NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id THEN
    RAISE EXCEPTION 'inbox % đã gắn giao dịch ngân hàng', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
`;

const STAY_LEASE_STATE = `
    SELECT s.status IN ('expected','in_house'), greatest(s.checked_out_at, s.updated_at)
      FROM stays s WHERE s.organization_id = p_org AND s.primary_guest_person_id = p_person
    UNION ALL
    SELECT s.status IN ('expected','in_house'), greatest(s.checked_out_at, s.updated_at)
      FROM stays s WHERE s.organization_id = p_org AND s.debtor_person_id = p_person
    UNION ALL
    SELECT s.status IN ('expected','in_house'), greatest(s.checked_out_at, s.updated_at)
      FROM stays s WHERE s.additional_guest_person_ids @> ARRAY[p_person] AND s.organization_id = p_org
    UNION ALL
    SELECT r.status IN ('draft','held','confirmed','in_house'), r.updated_at
      FROM reservations r WHERE r.organization_id = p_org AND r.booker_person_id = p_person
    UNION ALL
    SELECT l.status NOT IN ('closed','cancelled'), l.updated_at
      FROM leases l WHERE l.organization_id = p_org AND l.representative_person_id = p_person
    UNION ALL
    SELECT l.status NOT IN ('closed','cancelled'), greatest(l.updated_at, o.updated_at)
      FROM lease_occupants o
      JOIN leases l ON l.organization_id = o.organization_id AND l.property_id = o.property_id AND l.id = o.lease_id
      WHERE o.organization_id = p_org AND o.person_id = p_person`;

const UP = `
CREATE INDEX ix_notifications_created_at ON notifications (created_at);
CREATE INDEX ix_guest_access_links_ended ON guest_access_links ((least(expires_at, coalesce(revoked_at, expires_at))));
CREATE INDEX ix_inbox_raw_retention ON inbox (received_at) WHERE raw <> '{}'::jsonb AND process_status <> 'pending';
CREATE INDEX ix_auth_session_expires ON auth."session" ("expiresAt");
CREATE INDEX ix_auth_verification_expires ON auth."verification" ("expiresAt");
CREATE INDEX ix_stays_additional_guests ON stays USING gin (additional_guest_person_ids);

CREATE FUNCTION app.purge_notifications(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT n.id FROM notifications n
      WHERE n.created_at < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
        AND NOT EXISTS (SELECT 1 FROM notification_deliveries d
                        WHERE d.organization_id = n.organization_id AND d.notification_id = n.id)
      ORDER BY n.created_at, n.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM notifications n USING due WHERE n.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_worker_heartbeats(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT h.name FROM worker_heartbeats h
      WHERE h.beat_at < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY h.beat_at, h.name
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM worker_heartbeats h USING due WHERE h.name = due.name RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_auth_sessions(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT s.id FROM auth."session" s
      WHERE s."expiresAt" < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY s."expiresAt", s.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM auth."session" s USING due WHERE s.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_auth_verifications(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT v.id FROM auth."verification" v
      WHERE v."expiresAt" < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY v."expiresAt", v.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM auth."verification" v USING due WHERE v.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_guest_access_links(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT g.id FROM guest_access_links g
      WHERE least(g.expires_at, coalesce(g.revoked_at, g.expires_at))
            < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY least(g.expires_at, coalesce(g.revoked_at, g.expires_at)), g.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM guest_access_links g USING due WHERE g.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

-- Nới HẸP bất biến inbox (0005): thêm đúng một đường — làm rỗng \`raw\` khi đã qua sàn 10 năm (Luật Kế toán) và không pending.
CREATE OR REPLACE FUNCTION app.inbox_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account IS DISTINCT FROM OLD.account
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'nội dung inbox % không được sửa', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF NEW.raw IS DISTINCT FROM OLD.raw THEN
    IF NEW.raw <> '{}'::jsonb OR OLD.process_status = 'pending' OR NEW.process_status = 'pending'
       OR NOT (OLD.received_at < ${inboxCutoff("now()", "10")}) THEN
      RAISE EXCEPTION 'nội dung inbox % không được sửa', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
    END IF;
  END IF;
  IF OLD.bank_transaction_id IS NOT NULL AND NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id THEN
    RAISE EXCEPTION 'inbox % đã gắn giao dịch ngân hàng', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.purge_inbox_raw(p_now timestamptz, p_years integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT i.id FROM inbox i
      WHERE i.raw <> '{}'::jsonb AND i.process_status <> 'pending'
        AND i.received_at < ${inboxCutoff("least(p_now, now())", "p_years")}
      ORDER BY i.received_at, i.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      UPDATE inbox i SET raw = '{}'::jsonb FROM due WHERE i.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.retention_stay_lease_state(p_org uuid, p_person uuid, OUT open boolean, OUT last_end timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT coalesce(bool_or(r.o), false), max(r.e) FROM (${STAY_LEASE_STATE}) AS r(o, e)
  $$;

CREATE FUNCTION app.retention_person_state(p_org uuid, p_person uuid, OUT open boolean, OUT last_end timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT coalesce(bool_or(r.o), false), max(r.e) FROM (${STAY_LEASE_STATE}
    UNION ALL
    SELECT m.status IN ('invited','active','suspended'), greatest(m.updated_at, m.revoked_at, m.valid_to)
      FROM memberships m WHERE m.organization_id = p_org AND m.person_id = p_person
    UNION ALL
    SELECT i.open_amount > 0, greatest(i.issued_at, i.updated_at)
      FROM invoices i WHERE i.organization_id = p_org AND i.payer_person_id = p_person
    UNION ALL
    SELECT p.status = 'pending', greatest(p.created_at, p.updated_at, p.confirmed_at, p.reversed_at)
      FROM payments p WHERE p.organization_id = p_org AND p.payer_person_id = p_person
    UNION ALL
    SELECT d.balance <> 0, greatest(d.created_at, d.updated_at)
      FROM deposits d WHERE d.organization_id = p_org AND d.payer_person_id = p_person
    UNION ALL
    SELECT c.status = 'submitted', greatest(c.created_at, c.updated_at, c.handled_at)
      FROM payment_claims c WHERE c.organization_id = p_org AND c.person_id = p_person
    UNION ALL
    SELECT false, j.created_at
      FROM journal_lines j WHERE j.organization_id = p_org AND j.person_id = p_person
    UNION ALL
    SELECT w.status NOT IN ('done','verified','cancelled'), w.updated_at
      FROM work_orders w WHERE w.organization_id = p_org AND w.reporter_person_id = p_person
    ) AS r(o, e)
  $$;

CREATE FUNCTION app.anonymize_identity_documents(p_now timestamptz, p_months integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH cut AS (
      SELECT least(p_now, now()) - make_interval(months => greatest(p_months, 1)) AS c,
             (least(p_now, now()) AT TIME ZONE 'UTC')::date AS today
    ), due AS (
      SELECT d.organization_id, d.id, d.file_id FROM identity_documents d
      CROSS JOIN cut
      CROSS JOIN LATERAL app.retention_stay_lease_state(d.organization_id, d.person_id) st
      WHERE d.anonymized_at IS NULL
        AND d.created_at < cut.c
        AND (d.retention_until IS NULL OR d.retention_until < cut.today)
        AND NOT st.open
        AND (st.last_end IS NULL OR st.last_end < cut.c)
      ORDER BY d.created_at, d.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE OF d SKIP LOCKED
    ), f AS (
      UPDATE files fl SET delete_after = (SELECT today FROM cut), version = fl.version + 1
      FROM due
      WHERE fl.organization_id = due.organization_id AND fl.owner_type = 'identity_document'
        AND (fl.id = due.file_id OR fl.owner_id = due.id)
        AND fl.status IN ('ready','pending_scan')
        AND (fl.delete_after IS NULL OR fl.delete_after > (SELECT today FROM cut))
      RETURNING 1
    ), x AS (
      UPDATE identity_documents d
      SET anonymized_at = now(), doc_number_enc = NULL, doc_number_key_id = NULL, doc_number_hash = NULL,
          doc_number_last4 = NULL, nationality = NULL, file_id = NULL, version = d.version + 1
      FROM due WHERE d.id = due.id
      RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.anonymize_persons(p_now timestamptz, p_years integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH cut AS (
      SELECT least(p_now, now()) - make_interval(years => greatest(p_years, 1)) AS c
    ), due AS (
      SELECT p.id FROM persons p
      CROSS JOIN cut
      CROSS JOIN LATERAL app.retention_person_state(p.organization_id, p.id) st
      WHERE p.anonymized_at IS NULL
        AND p.created_at < cut.c
        AND NOT st.open
        AND (st.last_end IS NULL OR st.last_end < cut.c)
        AND NOT EXISTS (SELECT 1 FROM identity_documents d
                        WHERE d.organization_id = p.organization_id AND d.person_id = p.id AND d.anonymized_at IS NULL)
      ORDER BY p.created_at, p.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE OF p SKIP LOCKED
    ), x AS (
      UPDATE persons p
      SET anonymized_at = now(), full_name = '—', phone = NULL, email = NULL, address = NULL, nationality = NULL,
          version = p.version + 1
      FROM due WHERE p.id = due.id
      RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

REVOKE ALL ON FUNCTION app.retention_stay_lease_state(uuid, uuid), app.retention_person_state(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_notifications(timestamptz, integer, integer),
  app.purge_worker_heartbeats(timestamptz, integer, integer), app.purge_auth_sessions(timestamptz, integer, integer),
  app.purge_auth_verifications(timestamptz, integer, integer), app.purge_guest_access_links(timestamptz, integer, integer),
  app.purge_inbox_raw(timestamptz, integer, integer), app.anonymize_identity_documents(timestamptz, integer, integer),
  app.anonymize_persons(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_notifications(timestamptz, integer, integer),
  app.purge_worker_heartbeats(timestamptz, integer, integer), app.purge_auth_sessions(timestamptz, integer, integer),
  app.purge_auth_verifications(timestamptz, integer, integer), app.purge_guest_access_links(timestamptz, integer, integer),
  app.purge_inbox_raw(timestamptz, integer, integer), app.anonymize_identity_documents(timestamptz, integer, integer),
  app.anonymize_persons(timestamptz, integer, integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.anonymize_persons(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.anonymize_identity_documents(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.retention_person_state(uuid, uuid);
DROP FUNCTION IF EXISTS app.retention_stay_lease_state(uuid, uuid);
DROP FUNCTION IF EXISTS app.purge_inbox_raw(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_guest_access_links(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_auth_verifications(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_auth_sessions(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_worker_heartbeats(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_notifications(timestamptz, integer, integer);
${INBOX_IMMUTABLE_0005}
DROP INDEX IF EXISTS ix_stays_additional_guests;
DROP INDEX IF EXISTS auth.ix_auth_verification_expires;
DROP INDEX IF EXISTS auth.ix_auth_session_expires;
DROP INDEX IF EXISTS ix_inbox_raw_retention;
DROP INDEX IF EXISTS ix_guest_access_links_ended;
DROP INDEX IF EXISTS ix_notifications_created_at;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const prev =
    (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(db)).rows[0]?.v ?? "0";
  await sql`select set_config('lock_timeout', '5s', true)`.execute(db);
  await sql.raw(UP).execute(db);
  await sql`select set_config('lock_timeout', ${prev}, true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
