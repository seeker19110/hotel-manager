// T-2502 (D-139) — account-scoped DSAR evidence, including accounts without an organization.
// Lifecycle triggers run in the request/status transaction; runtime/worker cannot write audit rows directly.
// Closed fields contain identifiers and state only: no request payload, retention note, storage key or signed URL.
// URL issuance is recorded after signing and a fresh ownership/status/expiry check; it does not assert a download.
// Down refuses once evidence exists. Application rollback keeps this additive schema and its audit history.
import { type Kysely, sql } from "kysely";

const exportData = (includeAudit: boolean) =>
  `
CREATE OR REPLACE FUNCTION app.dsar_export_data(p_request_id uuid) RETURNS jsonb
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
                       ORDER BY c.seq)
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
    ${
      includeAudit
        ? `
    'audit_events', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'request_id', e.request_id, 'action', e.action,
                                          'actor_type', e.actor_type, 'request_type', e.request_type,
                                          'request_status', e.request_status, 'occurred_at', e.occurred_at,
                                          'correlation_id', e.correlation_id) ORDER BY e.occurred_at, e.id)
        FROM dsar_audit_events e WHERE e.subject_user_id = v_user), '[]'::jsonb),`
        : ""
    }
    'product_events', coalesce((
      SELECT jsonb_agg(jsonb_build_object('organization_id', e.organization_id, 'property_id', e.property_id,
                                          'name', e.name, 'schema_version', e.schema_version, 'props', e.props,
                                          'occurred_at', e.occurred_at) ORDER BY e.occurred_at, e.id)
        FROM product_events e WHERE e.actor_user_id = v_user), '[]'::jsonb)
  );
END $$;
`.replace(/[ \t]+$/gm, "");

const UP = `
CREATE TABLE dsar_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES dsar_requests (id) ON DELETE RESTRICT,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'worker')),
  action text NOT NULL CHECK (action IN ('dsar.requested', 'dsar.received', 'dsar.verified', 'dsar.processing',
                                        'dsar.completed', 'dsar.rejected', 'dsar.url_issued')),
  request_type text NOT NULL CHECK (request_type IN ('access', 'delete', 'restrict')),
  request_status text NOT NULL CHECK (request_status IN ('received', 'verified', 'processing', 'completed', 'rejected')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id text NOT NULL CHECK (correlation_id = 'dsar:' || request_id::text)
);
CREATE INDEX ix_dsar_audit_events_subject_time ON dsar_audit_events (subject_user_id, occurred_at, id);
CREATE INDEX ix_dsar_audit_events_request ON dsar_audit_events (request_id);
CREATE TRIGGER trg_dsar_audit_events_append_only BEFORE UPDATE OR DELETE ON dsar_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_dsar_audit_events_no_truncate BEFORE TRUNCATE ON dsar_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
ALTER TABLE dsar_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dsar_audit_events_self_read ON dsar_audit_events FOR SELECT
  USING (subject_user_id = app.current_user_id());
CREATE POLICY support_ro_ins ON dsar_audit_events AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT app.actor_not_support()));
CREATE POLICY support_ro_upd ON dsar_audit_events AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ((SELECT app.actor_not_support())) WITH CHECK ((SELECT app.actor_not_support()));
CREATE POLICY support_ro_del ON dsar_audit_events AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT app.actor_not_support()));
REVOKE ALL ON dsar_audit_events FROM PUBLIC;
GRANT SELECT ON dsar_audit_events TO app_runtime;

CREATE FUNCTION app.dsar_audit_lifecycle() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO dsar_audit_events (subject_user_id, request_id, actor_type, action, request_type, request_status, correlation_id)
    VALUES (NEW.subject_user_id, NEW.id, 'user', 'dsar.requested', NEW.type, NEW.status, 'dsar:' || NEW.id::text);
    -- Restriction completes in the same transaction as its request, without a worker transition.
    IF NEW.status = 'completed' THEN
      INSERT INTO dsar_audit_events (subject_user_id, request_id, actor_type, action, request_type, request_status, correlation_id)
      VALUES (NEW.subject_user_id, NEW.id, 'user', 'dsar.completed', NEW.type, NEW.status, 'dsar:' || NEW.id::text);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO dsar_audit_events (subject_user_id, request_id, actor_type, action, request_type, request_status, correlation_id)
    VALUES (NEW.subject_user_id, NEW.id, 'worker', 'dsar.' || NEW.status, NEW.type, NEW.status, 'dsar:' || NEW.id::text);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.dsar_audit_lifecycle() FROM PUBLIC;
CREATE TRIGGER trg_dsar_requests_audit AFTER INSERT OR UPDATE OF status ON dsar_requests
  FOR EACH ROW EXECUTE FUNCTION app.dsar_audit_lifecycle();

CREATE FUNCTION app.dsar_audit_url_issued(p_request_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
DECLARE r dsar_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM dsar_requests d
   WHERE d.id = p_request_id AND d.subject_user_id = app.current_user_id()
     AND d.type = 'access' AND d.status = 'completed' AND d.result_file_key IS NOT NULL
     AND d.result_expires_at > clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO dsar_audit_events (subject_user_id, request_id, actor_type, action, request_type, request_status, correlation_id)
  VALUES (r.subject_user_id, r.id, 'user', 'dsar.url_issued', r.type, r.status, 'dsar:' || r.id::text);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.dsar_audit_url_issued(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dsar_audit_url_issued(uuid) TO app_runtime;
${exportData(true)}
`;

const DOWN = `
-- Match lifecycle/issuance lock order so no evidence can appear between the empty check and DROP.
LOCK TABLE dsar_requests, dsar_audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dsar_audit_events) THEN
    RAISE EXCEPTION 'DSAR audit evidence exists; retain schema when rolling back application code'
      USING ERRCODE = '55000', HINT = 'DSAR_AUDIT_EVIDENCE_EXISTS';
  END IF;
END $$;
${exportData(false)}
DROP FUNCTION app.dsar_audit_url_issued(uuid);
DROP TRIGGER trg_dsar_requests_audit ON dsar_requests;
DROP FUNCTION app.dsar_audit_lifecycle();
DROP TABLE dsar_audit_events;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
