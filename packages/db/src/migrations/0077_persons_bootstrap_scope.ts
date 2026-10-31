// T-2503 / AUD-SEC-004: a missing membership is permitted only while INSERT bootstraps a person.
// UPDATE must require an active staff membership (or the existing no-actor system context). A blind UPDATE without
// WHERE/RETURNING does not invoke persons_read, so that SELECT policy cannot protect this write permission.
// INSERT remains unchanged for org.create/member.acceptInvitation. Same function signature and grants in both directions.
import { type Kysely, sql } from "kysely";

const definition = (bootstrapUpdate: boolean) => `
CREATE OR REPLACE FUNCTION app.actor_may_update_person() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT nullif(current_setting('app.actor_id', true), '') IS NULL
           OR coalesce(app.actor_role() IN ('owner','manager','front_desk','accountant'), false)
${bootstrapUpdate ? "           OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.id = nullif(current_setting('app.actor_id', true), '')::uuid)" : ""}
  $$;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(definition(false)).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(definition(true)).execute(db);
}
