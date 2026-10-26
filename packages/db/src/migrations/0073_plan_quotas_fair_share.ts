// T-2314 (D-130; IND-SAAS-008) — hạn mức theo gói + fair-share relay outbox theo tổ chức.
// - `organizations.plan` (text, mặc định 'pilot', CHECK `ck_organizations_plan` theo danh mục `packages/app/src/plans/catalog.ts`).
//   Chỉ role sở hữu bảng đổi được (thao tác owner CSDL có audit — RUNBOOK): `trg_organizations_lifecycle_guard` (0070) mở rộng sang
//   cột `plan` (app_runtime có UPDATE cả bảng cho `settings`).
// - `app.plan_limits(plan)`: bản sao hạn mức TÀI NGUYÊN của danh mục (NULL ⇒ mọi gói); test `plans.db.test.ts` so khớp với mã.
// - Cưỡng chế ở CSDL (một chỗ cho mọi đường ghi: lệnh, nhập liệu hàng loạt, hàm SQL, seed): trigger BEFORE `app.enforce_plan_quota`
//   trên `properties`/`units` (chưa lưu trữ), `memberships` (nhân viên active — trừ tenant/platform_support), `invitations` (lời mời
//   nhân viên chờ: tính cả lời mời chờ chưa hết hạn), `files` (tổng byte pending_scan/ready, trừ export_job). Vượt ⇒ RAISE 23514 +
//   HINT QUOTA_EXCEEDED ⇒ app trả 409 QUOTA_EXCEEDED. Chống race: `pg_advisory_xact_lock` theo (loại, tổ chức) TRƯỚC khi đếm —
//   READ COMMITTED: câu đếm sau khi có khoá thấy hàng của giao dịch trước đã commit ⇒ hai lệnh song song không vượt trần. Không
//   khoá hàng `organizations` (FOR UPDATE xung đột với KEY SHARE của mọi FK tới tổ chức ⇒ chặn/deadlock ghi khác của tổ chức).
//   Hạn mức CON cho file do người dùng cổng (`tenant`/`guest` — người thuê, khách lưu trú; D-132) tải: tổng của mọi người dùng cổng
//   ≤ `max_portal_storage_bytes` (2% trần tổ chức) VÀ mỗi membership cổng ≤ `max_portal_storage_bytes_per_member` (200 MiB) — cùng
//   khoá advisory `storage` ⇒ người thuê không làm đầy dung lượng tổ chức để chặn tải lên của nhân viên. Người tải = membership của
//   `files.uploaded_by` (RLS 0047 ép người dùng cổng ghi `uploaded_by` = chính mình).
// - `organizations.plan` khi INSERT: chỉ owner CSDL được chọn khác gói mặc định (`trg_organizations_plan_insert` ⇒ 42501) — app_runtime
//   tạo tổ chức (`org.create`) luôn nhận gói mặc định. `app.invitation_by_token` trả thêm `plan` của tổ chức (actor dựng tay khi nhận
//   lời mời mang gói thật ⇒ hạn mức tần suất đúng gói).
// - Fair-share relay: `app.outbox_claim(p_limit, p_per_org)` (HÀM MỚI, không DEFAULT) — (1) vòng tròn: mỗi tổ chức có việc được ƯU TIÊN tối đa
//   `p_per_org` hàng cũ nhất, thứ tự (vòng, created_at) ⇒ tổ chức A dồn hàng chục nghìn sự kiện không chặn sự kiện của B (B vào ngay
//   lượt đầu); (2) LẤP ĐẦY phần còn lại của `p_limit` bằng các hàng đến hạn kế tiếp theo thứ tự cũ (created_at, id) ⇒ tổ chức đơn lẻ
//   vẫn xả đủ lô (per_org là mức ưu tiên, không phải trần cứng — D-132). Trong một tổ chức luôn là tiền tố liên tục theo
//   (created_at, id), trả về sau phần vòng tròn ⇒ relay gửi job đúng thứ tự trong tổ chức. Điều kiện tổ chức active/`export.requested`
//   của 0071 giữ nguyên. Index `ix_outbox_unpublished_org` cho truy vấn theo tổ chức; bước lấp dùng `ix_outbox_unpublished` như 0071.
// GIỚI HẠN đã biết (review D-132, ghi nhận, không đổi thiết kế — docs/ops/runbooks/plan-change.md §Giới hạn):
// - Trigger đếm lại mỗi HÀNG ⇒ một câu/lô nhập n hàng tốn O(n²) hàng đọc (đếm qua index; nhập 20.000 phòng là trường hợp xấu nhất);
//   khoá advisory (loại, tổ chức) giữ tới HẾT giao dịch ⇒ giao dịch dài (nhập lớn) chặn ghi cùng loại khác của tổ chức tới khi xong.
// - Lời mời nhân viên chờ chiếm chỗ khi MỜI (`invitations`), còn membership chỉ đếm membership active ⇒ không đối xứng: nhận lời mời
//   khi đã đầy bị chặn dù lời mời đã giữ chỗ; lời mời hết hạn tự nhả chỗ.
// - `due_orgs` của outbox_claim gom theo tổ chức trên MỌI hàng đến hạn (quét backlog qua index một phần) — chi phí tăng theo backlog
//   toàn hệ; đo ở relay-fair-share.db.test.ts (10.000 hàng < 2 s) và db-perf.
// TƯƠNG THÍCH NGƯỢC (expand → contract, OPS-DEPLOY-003, job `schema-compat`): `app.outbox_claim(integer)` của 0071 GIỮ NGUYÊN — worker
//   bản N−1 (gọi một tham số) vẫn chạy đúng trên schema này trong lúc triển khai cuốn chiếu (claim theo thứ tự cũ, chưa fair-share).
//   Hàm hai tham số KHÔNG có DEFAULT: có DEFAULT thì lời gọi một tham số mơ hồ giữa hai hàm (42725). Worker N luôn truyền đủ hai.
//   Bước contract (migration sau, khi không còn worker N−1): DROP `app.outbox_claim(integer)`.
// DOWN: gỡ trigger/hàm/index/cột, khôi phục guard 0070, `invitation_by_token` của 0062; `outbox_claim(integer)` của 0071 chưa bị đụng.
import { type Kysely, sql } from "kysely";

const PASS = (o: string) => `
        AND (${o}.event_type = 'export.requested'
             OR EXISTS (SELECT 1 FROM organizations og WHERE og.id = ${o}.organization_id AND og.status = 'active'))`;

const GUARD = (withPlan: boolean) => `
CREATE OR REPLACE FUNCTION app.organizations_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.status, NEW.deletion_requested_at, NEW.deletion_due_at, NEW.deletion_requested_by)
       IS DISTINCT FROM (OLD.status, OLD.deletion_requested_at, OLD.deletion_due_at, OLD.deletion_requested_by)
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.status/deletion_* change only via app.org_request_deletion/app.org_cancel_deletion'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;${
    withPlan
      ? `
  IF NEW.plan IS DISTINCT FROM OLD.plan
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.plan change only by the table owner (docs/ops/runbooks/plan-change.md)'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;`
      : ""
  }
  RETURN NEW;
END $$;`;

// 0062 version (withPlan = false) is restored on DOWN. Return type changes ⇒ DROP + CREATE (same signature, grants re-applied).
const INVITATION_BY_TOKEN = (withPlan: boolean) => `
DROP FUNCTION app.invitation_by_token(bytea);
CREATE FUNCTION app.invitation_by_token(p_token_hash bytea)
  RETURNS TABLE (organization_id uuid, id uuid, email text, role text, status text, expires_at timestamptz${withPlan ? ", plan text" : ""})
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    ${
      withPlan
        ? `SELECT i.organization_id, i.id, i.email, i.role, i.status, i.expires_at,
           (SELECT o.plan FROM organizations o WHERE o.id = i.organization_id) AS plan
    FROM invitations i WHERE i.token_hash = p_token_hash`
        : "SELECT i.organization_id, i.id, i.email, i.role, i.status, i.expires_at FROM invitations i WHERE i.token_hash = p_token_hash"
    }
  $$;
REVOKE ALL ON FUNCTION app.invitation_by_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_by_token(bytea) TO app_runtime;`;

const UP = `
ALTER TABLE organizations ADD COLUMN plan text NOT NULL DEFAULT 'pilot';
ALTER TABLE organizations ADD CONSTRAINT ck_organizations_plan CHECK (plan IN ('pilot'));
${GUARD(true)}

CREATE FUNCTION app.plan_limits(p_plan text)
  RETURNS TABLE (plan text, max_properties integer, max_units integer, max_active_members integer, max_storage_bytes bigint,
                 max_portal_storage_bytes bigint, max_portal_storage_bytes_per_member bigint)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.plan, v.max_properties, v.max_units, v.max_active_members, v.max_storage_bytes, v.max_portal_storage_bytes,
           v.max_portal_storage_bytes_per_member
    FROM (VALUES ('pilot'::text, 50, 20000, 200, 53687091200::bigint, 1073741824::bigint, 209715200::bigint))
         AS v (plan, max_properties, max_units, max_active_members, max_storage_bytes, max_portal_storage_bytes,
               max_portal_storage_bytes_per_member)
    WHERE p_plan IS NULL OR v.plan = p_plan
    ORDER BY v.plan
  $$;
REVOKE ALL ON FUNCTION app.plan_limits(text) FROM PUBLIC;

CREATE FUNCTION app.enforce_plan_quota() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text := TG_ARGV[0];
  v_plan text;
  v_limit bigint;
  v_used bigint;
  v_add bigint := 1;
  v_uploader_role text;
  v_portal_limit bigint;
  v_member_limit bigint;
  v_portal_used bigint;
  v_member_used bigint;
BEGIN
  -- Does the new/changed row INCREASE usage? If not, skip (no lock).
  IF v_kind IN ('properties', 'units') THEN
    IF NEW.archived_at IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.archived_at IS NULL) THEN RETURN NEW; END IF;
  ELSIF v_kind = 'members' AND TG_TABLE_NAME = 'memberships' THEN
    IF NOT (NEW.status = 'active' AND NEW.role NOT IN ('tenant', 'platform_support'))
       OR (TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.role NOT IN ('tenant', 'platform_support')) THEN
      RETURN NEW;
    END IF;
  ELSIF v_kind = 'members' THEN
    IF NEW.status <> 'pending' OR NEW.role IN ('tenant', 'platform_support') THEN RETURN NEW; END IF;
  ELSIF v_kind = 'storage' THEN
    IF NEW.status NOT IN ('pending_scan', 'ready') OR NEW.owner_type = 'export_job' THEN RETURN NEW; END IF;
    -- Staging replay (INSERT ... ON CONFLICT DO NOTHING, same id): row already counted.
    IF EXISTS (SELECT 1 FROM files f WHERE f.id = NEW.id) THEN RETURN NEW; END IF;
    v_add := NEW.size_bytes;
    IF NEW.uploaded_by IS NOT NULL THEN
      SELECT m.role INTO v_uploader_role FROM memberships m
       WHERE m.organization_id = NEW.organization_id AND m.id = NEW.uploaded_by;
    END IF;
  ELSE
    RAISE EXCEPTION 'app.enforce_plan_quota: unknown quota kind %', v_kind;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('plan_quota:' || v_kind || ':' || NEW.organization_id::text, 0));
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = NEW.organization_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- the FK reports the proper error afterwards.
  SELECT CASE v_kind WHEN 'properties' THEN l.max_properties WHEN 'units' THEN l.max_units
                     WHEN 'members' THEN l.max_active_members ELSE l.max_storage_bytes END
    INTO v_limit FROM app.plan_limits(v_plan) l;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'plan % missing from app.plan_limits', v_plan;
  END IF;

  -- NEW is not counted yet: BEFORE INSERT row is not in the table; UPDATE only gets here when OLD was not counted.
  -- Counts use indexes (uq_units_code / ix_properties_org_archived cover non-archived rows).
  IF v_kind = 'properties' THEN
    SELECT count(*) INTO v_used FROM properties p
     WHERE p.organization_id = NEW.organization_id AND p.archived_at IS NULL;
  ELSIF v_kind = 'units' THEN
    SELECT count(*) INTO v_used FROM units u
     WHERE u.organization_id = NEW.organization_id AND u.archived_at IS NULL;
  ELSIF v_kind = 'members' THEN
    SELECT count(*) INTO v_used FROM memberships m
     WHERE m.organization_id = NEW.organization_id AND m.status = 'active'
       AND m.role NOT IN ('tenant', 'platform_support');
    IF TG_TABLE_NAME = 'invitations' THEN
      v_used := v_used + (SELECT count(*) FROM invitations i
                           WHERE i.organization_id = NEW.organization_id AND i.status = 'pending' AND i.expires_at > now()
                             AND i.role NOT IN ('tenant', 'platform_support'));
    END IF;
  ELSE
    SELECT coalesce(sum(f.size_bytes), 0) INTO v_used FROM files f
     WHERE f.organization_id = NEW.organization_id AND f.status IN ('pending_scan', 'ready') AND f.owner_type <> 'export_job';
  END IF;

  IF v_used + v_add > v_limit THEN
    RAISE EXCEPTION 'plan quota exceeded: % (plan %, limit %, used %)', v_kind, v_plan, v_limit, v_used
      USING ERRCODE = '23514', HINT = 'QUOTA_EXCEEDED';
  END IF;

  -- Portal sub-quota (D-132): files uploaded by tenant/guest memberships, under the same storage lock.
  IF v_kind = 'storage' AND v_uploader_role IN ('tenant', 'guest') THEN
    SELECT l.max_portal_storage_bytes, l.max_portal_storage_bytes_per_member INTO v_portal_limit, v_member_limit
      FROM app.plan_limits(v_plan) l;
    SELECT coalesce(sum(f.size_bytes), 0),
           coalesce(sum(f.size_bytes) FILTER (WHERE f.uploaded_by = NEW.uploaded_by), 0)
      INTO v_portal_used, v_member_used
      FROM files f JOIN memberships m ON m.organization_id = f.organization_id AND m.id = f.uploaded_by
     WHERE f.organization_id = NEW.organization_id AND f.status IN ('pending_scan', 'ready') AND f.owner_type <> 'export_job'
       AND m.role IN ('tenant', 'guest');
    IF v_member_used + v_add > v_member_limit THEN
      RAISE EXCEPTION 'plan quota exceeded: storage_portal_member (plan %, limit %, used %)', v_plan, v_member_limit, v_member_used
        USING ERRCODE = '23514', HINT = 'QUOTA_EXCEEDED';
    END IF;
    IF v_portal_used + v_add > v_portal_limit THEN
      RAISE EXCEPTION 'plan quota exceeded: storage_portal (plan %, limit %, used %)', v_plan, v_portal_limit, v_portal_used
        USING ERRCODE = '23514', HINT = 'QUOTA_EXCEEDED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.enforce_plan_quota() FROM PUBLIC;

CREATE TRIGGER trg_properties_plan_quota BEFORE INSERT OR UPDATE OF archived_at ON properties
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('properties');
CREATE TRIGGER trg_units_plan_quota BEFORE INSERT OR UPDATE OF archived_at ON units
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('units');
CREATE TRIGGER trg_memberships_plan_quota BEFORE INSERT OR UPDATE OF status, role ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('members');
CREATE TRIGGER trg_invitations_plan_quota BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('members');
CREATE TRIGGER trg_files_plan_quota BEFORE INSERT ON files
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('storage');

-- Only the table owner may create an organization with a non-default plan (app_runtime has INSERT for org.create).
-- 'pilot' = column DEFAULT = DEFAULT_PLAN of plans/catalog.ts (plans.db.test.ts checks both).
CREATE FUNCTION app.organizations_plan_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM 'pilot'
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.plan is chosen only by the table owner (docs/ops/runbooks/plan-change.md)'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.organizations_plan_insert_guard() FROM PUBLIC;
CREATE TRIGGER trg_organizations_plan_insert BEFORE INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.organizations_plan_insert_guard();

${INVITATION_BY_TOKEN(true)}

CREATE INDEX ix_outbox_unpublished_org ON outbox (organization_id, created_at, id) WHERE published_at IS NULL;

CREATE FUNCTION app.outbox_claim(p_limit integer, p_per_org integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text,
                 traceparent text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due_orgs AS (
      SELECT o.organization_id FROM outbox o
      WHERE o.published_at IS NULL AND o.available_at <= now()${PASS("o")}
      GROUP BY o.organization_id
      ORDER BY min(o.created_at), o.organization_id
      LIMIT least(greatest(p_limit, 1), 1000)),
    locked AS (
      SELECT x.id, x.organization_id, x.created_at FROM due_orgs d
      CROSS JOIN LATERAL (
        SELECT o.id, o.organization_id, o.created_at FROM outbox o
        WHERE o.organization_id = d.organization_id AND o.published_at IS NULL AND o.available_at <= now()${PASS("o")}
        ORDER BY o.created_at, o.id
        LIMIT least(greatest(p_per_org, 1), greatest(p_limit, 1), 1000)
        FOR UPDATE SKIP LOCKED) x),
    rr AS (
      SELECT r.id, r.rn FROM (
        SELECT l.id, l.created_at,
               row_number() OVER (PARTITION BY l.organization_id ORDER BY l.created_at, l.id) AS rn
        FROM locked l) r
      ORDER BY r.rn, r.created_at, r.id
      LIMIT least(greatest(p_limit, 1), 1000)),
    fill AS (
      SELECT o.id FROM outbox o
      WHERE o.published_at IS NULL AND o.available_at <= now()${PASS("o")}
        AND NOT EXISTS (SELECT 1 FROM rr WHERE rr.id = o.id)
      ORDER BY o.created_at, o.id
      LIMIT greatest(least(greatest(p_limit, 1), 1000) - (SELECT count(*) FROM rr), 0)
      FOR UPDATE SKIP LOCKED),
    c AS (
      SELECT rr.id, rr.rn FROM rr
      UNION ALL
      SELECT fill.id, 1001::bigint FROM fill),
    u AS (
      UPDATE outbox o SET available_at = now() + interval '60 seconds'
      FROM c WHERE o.id = c.id
      RETURNING o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id, o.traceparent, o.created_at,
                c.rn)
    SELECT u.id, u.organization_id, u.event_type, u.aggregate_id, u.payload, u.correlation_id, u.traceparent
    FROM u ORDER BY u.rn, u.created_at, u.id
  $$;
REVOKE ALL ON FUNCTION app.outbox_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.outbox_claim(integer, integer);
DROP INDEX IF EXISTS ix_outbox_unpublished_org;
${INVITATION_BY_TOKEN(false)}
DROP TRIGGER IF EXISTS trg_organizations_plan_insert ON organizations;
DROP FUNCTION IF EXISTS app.organizations_plan_insert_guard();

DROP TRIGGER IF EXISTS trg_files_plan_quota ON files;
DROP TRIGGER IF EXISTS trg_invitations_plan_quota ON invitations;
DROP TRIGGER IF EXISTS trg_memberships_plan_quota ON memberships;
DROP TRIGGER IF EXISTS trg_units_plan_quota ON units;
DROP TRIGGER IF EXISTS trg_properties_plan_quota ON properties;
DROP FUNCTION IF EXISTS app.enforce_plan_quota();
DROP FUNCTION IF EXISTS app.plan_limits(text);
${GUARD(false)}
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS ck_organizations_plan;
ALTER TABLE organizations DROP COLUMN IF EXISTS plan;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
