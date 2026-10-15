// T-009 — lịch tài nguyên: allocations (INV-I1…I4), blocks, exceptions. Nguồn: ERD.md, DOMAIN-MODEL §3.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hold','lease','stay','block')),
  source_type text CHECK (source_type IN ('reservation_item','lease','stay','block')),
  source_id uuid,
  during tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  deactivated_at timestamptz,
  deactivated_reason text CHECK (deactivated_reason IN ('released','expired','cancelled','moved','ended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_allocations_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_allocations_units FOREIGN KEY (organization_id, property_id, unit_id)
    REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_allocations_created_by FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id),
  -- [start, end): không rỗng, có điểm đầu, gồm đầu, không gồm cuối (INV-I2).
  CONSTRAINT ck_allocations_during CHECK (NOT isempty(during) AND NOT lower_inf(during) AND lower_inc(during) AND NOT upper_inc(during)),
  -- Khoảng mở (không ngày kết thúc) chỉ cho hợp đồng.
  CONSTRAINT ck_allocations_open_end CHECK (NOT upper_inf(during) OR kind = 'lease'),
  CONSTRAINT ck_allocations_hold_expiry CHECK ((kind = 'hold') = (expires_at IS NOT NULL)),
  CONSTRAINT ck_allocations_deactivated CHECK (active OR deactivated_at IS NOT NULL),
  -- INV-I1: hai allocation active trên cùng phòng không chồng thời gian. KHÔNG dùng now() trong vị từ (INV-I3).
  CONSTRAINT ex_allocations_no_overlap EXCLUDE USING gist (organization_id WITH =, unit_id WITH =, during WITH &&)
    WHERE (active)
);
CREATE INDEX ix_allocations_hold_expiry ON allocations (expires_at) WHERE active AND kind = 'hold';
CREATE INDEX ix_allocations_unit ON allocations (organization_id, property_id, unit_id);
CREATE INDEX ix_allocations_during ON allocations USING gist (organization_id, property_id, during);

-- Mỗi allocation chỉ được nhả MỘT lần: không cho active false → true (INV-I3).
CREATE FUNCTION app.forbid_reactivation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active = false AND NEW.active = true THEN
    RAISE EXCEPTION 'allocation % đã nhả, không kích hoạt lại', OLD.id USING ERRCODE = '23514', HINT = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_allocations_no_reactivation BEFORE UPDATE OF active ON allocations
  FOR EACH ROW EXECUTE FUNCTION app.forbid_reactivation();
CREATE TRIGGER trg_allocations_updated BEFORE UPDATE ON allocations FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE blocks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 1),
  requested_by uuid NOT NULL,
  approved_by uuid,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','ended','rejected')),
  work_order_id uuid,
  approved_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_blocks_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_blocks_units FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
  CONSTRAINT fk_blocks_requested_by FOREIGN KEY (organization_id, requested_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_blocks_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_blocks_approved CHECK (status NOT IN ('approved','ended') OR approved_by IS NOT NULL),
  CONSTRAINT ck_blocks_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX ix_blocks_unit_status ON blocks (organization_id, property_id, unit_id, status);
CREATE TRIGGER trg_blocks_updated BEFORE UPDATE ON blocks FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Block approved ⇔ có allocation kind=block active trỏ về nó; ended ⇒ allocation đó đã nhả (kiểm lúc commit).
CREATE FUNCTION app.check_block_allocation() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM allocations
   WHERE organization_id = NEW.organization_id AND kind = 'block' AND source_id = NEW.id AND active;
  IF NEW.status = 'approved' AND n <> 1 THEN
    RAISE EXCEPTION 'block % approved nhưng không có đúng một allocation active', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('ended','rejected','requested') AND n <> 0 THEN
    RAISE EXCEPTION 'block % ở trạng thái % nhưng allocation vẫn active', NEW.id, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_blocks_allocation AFTER INSERT OR UPDATE ON blocks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_block_allocation();

CREATE TABLE exceptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('LEASE_OVERSTAY','STAY_OVERSTAY','RELOCATION_REQUIRED','EXTENSION_CONFLICT')),
  allocation_id uuid NOT NULL,
  related_allocation_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT fk_exceptions_properties FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_exceptions_allocation FOREIGN KEY (organization_id, allocation_id) REFERENCES allocations (organization_id, id),
  CONSTRAINT fk_exceptions_related FOREIGN KEY (organization_id, related_allocation_id) REFERENCES allocations (organization_id, id),
  CONSTRAINT fk_exceptions_resolved_by FOREIGN KEY (organization_id, resolved_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_exceptions_resolved CHECK (status = 'open' OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_exceptions_open ON exceptions (organization_id, allocation_id, type) WHERE status = 'open';
CREATE INDEX ix_exceptions_property ON exceptions (organization_id, property_id, status);
CREATE TRIGGER trg_exceptions_updated BEFORE UPDATE ON exceptions FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['allocations','blocks','exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_org()) '
                   'WITH CHECK (organization_id = app.current_org())', t);
  END LOOP;
END $$;

-- Job nhả hold hết hạn xuyên tổ chức (worker) qua hàm phạm vi hẹp; nhả đúng một lần (UPDATE … WHERE active).
CREATE FUNCTION app.expire_holds(p_now timestamptz, p_limit integer)
  RETURNS TABLE (allocation_id uuid, organization_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH due AS (
      SELECT a.id FROM allocations a
      WHERE a.active AND a.kind = 'hold' AND a.expires_at <= p_now
      ORDER BY a.expires_at, a.id
      LIMIT least(greatest(p_limit, 1), 10000)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE allocations a SET active = false, deactivated_at = p_now, deactivated_reason = 'expired'
    FROM due WHERE a.id = due.id AND a.active
    RETURNING a.id, a.organization_id
  $$;
REVOKE ALL ON FUNCTION app.expire_holds(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_holds(timestamptz, integer) TO app_worker;

GRANT SELECT, INSERT, UPDATE ON allocations, blocks, exceptions TO app_runtime;
GRANT SELECT ON allocations, blocks, exceptions TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.expire_holds(timestamptz, integer);
DROP TABLE IF EXISTS exceptions, blocks, allocations;
DROP FUNCTION IF EXISTS app.check_block_allocation();
DROP FUNCTION IF EXISTS app.forbid_reactivation();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
