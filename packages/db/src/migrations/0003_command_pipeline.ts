// T-008 — hạ tầng command pipeline: idempotency_keys (INV-G5), audit_events (INV-G6, append-only — SEC-LOG-007),
// outbox (INV-G6). Nguồn: ERD.md các mục tương ứng.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  key uuid NOT NULL,
  command text NOT NULL CHECK (command ~ '^[a-z_]+(\\.[a-zA-Z_]+)+$'),
  actor_person_id uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','committed','failed')),
  http_status smallint,
  response jsonb CHECK (status <> 'committed' OR response IS NOT NULL),
  error_code text,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CONSTRAINT uq_idempotency_keys UNIQUE (organization_id, key),
  CONSTRAINT fk_idempotency_actor FOREIGN KEY (organization_id, actor_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_idempotency_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ix_idempotency_expires ON idempotency_keys (expires_at);
CREATE INDEX ix_idempotency_actor ON idempotency_keys (organization_id, actor_person_id, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','worker','platform_support')),
  actor_person_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z_]+(\\.[a-z_]+)+$'),
  entity_type text NOT NULL,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  correlation_id text NOT NULL,
  command_id uuid,
  outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_audit_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (organization_id, actor_person_id) REFERENCES persons (organization_id, id),
  CONSTRAINT ck_audit_actor CHECK (actor_type = 'worker' OR actor_person_id IS NOT NULL)
);
CREATE INDEX ix_audit_org_time ON audit_events (organization_id, occurred_at DESC, id DESC);
CREATE INDEX ix_audit_correlation ON audit_events (organization_id, correlation_id);
CREATE INDEX ix_audit_entity ON audit_events (organization_id, entity_type, entity_id);
CREATE INDEX ix_audit_property_time ON audit_events (organization_id, property_id, occurred_at DESC);

-- Append-only (INV-G4, SEC-LOG-007): chặn UPDATE/DELETE/TRUNCATE kể cả với owner bảng.
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bảng % là append-only (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000', HINT = 'DOCUMENT_IMMUTABLE';
END $$;
CREATE TRIGGER trg_audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  property_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]+(\\.[a-z_]+)+$'),
  aggregate_type text,
  aggregate_id uuid,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  correlation_id text NOT NULL,
  command_id uuid,
  dedupe_key text,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_outbox_property FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id)
);
CREATE UNIQUE INDEX uq_outbox_dedupe ON outbox (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ix_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- RLS lớp 1.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys','audit_events','outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_org()) '
                   'WITH CHECK (organization_id = app.current_org())', t);
  END LOOP;
END $$;
-- Relay xuyên tổ chức đi qua hai hàm SECURITY DEFINER phạm vi hẹp (không mở policy/BYPASSRLS cho worker):
-- claim = khoá hàng chưa phát (SKIP LOCKED, giữ khoá tới hết transaction của người gọi); mark = ghi kết quả phát.
CREATE FUNCTION app.outbox_claim(p_limit integer)
  RETURNS TABLE (id uuid, organization_id uuid, event_type text, aggregate_id uuid, payload jsonb, correlation_id text)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.id, o.organization_id, o.event_type, o.aggregate_id, o.payload, o.correlation_id
    FROM outbox o WHERE o.published_at IS NULL
    ORDER BY o.created_at, o.id
    LIMIT least(greatest(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  $$;
CREATE FUNCTION app.outbox_mark(p_id uuid, p_error text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE outbox SET attempts = attempts + 1,
           published_at = CASE WHEN p_error IS NULL THEN now() ELSE published_at END,
           last_error = left(p_error, 500)
    WHERE id = p_id AND published_at IS NULL
  $$;
REVOKE ALL ON FUNCTION app.outbox_claim(integer), app.outbox_mark(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer), app.outbox_mark(uuid, text) TO app_worker;
-- Worker dọn idempotency hết hạn của mọi tổ chức.
CREATE POLICY worker_cleanup ON idempotency_keys FOR DELETE TO app_worker USING (expires_at < now());

GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO app_runtime;
GRANT SELECT, DELETE ON idempotency_keys TO app_worker;
GRANT SELECT, INSERT ON audit_events TO app_runtime, app_worker;
GRANT INSERT ON outbox TO app_runtime, app_worker;
GRANT SELECT ON organizations, properties, persons TO app_worker;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.outbox_mark(uuid, text);
DROP FUNCTION IF EXISTS app.outbox_claim(integer);
DROP TABLE IF EXISTS outbox, audit_events, idempotency_keys;
DROP FUNCTION IF EXISTS app.forbid_mutation();
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
