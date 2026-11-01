// Capture only user-initiated DSAR events; worker events have no HTTP client.
import { type Kysely, sql } from "kysely";

// Fail closed if the prior export contract changes. Apply only the two additional personal-data fields.
const EXPORT_UPDATE = (reverse: boolean) => `
DO $$ DECLARE definition text; old_fragment text; new_fragment text; BEGIN
  old_fragment := 'e.correlation_id) ORDER BY e.occurred_at, e.id)';
  new_fragment := 'e.correlation_id, ''source_ip'', e.source_ip, ''user_agent'', e.user_agent) ORDER BY e.occurred_at, e.id)';
  IF ${reverse} THEN
    SELECT new_fragment, old_fragment INTO old_fragment, new_fragment;
  END IF;
  SELECT pg_get_functiondef('app.dsar_export_data(uuid)'::regprocedure) INTO definition;
  IF position(old_fragment IN definition) = 0 OR position(new_fragment IN definition) > 0 THEN
    RAISE EXCEPTION 'unexpected DSAR export definition';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);
END $$;
`;

const UP = `
ALTER TABLE dsar_audit_events ADD COLUMN source_ip text, ADD COLUMN user_agent text;
ALTER TABLE dsar_audit_events
  ADD CONSTRAINT ck_dsar_audit_source_ip CHECK (source_ip IS NULL OR
    source_ip ~ '^(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.0|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::)$'),
  ADD CONSTRAINT ck_dsar_audit_user_agent CHECK (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 200),
  ADD CONSTRAINT ck_dsar_audit_worker_source CHECK (actor_type <> 'worker' OR (source_ip IS NULL AND user_agent IS NULL));
CREATE FUNCTION app.dsar_audit_source() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.actor_type = 'user' THEN
    NEW.source_ip := nullif(current_setting('app.source_ip', true), '');
    NEW.user_agent := nullif(current_setting('app.user_agent', true), '');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.dsar_audit_source() FROM PUBLIC;
CREATE TRIGGER trg_dsar_audit_source BEFORE INSERT ON dsar_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.dsar_audit_source();
${EXPORT_UPDATE(false)}
`;
const DOWN = `
LOCK TABLE dsar_requests, dsar_audit_events IN ACCESS EXCLUSIVE MODE;
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dsar_audit_events WHERE source_ip IS NOT NULL OR user_agent IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot discard DSAR audit source evidence';
  END IF;
END $$;
${EXPORT_UPDATE(true)}
DROP TRIGGER trg_dsar_audit_source ON dsar_audit_events;
DROP FUNCTION app.dsar_audit_source();
ALTER TABLE dsar_audit_events DROP COLUMN source_ip, DROP COLUMN user_agent;
`;
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
