// T-005 — tenancy: tổ chức, cơ sở, tầng, loại phòng, phòng, cá nhân, thành viên, phạm vi, lời mời.
// Nguồn: docs/design/ERD.md §1 (quy ước), các mục bảng tương ứng; DOMAIN-MODEL INV-G1/G2/G7.
// Migration đã áp trên môi trường chung KHÔNG được sửa — sửa bằng migration mới.
import { type Kysely, sql } from "kysely";

export const TENANT_TABLES = [
  "properties",
  "floors",
  "room_types",
  "units",
  "persons",
  "memberships",
  "property_scopes",
  "invitations",
] as const;

const UP = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app;

-- Ngữ cảnh tổ chức của phiên: thiếu thì lỗi (đóng an toàn — ERD §1 RLS lớp 1).
-- Chưa đặt (phiên mới) hoặc rỗng (phiên trong pool sau SET LOCAL của transaction trước) đều ném lỗi.
CREATE FUNCTION app.current_org() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.org_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.org_id chưa đặt — thiếu ngữ cảnh tổ chức' USING ERRCODE = '42501', HINT = 'TENANT_CONTEXT_MISSING';
  END IF;
  RETURN v::uuid;
END $$;

CREATE FUNCTION app.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE FUNCTION app.check_timezone() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) OR NEW.timezone !~ '/' THEN
    RAISE EXCEPTION 'timezone không hợp lệ: %', NEW.timezone USING ERRCODE = '22023', HINT = 'VALIDATION_FAILED';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE properties (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  template text NOT NULL CHECK (template IN ('rental','hotel','mixed')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  business_day_cutoff time NOT NULL DEFAULT '00:00',
  currency char(3) NOT NULL DEFAULT 'VND' CHECK (currency = upper(currency)),
  check_in_time time,
  check_out_time time,
  lease_hold_ttl_hours integer NOT NULL DEFAULT 48 CHECK (lease_hold_ttl_hours > 0),
  hold_ttl_minutes integer NOT NULL DEFAULT 15 CHECK (hold_ttl_minutes > 0),
  overstay_grace_minutes integer NOT NULL DEFAULT 60 CHECK (overstay_grace_minutes >= 0),
  require_inspected boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  counters jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counters) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_properties_org_id UNIQUE (organization_id, id)
);
CREATE INDEX ix_properties_org_archived ON properties (organization_id, archived_at);
CREATE TRIGGER trg_properties_timezone BEFORE INSERT OR UPDATE OF timezone ON properties
  FOR EACH ROW EXECUTE FUNCTION app.check_timezone();

CREATE TABLE floors (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_floors_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_floors_properties FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id)
);
CREATE UNIQUE INDEX uq_floors_name ON floors (organization_id, property_id, name) WHERE archived_at IS NULL;

CREATE TABLE room_types (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 20),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  capacity integer NOT NULL CHECK (capacity >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_room_types_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT fk_room_types_properties FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id)
);
CREATE UNIQUE INDEX uq_room_types_code ON room_types (organization_id, property_id, code) WHERE archived_at IS NULL;

CREATE TABLE units (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  floor_id uuid NOT NULL,
  room_type_id uuid,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 20),
  kind text NOT NULL DEFAULT 'whole' CHECK (kind = 'whole'),
  parent_unit_id uuid CHECK (parent_unit_id IS NULL),
  housekeeping_status text NOT NULL DEFAULT 'clean'
    CHECK (housekeeping_status IN ('dirty','assigned','cleaning','clean','inspected')),
  availability text NOT NULL DEFAULT 'active' CHECK (availability IN ('active','out_of_service')),
  availability_reason text CHECK (availability = 'active' OR availability_reason IS NOT NULL),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_units_org_prop_id UNIQUE (organization_id, property_id, id),
  CONSTRAINT uq_units_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_units_properties FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_units_floors FOREIGN KEY (organization_id, property_id, floor_id)
    REFERENCES floors (organization_id, property_id, id),
  CONSTRAINT fk_units_room_types FOREIGN KEY (organization_id, property_id, room_type_id)
    REFERENCES room_types (organization_id, property_id, id),
  CONSTRAINT fk_units_parent FOREIGN KEY (organization_id, property_id, parent_unit_id)
    REFERENCES units (organization_id, property_id, id)
);
CREATE UNIQUE INDEX uq_units_code ON units (organization_id, property_id, lower(btrim(code))) WHERE archived_at IS NULL;
CREATE INDEX ix_units_floor ON units (organization_id, property_id, floor_id);

CREATE TABLE persons (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  phone text CHECK (phone ~ '^\\+?[0-9 .()-]{6,20}$'),
  email text CHECK (email = lower(btrim(email))),
  address text,
  nationality char(2) CHECK (nationality = upper(nationality)),
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_persons_org_id UNIQUE (organization_id, id)
);
CREATE INDEX ix_persons_phone ON persons (organization_id, phone);
CREATE INDEX ix_persons_email ON persons (organization_id, lower(email));

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  auth_user_id uuid,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','manager','front_desk','accountant','housekeeping','maintenance',
                                     'tenant','guest','platform_support')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  limits jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limits) = 'object'),
  all_properties boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_memberships_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_memberships_persons FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_memberships_valid CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_memberships_support_temporary CHECK (role <> 'platform_support' OR valid_to IS NOT NULL),
  CONSTRAINT ck_memberships_all_properties CHECK (NOT all_properties OR role IN ('owner','accountant')),
  CONSTRAINT ck_memberships_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_memberships_user ON memberships (organization_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL AND status IN ('invited','active','suspended');
CREATE UNIQUE INDEX uq_memberships_person ON memberships (organization_id, person_id)
  WHERE status IN ('invited','active','suspended');
CREATE INDEX ix_memberships_auth_user ON memberships (auth_user_id);

-- Tổ chức luôn còn ít nhất một owner active (LAST_OWNER), kiểm lúc commit.
CREATE FUNCTION app.check_last_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = org AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'tổ chức % không còn owner active', org USING ERRCODE = '23514', HINT = 'LAST_OWNER';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_memberships_last_owner AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'owner' AND OLD.status = 'active')
  EXECUTE FUNCTION app.check_last_owner();

CREATE TABLE property_scopes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  property_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_scopes UNIQUE (organization_id, membership_id, property_id),
  CONSTRAINT fk_property_scopes_memberships FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_property_scopes_properties FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id)
);
CREATE INDEX ix_property_scopes_property ON property_scopes (organization_id, property_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  role text NOT NULL CHECK (role IN ('owner','manager','front_desk','accountant','housekeeping','maintenance','tenant')),
  property_ids uuid[] NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limits) = 'object'),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  invited_by uuid NOT NULL,
  person_id uuid,
  membership_id uuid,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_invitations_token UNIQUE (token_hash),
  CONSTRAINT fk_invitations_invited_by FOREIGN KEY (organization_id, invited_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_invitations_person FOREIGN KEY (organization_id, person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT fk_invitations_membership FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_invitations_accepted CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_invitations_pending ON invitations (organization_id, lower(email), role) WHERE status = 'pending';

-- updated_at/version cho bảng loại M/C.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','properties','floors','room_types','units','persons','memberships','invitations'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t);
  END LOOP;
END $$;

-- RLS lớp 1 (tenant): ENABLE + FORCE + policy USING/WITH CHECK (DB-SEC-007, INV-G1).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (id = app.current_org()) WITH CHECK (id = app.current_org());
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['properties','floors','room_types','units','persons','memberships','property_scopes','invitations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_org()) '
                   'WITH CHECK (organization_id = app.current_org())', t);
  END LOOP;
END $$;
-- Bước chọn tổ chức (chưa có app.org_id): chỉ ĐỌC membership của chính mình qua app.auth_user_id (missing_ok).
CREATE POLICY own_memberships_select ON memberships FOR SELECT
  USING (auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid);

-- Quyền cho role ứng dụng (bootstrap-roles.sql tạo role). Không owner, không BYPASSRLS.
GRANT USAGE ON SCHEMA app TO app_runtime, app_worker;
GRANT EXECUTE ON FUNCTION app.current_org() TO app_runtime, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, properties, floors, room_types, units, persons, memberships, invitations
  TO app_runtime, app_worker;
GRANT SELECT, INSERT, DELETE ON property_scopes TO app_runtime, app_worker;
`;

const DOWN = `
DROP TABLE IF EXISTS invitations, property_scopes, memberships, persons, units, room_types, floors, properties, organizations;
DROP FUNCTION IF EXISTS app.check_last_owner();
DROP FUNCTION IF EXISTS app.check_timezone();
DROP FUNCTION IF EXISTS app.set_updated_at();
DROP FUNCTION IF EXISTS app.current_org();
DROP SCHEMA IF EXISTS app;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
