// T-2617 (AUD-DATA-010; D-128, TM-12) — lớp 2 chỉ-đọc của support trên các bảng 0072 miễn trừ. 0072 loại `audit_events`,
// `idempotency_keys`, `outbox`, `invitations` khỏi `support_ro_{ins,upd,del}` vì support vẫn phải ghi một phần ở đó; kết quả là
// actor `platform_support` (app_runtime) ghi TUỲ Ý được: tạo lời mời `owner` với token tự chọn, sửa/xoá lời mời của người khác,
// audit giả danh owner, outbox bất kỳ. Migration này thêm policy RESTRICTIVE `support_limited_*` (TO app_runtime), chỉ mở đúng
// phần support cần (kiểm kê các chỗ ghi khi phiên là support, T-2617):
// - invitations: INSERT/DELETE chỉ khi `actor_not_support()`. UPDATE: không phải support, HOẶC đúng luồng nhận lời mời
//   (`accept-invitation.ts`, bootstrap của pipeline): lúc UPDATE, `app.actor_id` = membership hỗ trợ VỪA tạo trong cùng
//   transaction. USING = lời mời `pending`, còn hạn, cùng vai, gửi tới đúng email của tài khoản sở hữu membership đó, và
//   membership chưa gắn với lời mời nào (⇒ sau khi nhận xong, support không sửa lại/nhận hộ được lời mời nào nữa) — kiểm bằng
//   `app.support_accepting_invitation` (SECURITY DEFINER: support không đọc được auth."user"/lời mời khác qua RLS).
//   WITH CHECK = `status = 'accepted'`, `membership_id` = actor, `person_id` = person của actor.
// - audit_events: INSERT khi không phải support, HOẶC `actor_type = 'platform_support'` VÀ `actor_person_id` = person của
//   chính actor (membership còn hiệu lực). Đủ cho `support.accessed`, `command.denied`, `member.accepted`, audit "denied" của
//   query (`person.get` dùng `actorType(actor)`), sự kiện đăng nhập/bảo mật (`auth-events.ts`).
// - outbox: INSERT khi không phải support, HOẶC sự kiện của CHÍNH tài khoản support: `member.accepted` (nhận lời mời),
//   `member.password_changed`/`member.mfa_disabled` (`auth-events.ts`) với `aggregate_type = 'membership'`, `aggregate_id` và
//   `payload.membership_id` = actor (người nhận thông báo do `payload.membership_id` quyết — notifications/dispatch.ts), membership
//   còn hiệu lực.
// - idempotency_keys (D-164, mẫu `portal_own_idempotency`): INSERT/UPDATE/DELETE khi không phải support, HOẶC hàng của chính
//   actor (`actor_person_id = app.actor_person_id()`, membership còn hiệu lực). Phiên support ghi bảng này ở hai luồng hợp lệ, đều
//   là hàng của chính nó: nhận lời mời (pipeline INSERT khoá + UPDATE `committed`, actor_person_id = person vừa tạo) và đổi tổ chức
//   (`org-context.ts` INSERT hàng `committed` với person của membership actor). Không sửa/xoá được kết quả lưu của người khác
//   (replay giả). SELECT không đổi. (app_runtime hiện không có quyền DELETE; policy DELETE giữ đúng nếu sau này cấp.)
// Hàm SECURITY DEFINER (owner migration) không chịu policy `TO app_runtime` ⇒ không đổi hành vi hàm CSDL.
// DOWN: chỉ gỡ policy + hàm vừa tạo — không đụng dữ liệu.
import { type Kysely, sql } from "kysely";

const ACTOR_ID = `nullif(current_setting('app.actor_id', true), '')::uuid`;

/** Sự kiện outbox hợp lệ của một phiên support (kiểm kê T-2617). */
export const SUPPORT_OUTBOX_EVENTS = [
  "member.accepted",
  "member.password_changed",
  "member.mfa_disabled",
] as const;

const UP = `
CREATE FUNCTION app.support_accepting_invitation(p_invitation uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1
      FROM memberships m
      JOIN invitations i ON i.organization_id = m.organization_id AND i.id = p_invitation
      JOIN auth."user" u ON u.id = m.auth_user_id
      WHERE m.id = ${ACTOR_ID}
        AND m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
        AND m.role = 'platform_support' AND m.status = 'active'
        AND (m.valid_to IS NULL OR m.valid_to > now())
        AND i.role = m.role AND i.status = 'pending' AND i.expires_at > now()
        AND lower(btrim(u.email)) = i.email
        AND NOT EXISTS (SELECT 1 FROM invitations x WHERE x.membership_id = m.id))
  $$;
REVOKE ALL ON FUNCTION app.support_accepting_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.support_accepting_invitation(uuid) TO app_runtime;

CREATE POLICY support_limited_ins ON invitations AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT app.actor_not_support()));
CREATE POLICY support_limited_del ON invitations AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT app.actor_not_support()));
CREATE POLICY support_limited_upd ON invitations AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ((SELECT app.actor_not_support()) OR (status = 'pending' AND app.support_accepting_invitation(id)))
  WITH CHECK ((SELECT app.actor_not_support())
              OR (status = 'accepted' AND membership_id = ${ACTOR_ID} AND person_id = (SELECT app.actor_person_id())));

CREATE POLICY support_limited_ins ON audit_events AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT app.actor_not_support())
              OR (actor_type = 'platform_support' AND actor_person_id = (SELECT app.actor_person_id())));

CREATE POLICY support_limited_ins ON outbox AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT app.actor_not_support())
              OR (event_type IN (${SUPPORT_OUTBOX_EVENTS.map((e) => `'${e}'`).join(", ")})
                  AND aggregate_type = 'membership' AND aggregate_id = ${ACTOR_ID}
                  AND lower(payload ->> 'membership_id') = ${ACTOR_ID}::text
                  AND (SELECT app.actor_person_id()) IS NOT NULL));

CREATE POLICY support_limited_ins ON idempotency_keys AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT app.actor_not_support()) OR actor_person_id = (SELECT app.actor_person_id()));
CREATE POLICY support_limited_upd ON idempotency_keys AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ((SELECT app.actor_not_support()) OR actor_person_id = (SELECT app.actor_person_id()))
  WITH CHECK ((SELECT app.actor_not_support()) OR actor_person_id = (SELECT app.actor_person_id()));
CREATE POLICY support_limited_del ON idempotency_keys AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT app.actor_not_support()) OR actor_person_id = (SELECT app.actor_person_id()));
`;

const DOWN = `
DROP POLICY IF EXISTS support_limited_del ON idempotency_keys;
DROP POLICY IF EXISTS support_limited_upd ON idempotency_keys;
DROP POLICY IF EXISTS support_limited_ins ON idempotency_keys;
DROP POLICY IF EXISTS support_limited_ins ON outbox;
DROP POLICY IF EXISTS support_limited_ins ON audit_events;
DROP POLICY IF EXISTS support_limited_upd ON invitations;
DROP POLICY IF EXISTS support_limited_del ON invitations;
DROP POLICY IF EXISTS support_limited_ins ON invitations;
DROP FUNCTION IF EXISTS app.support_accepting_invitation(uuid);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
