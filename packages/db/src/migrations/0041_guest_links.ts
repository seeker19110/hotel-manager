// PLAN đợt 3 T-218 — liên kết khách (SPEC-portal S-016…S-020; ERD `guest_access_links`; D-006).
// - Token 256 bit chỉ lưu SHA-256 (unique toàn cục); khách không có phiên → tra token qua hàm SECURITY DEFINER hẹp
//   `app.resolve_guest_link`, đọc dữ liệu qua `app.guest_stay_view` (chỉ đúng lượt ở của link: ngày, phòng, trạng thái,
//   dòng folio, tiền đã trả — không hồ sơ cơ sở, khách khác, giấy tờ).
// - Bước hai: 4 số cuối SĐT người đặt; sai 5 lần ⇒ khoá link (`locked_at`). Giới hạn theo IP (băm) trong CSDL — đúng cả
//   khi chạy nhiều instance; thông điệp không phân biệt lý do.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE guest_access_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid NOT NULL,
  stay_id uuid,
  reservation_id uuid,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  created_by uuid NOT NULL,
  last_used_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_guest_access_links_token UNIQUE (token_hash),
  CONSTRAINT uq_guest_access_links_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_guest_links_stay FOREIGN KEY (organization_id, property_id, stay_id) REFERENCES stays (organization_id, property_id, id),
  CONSTRAINT fk_guest_links_reservation FOREIGN KEY (organization_id, property_id, reservation_id)
    REFERENCES reservations (organization_id, property_id, id),
  CONSTRAINT fk_guest_links_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_guest_links_revoked_by FOREIGN KEY (organization_id, revoked_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_guest_links_scope CHECK (num_nonnulls(stay_id, reservation_id) = 1),
  CONSTRAINT ck_guest_links_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_guest_links_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX ix_guest_links_stay ON guest_access_links (organization_id, stay_id);
CREATE TRIGGER trg_guest_links_updated BEFORE UPDATE ON guest_access_links FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- Loại M: chỉ cột thu hồi/khoá/lần dùng đổi; thu hồi không gỡ được.
CREATE FUNCTION app.guest_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','last_used_at','failed_attempts','locked_at','updated_at','version'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','last_used_at','failed_attempts','locked_at','updated_at','version']) THEN
    RAISE EXCEPTION 'link khách %: chỉ đổi thu hồi/khoá', OLD.id USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'link khách % đã thu hồi', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guest_links_guard BEFORE UPDATE ON guest_access_links FOR EACH ROW EXECUTE FUNCTION app.guest_link_guard();

ALTER TABLE guest_access_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_access_links FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_links_read ON guest_access_links FOR SELECT TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id));
CREATE POLICY guest_links_insert ON guest_access_links FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id)
              AND created_by = nullif(current_setting('app.actor_id', true), '')::uuid);
CREATE POLICY guest_links_update ON guest_access_links FOR UPDATE TO app_runtime
  USING (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id))
  WITH CHECK (organization_id = app.current_org() AND app.actor_role() IN ('owner','manager','front_desk') AND app.actor_can_see_property(property_id));
GRANT SELECT, INSERT, UPDATE ON guest_access_links TO app_runtime;

-- Giới hạn theo IP (băm SHA-256, cửa sổ 1 phút).
CREATE TABLE guest_link_rate (
  ip_hash bytea NOT NULL CHECK (octet_length(ip_hash) = 32),
  window_start timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
REVOKE ALL ON guest_link_rate FROM PUBLIC;

-- Ghi một lần thất bại của IP và trả số lần thất bại trong cửa sổ hiện tại; p_record=false chỉ đọc.
CREATE FUNCTION app.guest_link_rate(p_ip_hash bytea, p_now timestamptz, p_record boolean) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w timestamptz := date_trunc('minute', p_now); n integer;
BEGIN
  IF p_record THEN
    INSERT INTO guest_link_rate (ip_hash, window_start, failures) VALUES (p_ip_hash, w, 1)
    ON CONFLICT (ip_hash, window_start) DO UPDATE SET failures = guest_link_rate.failures + 1
    RETURNING failures INTO n;
    DELETE FROM guest_link_rate WHERE window_start < w - interval '10 minutes';
    RETURN n;
  END IF;
  SELECT failures INTO n FROM guest_link_rate WHERE ip_hash = p_ip_hash AND window_start = w;
  RETURN coalesce(n, 0);
END $$;

-- Tra link theo băm token (trước khi có ngữ cảnh tổ chức). Trả kèm 4 số cuối SĐT người đặt để kiểm bước hai ở app.
CREATE FUNCTION app.resolve_guest_link(p_hash bytea)
  RETURNS TABLE (id uuid, organization_id uuid, property_id uuid, stay_id uuid, reservation_id uuid, expires_at timestamptz,
                 revoked_at timestamptz, locked_at timestamptz, failed_attempts integer, phone_last4 text,
                 second_factor boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT g.id, g.organization_id, g.property_id, coalesce(g.stay_id, s.id), coalesce(g.reservation_id, ri.reservation_id),
           g.expires_at, g.revoked_at, g.locked_at, g.failed_attempts,
           right(regexp_replace(coalesce(bp.phone, ''), '[^0-9]', '', 'g'), 4),
           coalesce((p.settings ->> 'guest_link_second_factor')::boolean, true)
    FROM guest_access_links g
    JOIN properties p ON p.organization_id = g.organization_id AND p.id = g.property_id
    LEFT JOIN stays s0 ON s0.organization_id = g.organization_id AND s0.id = g.stay_id
    LEFT JOIN reservation_items ri ON ri.organization_id = g.organization_id
         AND (ri.id = s0.reservation_item_id OR (g.reservation_id IS NOT NULL AND ri.reservation_id = g.reservation_id))
    LEFT JOIN stays s ON s.organization_id = ri.organization_id AND s.reservation_item_id = ri.id
    LEFT JOIN reservations r ON r.organization_id = ri.organization_id AND r.id = ri.reservation_id
    LEFT JOIN persons bp ON bp.organization_id = r.organization_id AND bp.id = r.booker_person_id
    WHERE g.token_hash = p_hash
    LIMIT 1
  $$;

-- Kết quả bước hai: sai → +1 (đủ 5 thì khoá); đúng → ghi lần dùng.
CREATE FUNCTION app.guest_link_attempt(p_id uuid, p_ok boolean, p_now timestamptz) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE locked boolean;
BEGIN
  IF p_ok THEN
    UPDATE guest_access_links SET last_used_at = p_now WHERE id = p_id;
    RETURN false;
  END IF;
  UPDATE guest_access_links SET failed_attempts = failed_attempts + 1,
         locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN coalesce(locked_at, p_now) ELSE locked_at END
   WHERE id = p_id RETURNING locked_at IS NOT NULL INTO locked;
  RETURN coalesce(locked, false);
END $$;

-- Dữ liệu khách được xem: lượt ở + folio của đúng link (đã kiểm token/bước hai ở app).
CREATE FUNCTION app.guest_stay_view(p_link uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH g AS (SELECT * FROM app.resolve_guest_link((SELECT token_hash FROM guest_access_links WHERE id = p_link))),
    st AS (
      SELECT s.id, s.status, s.organization_id, ri.arrival_date, ri.departure_date, u.code AS unit_code, r.number, r.id AS reservation_id,
             r.booker_person_id, s.property_id
      FROM g JOIN stays s ON s.organization_id = g.organization_id AND s.id = g.stay_id
      JOIN reservation_items ri ON ri.organization_id = s.organization_id AND ri.id = s.reservation_item_id
      JOIN reservations r ON r.organization_id = ri.organization_id AND r.id = ri.reservation_id
      JOIN units u ON u.organization_id = s.organization_id AND u.id = s.unit_id
    )
    SELECT jsonb_build_object(
      'stay', jsonb_build_object('id', st.id, 'status', st.status, 'arrivalDate', st.arrival_date, 'departureDate', st.departure_date,
                                 'unitCode', st.unit_code, 'reservationNumber', st.number),
      'charges', coalesce((SELECT jsonb_agg(jsonb_build_object('description', c.description, 'businessDate', c.business_date,
                                                               'amount', c.amount) ORDER BY c.business_date, c.created_at)
                           FROM charges c WHERE c.organization_id = st.organization_id AND c.stay_id = st.id AND c.voided_at IS NULL), '[]'),
      'invoice', (SELECT jsonb_build_object('total', i.total, 'allocated', i.allocated_total) FROM invoices i
                  WHERE i.organization_id = st.organization_id AND i.stay_id = st.id AND i.kind = 'folio' LIMIT 1),
      'advancePaid', coalesce((SELECT sum(least(p.amount - p.allocated_total,
                                                greatest(0, (SELECT coalesce(sum(jl.credit - jl.debit), 0) FROM journal_lines jl
                                                             WHERE jl.organization_id = st.organization_id AND jl.account = 'CUSTOMER_CREDIT'
                                                               AND jl.person_id = p.payer_person_id AND jl.property_id = st.property_id))))
                               FROM payments p WHERE p.organization_id = st.organization_id AND p.reservation_id = st.reservation_id
                                 AND p.purpose = 'receivable' AND p.status = 'confirmed'), 0))
    FROM st
  $$;

REVOKE ALL ON FUNCTION app.guest_link_rate(bytea, timestamptz, boolean), app.resolve_guest_link(bytea),
  app.guest_link_attempt(uuid, boolean, timestamptz), app.guest_stay_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.guest_link_rate(bytea, timestamptz, boolean), app.resolve_guest_link(bytea),
  app.guest_link_attempt(uuid, boolean, timestamptz), app.guest_stay_view(uuid) TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.guest_stay_view(uuid);
DROP FUNCTION IF EXISTS app.guest_link_attempt(uuid, boolean, timestamptz);
DROP FUNCTION IF EXISTS app.resolve_guest_link(bytea);
DROP FUNCTION IF EXISTS app.guest_link_rate(bytea, timestamptz, boolean);
DROP TABLE IF EXISTS guest_link_rate;
DROP TABLE IF EXISTS guest_access_links;
DROP FUNCTION IF EXISTS app.guest_link_guard();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
