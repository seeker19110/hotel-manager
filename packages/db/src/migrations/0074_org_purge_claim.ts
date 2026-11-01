// T-2403 (D-134): claim purge bền TRƯỚC khi xoá object. Huỷ và claim dùng cùng khoá hàng organizations;
// huỷ thắng trước claim thì worker không xoá, claim thắng thì không còn huỷ (kể cả lỗi kho giữa chừng, lượt sau thử lại).
// Không giữ transaction qua network. Runtime không tự đặt/gỡ purge_started_at; claim chỉ cấp cho app_worker.
// org_purge_file_keys cũng claim để bảo vệ worker N-1 trong triển khai cuốn chiếu. Purge SQL trực tiếp vẫn nguyên:
// nó khoá tổ chức và xoá trong một transaction, không có khe network trước khi khoá.
// Down chặn khi còn claim: xoá cờ lúc object có thể đã mất sẽ mở lại cửa huỷ không an toàn.
import { type Kysely, sql } from "kysely";

const guard = (claim: boolean) => `
CREATE OR REPLACE FUNCTION app.organizations_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.status, NEW.deletion_requested_at, NEW.deletion_due_at, NEW.deletion_requested_by${claim ? ", NEW.purge_started_at" : ""})
       IS DISTINCT FROM (OLD.status, OLD.deletion_requested_at, OLD.deletion_due_at, OLD.deletion_requested_by${claim ? ", OLD.purge_started_at" : ""})
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations lifecycle changes only via authorized definer functions'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.plan change only by the table owner (docs/ops/runbooks/plan-change.md)'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;`;

const cancel = (claim: boolean) => `
CREATE OR REPLACE FUNCTION app.org_cancel_deletion(p_correlation text) RETURNS boolean
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
  IF o.status <> 'pending_deletion'${claim ? " OR o.purge_started_at IS NOT NULL" : ""} THEN
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
END $$;`;

const UP = `
ALTER TABLE organizations ADD COLUMN purge_started_at timestamptz;
ALTER TABLE organizations ADD CONSTRAINT ck_organizations_purge_claim CHECK (
  purge_started_at IS NULL OR (status = 'pending_deletion' AND purge_started_at >= deletion_due_at));
${guard(true)}
${cancel(true)}

CREATE FUNCTION app.organizations_purge_claim_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.purge_started_at IS NOT NULL
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'organizations.purge_started_at may only be set by the purge claim function'
      USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.organizations_purge_claim_insert_guard() FROM PUBLIC;
CREATE TRIGGER trg_organizations_purge_claim_insert BEFORE INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.organizations_purge_claim_insert_guard();

CREATE FUNCTION app.files_org_purge_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_started timestamptz;
BEGIN
  -- The migration/table owner may seed/repair directly; application roles keep tenant-scoped invoker permissions.
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.files'::regclass) THEN
    RETURN NEW;
  END IF;
  SELECT o.purge_started_at INTO v_started FROM organizations o
    WHERE o.id = NEW.organization_id AND o.id = app.current_org() FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file organization is unavailable' USING ERRCODE = '23503';
  END IF;
  IF v_started IS NOT NULL THEN
    RAISE EXCEPTION 'organization purge has started' USING ERRCODE = '42501', HINT = 'FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.files_org_purge_insert_guard() FROM PUBLIC;
CREATE TRIGGER trg_files_org_purge_insert BEFORE INSERT ON files
  FOR EACH ROW EXECUTE FUNCTION app.files_org_purge_insert_guard();

CREATE FUNCTION app.claim_org_purge(p_org uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
DECLARE o organizations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM organizations x WHERE x.id = p_org FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending_deletion' OR o.deletion_due_at > now() THEN
    RETURN false;
  END IF;
  IF o.purge_started_at IS NOT NULL THEN RETURN true; END IF;
  UPDATE organizations SET purge_started_at = now(), version = version + 1 WHERE id = p_org;
  INSERT INTO audit_events (id, organization_id, actor_type, action, entity_type, entity_id, after, correlation_id)
  VALUES (gen_random_uuid(), p_org, 'worker', 'organization.purge_started', 'organization', p_org,
          jsonb_build_object('due_at', o.deletion_due_at, 'started_at', now()), 'org-purge');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.claim_org_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_org_purge(uuid) TO app_worker;

CREATE OR REPLACE FUNCTION app.org_purge_file_keys(p_org uuid) RETURNS TABLE (storage_key text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
BEGIN
  -- Also protect a worker N-1 which lists keys without calling claim_org_purge explicitly.
  IF NOT app.claim_org_purge(p_org) THEN RETURN; END IF;
  -- A PUT which staged before the claim must finish (or be closed by retention) before ANY object is removed.
  -- No age-based override here: pending_scan means the upload may still be in flight.
  IF EXISTS (SELECT 1 FROM files f WHERE f.organization_id = p_org AND f.status = 'pending_scan') THEN RETURN; END IF;
  RETURN QUERY SELECT f.storage_key FROM files f WHERE f.organization_id = p_org ORDER BY f.storage_key;
END $$;
`;

const DOWN = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE purge_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back purge claim while a claimed organization exists; finish purge first';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION app.org_purge_file_keys(p_org uuid) RETURNS TABLE (storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET timezone = 'UTC' AS $$
    SELECT f.storage_key FROM files f JOIN organizations o ON o.id = f.organization_id
     WHERE f.organization_id = p_org AND o.status = 'pending_deletion' AND o.deletion_due_at <= now()
     ORDER BY f.storage_key
  $$;
DROP FUNCTION app.claim_org_purge(uuid);
DROP TRIGGER trg_files_org_purge_insert ON files;
DROP FUNCTION app.files_org_purge_insert_guard();
DROP TRIGGER trg_organizations_purge_claim_insert ON organizations;
DROP FUNCTION app.organizations_purge_claim_insert_guard();
${cancel(false)}
${guard(false)}
ALTER TABLE organizations DROP CONSTRAINT ck_organizations_purge_claim;
ALTER TABLE organizations DROP COLUMN purge_started_at;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
