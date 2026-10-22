import { listMembers, listProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm, type FieldSpec } from "../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { day } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { ROLE_LABEL, STAFF_ALL, STAFF_LOW, STATUS_LABEL } from "../../lib/roles.ts";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("member.metadata.title") };

const roleOptions = (roles: readonly string[]) => roles.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));

// SPEC-access-and-property S-007, S-018, S-010 (màn quản trị): mời nhân viên, đổi vai trò/phạm vi, thu hồi phiên. Owner làm được
// mọi việc; manager chỉ mời/thu hồi phiên nhân viên cấp thấp cùng cơ sở (quyền thật vẫn kiểm ở server mỗi lệnh).
export default async function MembersPage() {
  return withActor(t("member.page.title"), "/thanh-vien", async (actor) => {
    if (actor.role !== "owner" && actor.role !== "manager")
      return <ErrorState title={t("member.error.forbidden_title")} text={t("member.error.forbidden_text")} />;
    const db = serverContext().db;
    const [list, props] = await Promise.all([safe(listMembers(db, actor)), safe(listProperties(db, actor))]);
    if (!list.ok) return <ErrorState title={t("member.error.load_members")} text={list.message} />;
    if (!props.ok) return <ErrorState title={t("member.error.load_properties")} text={props.message} />;
    const isOwner = actor.role === "owner";
    const propertyOptions = (allLabel: string) => [
      { value: "", label: allLabel },
      ...props.data.map((p) => ({ value: p.propertyId, label: p.name })),
    ];
    const { members, invitations } = list.data;
    const others = members.filter((m) => !m.isSelf);
    const inviteFields: FieldSpec[] = [
      { name: "email", label: t("member.invite.email"), required: true, maxLength: 320 },
      {
        name: "role",
        label: t("member.field.role"),
        type: "select",
        required: true,
        options: roleOptions(isOwner ? STAFF_ALL : STAFF_LOW),
        defaultValue: "front_desk",
      },
      {
        name: "property_id",
        label: t("member.field.property"),
        type: "select",
        path: "property_ids",
        array: true,
        options: propertyOptions(t("member.invite.all_properties_option")),
        defaultValue: props.data[0]?.propertyId ?? "",
        hint: t("member.invite.property_hint"),
      },
      {
        name: "discount",
        label: t("member.invite.discount"),
        type: "money",
        path: "limits.discount",
        hint: t("member.invite.discount_hint"),
      },
    ];
    return (
      <>
        <section aria-labelledby="invite-h">
          <h2 id="invite-h">{t("member.invite.heading")}</h2>
          <CommandForm
            path="member/invite"
            fields={inviteFields}
            submitLabel={t("member.invite.submit")}
            successText={t("member.invite.success")}
            testId="invite-form"
          />
        </section>

        <section aria-labelledby="pending-h">
          <h2 id="pending-h">{t("member.pending.heading")}</h2>
          {invitations.length === 0 ? (
            <EmptyState title={t("member.pending.empty")} />
          ) : (
            <ul className="choice-list" data-testid="invitations">
              {invitations.map((i) => (
                <li key={i.invitationId}>
                  <strong>{i.email}</strong> · {ROLE_LABEL[i.role] ?? i.role}
                  {i.properties.length > 0
                    ? ` · ${i.properties.map((p) => p.name).join(", ")}`
                    : ` · ${t("member.scope.all")}`}{" "}
                  {t("member.invitation.expires", { date: day(i.expiresAt.slice(0, 10)) })}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="members-h">
          <h2 id="members-h">{t("member.active.heading")}</h2>
          {others.length === 0 ? (
            <EmptyState title={t("member.active.empty_title")} text={t("member.active.empty_text")} />
          ) : null}
          <ul className="member-list" data-testid="members">
            {members.map((m) => (
              <li key={m.membershipId} className="member-list__item" data-testid="member">
                <h3>
                  {m.fullName}
                  {m.isSelf ? t("member.self_suffix") : ""}
                </h3>
                <p>
                  {m.email ? `${m.email} · ` : ""}
                  {ROLE_LABEL[m.role] ?? m.role} · {STATUS_LABEL[m.status] ?? m.status} ·{" "}
                  {m.allProperties
                    ? t("member.scope.all")
                    : m.properties.map((p) => p.name).join(", ") || t("member.scope.none")}
                </p>
                {isOwner ? (
                  <>
                    <details className="details-box">
                      <summary>{t("member.role.summary", { name: m.fullName })}</summary>
                      <CommandForm
                        path="member/updateRole"
                        fixed={{ membership_id: m.membershipId }}
                        fields={[
                          {
                            name: "role",
                            label: t("member.role.new"),
                            type: "select",
                            required: true,
                            options: roleOptions(STAFF_ALL),
                            defaultValue: m.role,
                          },
                          {
                            name: "property_id",
                            label: t("member.role.property_label"),
                            type: "select",
                            path: "property_ids",
                            array: true,
                            options: propertyOptions(t("member.role.keep_scope")),
                          },
                          { name: "reason", label: t("member.field.reason"), required: true, maxLength: 500 },
                        ]}
                        submitLabel={t("member.role.submit")}
                        successText={t("member.role.success")}
                        confirm={t("member.role.confirm")}
                        confirmLabel={t("member.role.confirm_label", { name: m.fullName })}
                      />
                    </details>
                    {m.role !== "owner" ? (
                      <details className="details-box">
                        <summary>{t("member.scope.summary", { name: m.fullName })}</summary>
                        <CommandForm
                          path="member/updateScope"
                          fixed={{ membership_id: m.membershipId }}
                          fields={[
                            {
                              name: "property_id",
                              label: t("member.field.property"),
                              type: "select",
                              path: "property_ids",
                              array: true,
                              required: true,
                              options: props.data.map((p) => ({ value: p.propertyId, label: p.name })),
                              defaultValue: m.properties[0]?.id ?? props.data[0]?.propertyId ?? "",
                            },
                            {
                              name: "reason",
                              label: t("member.field.reason"),
                              required: true,
                              maxLength: 500,
                            },
                          ]}
                          submitLabel={t("member.scope.submit")}
                          successText={t("member.scope.success")}
                        />
                      </details>
                    ) : null}
                  </>
                ) : null}
                {!m.isSelf && (isOwner || (STAFF_LOW as readonly string[]).includes(m.role)) ? (
                  <CommandForm
                    path="session/revokeAll"
                    fixed={{ membership_id: m.membershipId }}
                    submitLabel={t("member.revoke.submit", { name: m.fullName })}
                    successText={t("member.revoke.success")}
                    variant="secondary"
                    confirm={t("member.revoke.confirm")}
                    confirmLabel={t("member.revoke.confirm_label", { name: m.fullName })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  });
}
