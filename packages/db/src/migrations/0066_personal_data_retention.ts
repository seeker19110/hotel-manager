// PLAN T-2308 (STD-PRIV-005, XC-GREEN-007; D-116) — hạn lưu cho bảng chưa có job dọn + ẩn danh người/giấy tờ hết hạn lưu.
// Cùng khuôn 0056: mỗi bảng MỘT hàm SECURITY DEFINER phạm vi hẹp, chỉ `app_worker` gọi (worker không có DELETE/UPDATE trực tiếp);
// mốc bị chặn trên bởi đồng hồ CSDL (`least(p_now, now())`); số ngày/tháng tối thiểu 1; theo LÔ `p_limit` (1…5000, SKIP LOCKED);
// so sánh nghiêm ngặt "<" (hàng đúng mốc còn giữ). Hằng số hạn lưu ở `packages/app/src/retention/policy.ts`.
// Mọi hàm SECURITY DEFINER đặt `timezone = 'UTC'` (cùng chỗ `search_path`): `timestamptz − make_interval(months/days)` tính theo
// lịch của TimeZone phiên — phiên đặt Asia/Ho_Chi_Minh sẽ lệch mốc tháng tới 1 ngày; cố định UTC thì mốc không phụ thuộc người gọi.
// XOÁ (dữ liệu vận hành, không ai tham chiếu):
//   - `app.purge_notifications(p_now, p_days, p_limit)`: thông báo trong app tạo quá `p_days` ngày VÀ không còn lần gửi nào
//     (`notification_deliveries` FK RESTRICT; lần gửi đã xong được 0056 dọn sau 90/180 ngày, lần gửi đang chờ giữ thông báo lại).
//   - `app.purge_worker_heartbeats(p_now, p_days, p_limit)`: nhịp worker không cập nhật quá `p_days` ngày (tiến trình đã bỏ).
//   - `app.purge_auth_sessions(p_now, p_days, p_limit)`: phiên Better Auth (`auth."session"`) hết hạn (`expiresAt`) quá `p_days` ngày.
//   - `app.purge_auth_verifications(p_now, p_days, p_limit)`: mã xác minh/OTP (`auth."verification"`) hết hạn quá `p_days` ngày.
//   - `app.purge_guest_access_links(p_now, p_days, p_limit)`: liên kết khách quá `p_days` ngày sau lúc hết hiệu lực
//     (`least(expires_at, revoked_at)` — sớm hơn trong hai mốc hết hạn/thu hồi).
// ẨN DANH (không xoá: FK RESTRICT từ sổ tiền/hợp đồng/lưu trú, giữ id để đối chiếu chứng từ — INV-G7 "ẩn danh kèm tombstone"):
//   - `app.anonymize_identity_documents(p_now, p_months, p_limit)`: giấy tờ của người KHÔNG còn quan hệ mở và lưu trú/thuê/đặt
//     phòng cuối kết thúc quá `p_months` tháng (giấy tờ cũng phải được tạo/sửa quá chừng đó, và đã qua `retention_until` nếu có):
//     xoá số mã hoá + khoá + blind index + 4 số cuối + quốc tịch, gỡ `file_id` và đặt `files.delete_after` = hôm nay (UTC) để job
//     `import.retention` (`app.files_due_for_deletion`) xoá object ảnh giấy tờ rồi đánh dấu `deleted`.
//   - `app.anonymize_persons(p_now, p_months, p_limit)`: người KHÔNG còn quan hệ mở, quan hệ tiền/thuê/lưu trú/tài khoản cuối quá
//     `p_months` tháng và mọi giấy tờ đã ẩn danh: tên ⇒ "***" (giá trị trung tính ASCII — giao diện nên hiển thị nhãn dịch theo
//     `anonymized_at`), SĐT/email/địa chỉ/quốc tịch ⇒ NULL, giữ id.
//   `app.retention_person_activity(org, person)` (không cấp cho ai — chỉ hai hàm ẩn danh gọi) trả: còn quan hệ mở không; mốc kết
//   thúc muộn nhất của lưu trú/thuê/đặt phòng; mốc muộn nhất của mọi quan hệ (tiền, thuê, lưu trú, tài khoản, lời mời, phiếu sự cố).
//   "Quan hệ mở": lượt ở expected/in_house; đặt phòng draft/held/confirmed/in_house; hợp đồng chưa
//   closed/cancelled (đại diện hoặc người ở); phiếu còn `open_amount` ≠ 0; cọc còn `balance` ≠ 0; khoản thu `pending`, hoặc đã
//   xác nhận (thu thường) còn phần chưa phân bổ khi người trả còn số dư CUSTOMER_CREDIT > 0 ở cơ sở đó; số dư CUSTOMER_CREDIT
//   (ứng trước/trả thừa) theo cơ sở ≠ 0; báo đã trả `submitted`; tư cách thành viên invited/active/suspended; lời mời pending;
//   phiếu sự cố open/assigned/in_progress.
//   Hai hàm ẩn danh (plpgsql) khoá trước rồi KIỂM LẠI ở câu lệnh sau (chống đua với quan hệ mới) — xem chú thích ngay trên hàm.
//   Mốc "kết thúc" lấy BẢO THỦ = thời điểm muộn nhất của mọi hàng liên quan (`updated_at`, `checked_out_at`, `moved_out_on`+1 ngày…):
//   chạm vào hàng sau này thì đồng hồ tính lại, không bao giờ ẩn danh sớm.
//   Tháng (không phải ngày): 10 năm = 120 tháng đúng lịch — 3650 ngày ngắn hơn 10 năm 2–3 ngày (nghĩa vụ lưu chứng từ kế toán).
//   Mỗi hàng ẩn danh ghi một `audit_events` (actor_type `worker`; append-only chỉ chặn UPDATE/DELETE/TRUNCATE, INSERT được) —
//   chỉ id + chính sách, không ghi dữ liệu cá nhân.
// - Khoản thu "mở" (retention_person_activity): pending; hoặc đã xác nhận (thu thường) còn phần chưa phân bổ (amount > allocated_total)
//   MÀ người trả còn số dư CUSTOMER_CREDIT > 0 ở cơ sở đó — lệnh hoàn `credit.requestRefund` không sửa `payments`, thu cọc không bao
//   giờ được phân bổ: không chặn trần bằng sổ thì người đã được hoàn hết/người nộp cọc bị giữ mãi. Thêm: số dư CUSTOMER_CREDIT
//   (ứng trước/trả thừa — Nợ phải trả cho khách, DOMAIN-MODEL §5) theo từng cơ sở ≠ 0.
// - Hai hàm ẩn danh: plpgsql, HAI câu lệnh (chống đua với quan hệ mới — review 0066):
//   (1) chọn ứng viên theo đủ điều kiện rồi KHOÁ hàng `persons` (và giấy tờ) bằng FOR UPDATE … SKIP LOCKED. FOR UPDATE xung đột
//       FOR KEY SHARE mà INSERT có khoá ngoại tới `persons` giữ ⇒ người đang được gắn quan hệ mới chưa commit bị BỎ QUA. Nhưng
//       `has_open` ở câu này tính theo snapshot đầu câu: quan hệ commit giữa snapshot và lúc khoá không thấy được.
//   (2) câu lệnh SAU (READ COMMITTED ⇒ snapshot mới, lấy khi đã giữ khoá) KIỂM LẠI đủ điều kiện và chỉ UPDATE hàng vẫn đạt. Từ lúc
//       giữ khoá, không INSERT có FK tới người đó commit được trước khi transaction này kết thúc ⇒ không còn khe.
//   Ở REPEATABLE READ/SERIALIZABLE câu (2) dùng lại snapshot cũ ⇒ hàm từ chối chạy. Giới hạn còn lại: `stays.additional_guest_person_ids`
//   là mảng (không FK, không khoá `persons`) — người ở kèm được thêm đúng lúc lô chạy vẫn có thể lọt khe (ghi ở retention-policy).
// - Index cho truy vấn dọn: `ix_notifications_created_at`, `ix_auth_session_expires`, `ix_auth_verification_expires`,
//   `ix_guest_links_dead_at` (biểu thức), `ix_identity_documents_retention`/`ix_persons_retention` (một phần: chưa ẩn danh),
//   `ix_stays_additional_guests` (GIN — tra người ở kèm `additional_guest_person_ids @> ARRAY[id]`).
// - Khoá bảng: CREATE INDEX thường chặn ghi bảng đích ngắn; `lock_timeout` 5 s như 0048/0056.
// - Down: xoá hàm và index; không có dữ liệu để khôi phục (hàng đã xoá/ẩn danh là hàng quá hạn lưu).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ix_notifications_created_at ON notifications (created_at);
CREATE INDEX ix_auth_session_expires ON auth."session" ("expiresAt");
CREATE INDEX ix_auth_verification_expires ON auth."verification" ("expiresAt");
CREATE INDEX ix_guest_links_dead_at ON guest_access_links ((least(expires_at, revoked_at)));
CREATE INDEX ix_identity_documents_retention ON identity_documents (updated_at) WHERE anonymized_at IS NULL;
CREATE INDEX ix_persons_retention ON persons (updated_at) WHERE anonymized_at IS NULL;
CREATE INDEX ix_stays_additional_guests ON stays USING gin (additional_guest_person_ids);

CREATE FUNCTION app.purge_notifications(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
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
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT w.name FROM worker_heartbeats w
      WHERE w.beat_at < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY w.beat_at, w.name
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM worker_heartbeats w USING due WHERE w.name = due.name RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_auth_sessions(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
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
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
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
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT g.id FROM guest_access_links g
      WHERE least(g.expires_at, g.revoked_at) < least(p_now, now()) - make_interval(days => greatest(p_days, 1))
      ORDER BY least(g.expires_at, g.revoked_at), g.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM guest_access_links g USING due WHERE g.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.retention_person_activity(p_org uuid, p_person uuid)
  RETURNS TABLE (has_open boolean, stay_lease_end timestamptz, relation_end timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    WITH ev(kind, is_open, at) AS (
      SELECT 'stay', s.status IN ('expected','in_house'),
             greatest(s.created_at, s.updated_at, s.checked_out_at, (s.debt_due_date + 1)::timestamp AT TIME ZONE 'UTC')
        FROM stays s
       WHERE s.organization_id = p_org
         AND (s.primary_guest_person_id = p_person OR s.debtor_person_id = p_person
              OR s.additional_guest_person_ids @> ARRAY[p_person])
      UNION ALL
      SELECT 'stay', r.status IN ('draft','held','confirmed','in_house'), greatest(r.created_at, r.updated_at, r.cancelled_at)
        FROM reservations r WHERE r.organization_id = p_org AND r.booker_person_id = p_person
      UNION ALL
      SELECT 'stay', l.status NOT IN ('closed','cancelled'),
             greatest(l.created_at, l.updated_at, (l.moved_out_on + 1)::timestamp AT TIME ZONE 'UTC')
        FROM leases l
       WHERE l.organization_id = p_org
         AND (l.representative_person_id = p_person
              OR EXISTS (SELECT 1 FROM lease_occupants o
                         WHERE o.organization_id = p_org AND o.lease_id = l.id AND o.person_id = p_person))
      UNION ALL
      SELECT 'money', i.open_amount <> 0, greatest(i.issued_at, i.updated_at)
        FROM invoices i WHERE i.organization_id = p_org AND i.payer_person_id = p_person
      UNION ALL
      -- payments: pending, or confirmed receivable with an unallocated part while the payer still has CUSTOMER_CREDIT > 0 here.
      SELECT 'money', p.status = 'pending'
               OR (p.status = 'confirmed' AND p.purpose = 'receivable' AND p.amount > p.allocated_total
                   AND coalesce((SELECT sum(j.credit - j.debit) FROM journal_lines j
                                 WHERE j.organization_id = p_org AND j.property_id = p.property_id
                                   AND j.account = 'CUSTOMER_CREDIT' AND j.person_id = p_person), 0) > 0),
             greatest(p.created_at, p.updated_at, p.confirmed_at)
        FROM payments p WHERE p.organization_id = p_org AND p.payer_person_id = p_person
      UNION ALL
      SELECT 'money', d.balance <> 0, greatest(d.created_at, d.updated_at)
        FROM deposits d WHERE d.organization_id = p_org AND d.payer_person_id = p_person
      UNION ALL
      SELECT 'money', false, j.created_at
        FROM journal_lines j WHERE j.organization_id = p_org AND j.person_id = p_person
      UNION ALL
      -- CUSTOMER_CREDIT balance per property <> 0: money still owed to/by the customer.
      SELECT 'money', sum(j.credit - j.debit) <> 0, max(j.created_at)
        FROM journal_lines j
       WHERE j.organization_id = p_org AND j.account = 'CUSTOMER_CREDIT' AND j.person_id = p_person
       GROUP BY j.property_id
      UNION ALL
      SELECT 'money', c.status = 'submitted', greatest(c.created_at, c.updated_at)
        FROM payment_claims c WHERE c.organization_id = p_org AND c.person_id = p_person
      UNION ALL
      SELECT 'other', m.status IN ('invited','active','suspended'), greatest(m.created_at, m.updated_at, m.revoked_at, m.valid_to)
        FROM memberships m WHERE m.organization_id = p_org AND m.person_id = p_person
      UNION ALL
      SELECT 'other', v.status = 'pending', greatest(v.created_at, v.updated_at, v.expires_at)
        FROM invitations v WHERE v.organization_id = p_org AND v.person_id = p_person
      UNION ALL
      SELECT 'other', w.status IN ('open','assigned','in_progress'), greatest(w.created_at, w.updated_at)
        FROM work_orders w WHERE w.organization_id = p_org AND w.reporter_person_id = p_person
    )
    SELECT coalesce(bool_or(ev.is_open), false), max(ev.at) FILTER (WHERE ev.kind = 'stay'), max(ev.at) FROM ev
  $$;

CREATE FUNCTION app.anonymize_identity_documents(p_now timestamptz, p_months integer, p_limit integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_cut timestamptz := least(p_now, now()) - make_interval(months => greatest(p_months, 1));
  v_today date := (least(p_now, now()) AT TIME ZONE 'UTC')::date;
  v_ids uuid[];
  v_n integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'app.anonymize_identity_documents requires READ COMMITTED (re-check after lock needs a fresh snapshot)';
  END IF;
  -- (1) pick + lock documents and their owners (FOR UPDATE conflicts with FK FOR KEY SHARE).
  SELECT coalesce(array_agg(c.id), '{}') INTO v_ids FROM (
    SELECT d.id FROM identity_documents d
    JOIN persons p ON p.organization_id = d.organization_id AND p.id = d.person_id
    CROSS JOIN LATERAL app.retention_person_activity(d.organization_id, d.person_id) a
    WHERE d.anonymized_at IS NULL
      AND d.updated_at < v_cut AND d.created_at < v_cut
      AND (d.retention_until IS NULL OR d.retention_until < v_today)
      AND NOT a.has_open
      AND (a.stay_lease_end IS NULL OR a.stay_lease_end < v_cut)
    ORDER BY d.updated_at, d.id
    LIMIT least(greatest(p_limit, 1), 5000)
    FOR UPDATE OF d, p SKIP LOCKED
  ) c;
  IF cardinality(v_ids) = 0 THEN RETURN 0; END IF;
  -- (2) re-check with a fresh snapshot taken while holding the locks; same predicate as (1).
  WITH due AS (
    SELECT d.id, d.organization_id, d.file_id FROM identity_documents d
    CROSS JOIN LATERAL app.retention_person_activity(d.organization_id, d.person_id) a
    WHERE d.id = ANY (v_ids)
      AND d.anonymized_at IS NULL
      AND d.updated_at < v_cut AND d.created_at < v_cut
      AND (d.retention_until IS NULL OR d.retention_until < v_today)
      AND NOT a.has_open
      AND (a.stay_lease_end IS NULL OR a.stay_lease_end < v_cut)
  ), doc AS (
    UPDATE identity_documents d
       SET doc_number_enc = NULL, doc_number_key_id = NULL, doc_number_hash = NULL, doc_number_last4 = NULL,
           nationality = NULL, file_id = NULL, anonymized_at = now()
      FROM due WHERE d.id = due.id
    RETURNING d.id, d.organization_id, d.property_id, due.file_id
  ), f AS (
    UPDATE files f
       SET delete_after = least(coalesce(f.delete_after, (now() AT TIME ZONE 'UTC')::date), (now() AT TIME ZONE 'UTC')::date)
      FROM due
     WHERE f.organization_id = due.organization_id AND f.id = due.file_id AND f.status IN ('ready','pending_scan')
    RETURNING 1
  ), aud AS (
    INSERT INTO audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, reason,
                              correlation_id)
    SELECT gen_random_uuid(), doc.organization_id, doc.property_id, 'worker', 'identity_document.anonymized',
           'identity_document', doc.id,
           jsonb_build_object('retention_months', greatest(p_months, 1), 'file_scheduled_for_deletion', doc.file_id IS NOT NULL),
           'retention_expired', 'retention.privacy'
      FROM doc
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM doc;
  RETURN v_n;
END
$$;

CREATE FUNCTION app.anonymize_persons(p_now timestamptz, p_months integer, p_limit integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  v_cut timestamptz := least(p_now, now()) - make_interval(months => greatest(p_months, 1));
  v_ids uuid[];
  v_n integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'app.anonymize_persons requires READ COMMITTED (re-check after lock needs a fresh snapshot)';
  END IF;
  -- (1) pick + lock persons (FOR UPDATE conflicts with FK FOR KEY SHARE, incl. new identity documents).
  SELECT coalesce(array_agg(c.id), '{}') INTO v_ids FROM (
    SELECT p.id FROM persons p
    CROSS JOIN LATERAL app.retention_person_activity(p.organization_id, p.id) a
    WHERE p.anonymized_at IS NULL
      AND p.updated_at < v_cut AND p.created_at < v_cut
      AND NOT a.has_open
      AND (a.relation_end IS NULL OR a.relation_end < v_cut)
      AND NOT EXISTS (SELECT 1 FROM identity_documents d
                      WHERE d.organization_id = p.organization_id AND d.person_id = p.id AND d.anonymized_at IS NULL)
    ORDER BY p.updated_at, p.id
    LIMIT least(greatest(p_limit, 1), 5000)
    FOR UPDATE OF p SKIP LOCKED
  ) c;
  IF cardinality(v_ids) = 0 THEN RETURN 0; END IF;
  -- (2) re-check with a fresh snapshot taken while holding the locks; same predicate as (1).
  WITH upd AS (
    UPDATE persons p
       SET full_name = '***', phone = NULL, email = NULL, address = NULL, nationality = NULL, anonymized_at = now()
     WHERE p.id = ANY (v_ids)
       AND p.anonymized_at IS NULL
       AND p.updated_at < v_cut AND p.created_at < v_cut
       AND NOT EXISTS (SELECT 1 FROM app.retention_person_activity(p.organization_id, p.id) a
                       WHERE a.has_open OR a.relation_end >= v_cut)
       AND NOT EXISTS (SELECT 1 FROM identity_documents d
                       WHERE d.organization_id = p.organization_id AND d.person_id = p.id AND d.anonymized_at IS NULL)
    RETURNING p.id, p.organization_id
  ), aud AS (
    INSERT INTO audit_events (id, organization_id, actor_type, action, entity_type, entity_id, after, reason, correlation_id)
    SELECT gen_random_uuid(), upd.organization_id, 'worker', 'person.anonymized', 'person', upd.id,
           jsonb_build_object('retention_months', greatest(p_months, 1)), 'retention_expired', 'retention.privacy'
      FROM upd
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;
  RETURN v_n;
END
$$;

REVOKE ALL ON FUNCTION app.retention_person_activity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_notifications(timestamptz, integer, integer),
  app.purge_worker_heartbeats(timestamptz, integer, integer), app.purge_auth_sessions(timestamptz, integer, integer),
  app.purge_auth_verifications(timestamptz, integer, integer), app.purge_guest_access_links(timestamptz, integer, integer),
  app.anonymize_identity_documents(timestamptz, integer, integer), app.anonymize_persons(timestamptz, integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_notifications(timestamptz, integer, integer),
  app.purge_worker_heartbeats(timestamptz, integer, integer), app.purge_auth_sessions(timestamptz, integer, integer),
  app.purge_auth_verifications(timestamptz, integer, integer), app.purge_guest_access_links(timestamptz, integer, integer),
  app.anonymize_identity_documents(timestamptz, integer, integer), app.anonymize_persons(timestamptz, integer, integer)
  TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.anonymize_persons(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.anonymize_identity_documents(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.retention_person_activity(uuid, uuid);
DROP FUNCTION IF EXISTS app.purge_guest_access_links(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_auth_verifications(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_auth_sessions(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_worker_heartbeats(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS app.purge_notifications(timestamptz, integer, integer);
DROP INDEX IF EXISTS ix_stays_additional_guests;
DROP INDEX IF EXISTS ix_persons_retention;
DROP INDEX IF EXISTS ix_identity_documents_retention;
DROP INDEX IF EXISTS ix_guest_links_dead_at;
DROP INDEX IF EXISTS auth.ix_auth_verification_expires;
DROP INDEX IF EXISTS auth.ix_auth_session_expires;
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
