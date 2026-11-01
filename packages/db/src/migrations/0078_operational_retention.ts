// T-2505 (D-141) — bounded worker-only cleanup for operational records previously omitted from retention.
// Invitations: only unlinked rows; referenced invitations retain the person's last-activity evidence.
// Latest expiry/update/acceptance must be older than 90 days, including revoked/accepted invitations.
// Login throttle: latest window/lock older than 7 days; live locks never qualify.
// Rate-limit timestamps are epoch milliseconds. Compare numerically, avoiding conversion overflow for bigint future values.
// Round the cutoff upward to an integer (equivalent for integer timestamps), keeping the indexed column uncast.
// Database clock bounds caller time; minimum retention and batch limits cannot be shortened by the caller.
// Down removes helpers/indexes; deleted expired operational records cannot be restored by a schema rollback.
import { type Kysely, sql } from "kysely";

const UP = `
CREATE INDEX ix_invitations_retention_dead_at ON invitations ((greatest(expires_at, updated_at, accepted_at)))
  WHERE person_id IS NULL AND membership_id IS NULL;
CREATE INDEX ix_login_throttle_retention_at ON auth.login_throttle ((greatest(window_started_at, locked_until)));
CREATE INDEX ix_auth_rate_limit_last_request ON auth."rateLimit" ("lastRequest");

CREATE FUNCTION app.purge_invitations(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT i.id FROM invitations i
      WHERE i.person_id IS NULL AND i.membership_id IS NULL
        AND greatest(i.expires_at, i.updated_at, i.accepted_at)
              < least(p_now, now()) - make_interval(days => greatest(p_days, 90))
        AND (i.status <> 'pending' OR i.expires_at < least(p_now, now()))
      ORDER BY greatest(i.expires_at, i.updated_at, i.accepted_at), i.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM invitations i USING due WHERE i.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_auth_login_throttle(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT t.email_hash FROM auth.login_throttle t
      WHERE greatest(t.window_started_at, t.locked_until)
              < least(p_now, now()) - make_interval(days => greatest(p_days, 7))
        AND (t.locked_until IS NULL OR t.locked_until < least(p_now, now()))
      ORDER BY greatest(t.window_started_at, t.locked_until), t.email_hash
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM auth.login_throttle t USING due WHERE t.email_hash = due.email_hash RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

CREATE FUNCTION app.purge_auth_rate_limits(p_now timestamptz, p_days integer, p_limit integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
    WITH due AS (
      SELECT r.id FROM auth."rateLimit" r
      WHERE r."lastRequest" < ceil(extract(epoch FROM
        (least(p_now, now()) - make_interval(days => greatest(p_days, 7))))
          / extract(epoch FROM interval '1 millisecond'))::bigint
      ORDER BY r."lastRequest", r.id
      LIMIT least(greatest(p_limit, 1), 5000)
      FOR UPDATE SKIP LOCKED
    ), x AS (
      DELETE FROM auth."rateLimit" r USING due WHERE r.id = due.id RETURNING 1)
    SELECT count(*)::int FROM x
  $$;

REVOKE ALL ON FUNCTION app.purge_invitations(timestamptz, integer, integer),
  app.purge_auth_login_throttle(timestamptz, integer, integer),
  app.purge_auth_rate_limits(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_invitations(timestamptz, integer, integer),
  app.purge_auth_login_throttle(timestamptz, integer, integer),
  app.purge_auth_rate_limits(timestamptz, integer, integer) TO app_worker;
`;

const DOWN = `
DROP FUNCTION app.purge_auth_rate_limits(timestamptz, integer, integer);
DROP FUNCTION app.purge_auth_login_throttle(timestamptz, integer, integer);
DROP FUNCTION app.purge_invitations(timestamptz, integer, integer);
DROP INDEX auth.ix_auth_rate_limit_last_request;
DROP INDEX auth.ix_login_throttle_retention_at;
DROP INDEX ix_invitations_retention_dead_at;
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
