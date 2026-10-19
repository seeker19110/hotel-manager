import { listMembers, listProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm, type FieldSpec } from "../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { day } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { ROLE_LABEL, STAFF_ALL, STAFF_LOW, STATUS_LABEL } from "../../lib/roles.ts";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Thành viên — Hotel Manager" };

const roleOptions = (roles: readonly string[]) => roles.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));

// SPEC-access-and-property S-007, S-018, S-010 (màn quản trị): mời nhân viên, đổi vai trò/phạm vi, thu hồi phiên. Owner làm được
// mọi việc; manager chỉ mời/thu hồi phiên nhân viên cấp thấp cùng cơ sở (quyền thật vẫn kiểm ở server mỗi lệnh).
export default async function MembersPage() {
  return withActor("Thành viên", "/thanh-vien", async (actor) => {
    if (actor.role !== "owner" && actor.role !== "manager")
      return <ErrorState title="Không có quyền" text="Chỉ chủ và quản lý xem được danh sách thành viên." />;
    const db = serverContext().db;
    const [list, props] = await Promise.all([safe(listMembers(db, actor)), safe(listProperties(db, actor))]);
    if (!list.ok) return <ErrorState title="Không tải được danh sách" text={list.message} />;
    if (!props.ok) return <ErrorState title="Không tải được cơ sở" text={props.message} />;
    const isOwner = actor.role === "owner";
    const propertyOptions = (allLabel: string) => [
      { value: "", label: allLabel },
      ...props.data.map((p) => ({ value: p.propertyId, label: p.name })),
    ];
    const { members, invitations } = list.data;
    const others = members.filter((m) => !m.isSelf);
    const inviteFields: FieldSpec[] = [
      { name: "email", label: "Email người được mời", required: true, maxLength: 320 },
      {
        name: "role",
        label: "Vai trò",
        type: "select",
        required: true,
        options: roleOptions(isOwner ? STAFF_ALL : STAFF_LOW),
        defaultValue: "front_desk",
      },
      {
        name: "property_id",
        label: "Cơ sở",
        type: "select",
        path: "property_ids",
        array: true,
        options: propertyOptions("Tất cả cơ sở (chỉ chủ và kế toán)"),
        defaultValue: props.data[0]?.propertyId ?? "",
        hint: "Vai trò còn lại phải chọn một cơ sở.",
      },
      {
        name: "discount",
        label: "Hạn mức giảm giá (đ)",
        type: "money",
        path: "limits.discount",
        hint: "Để trống nếu không cấp. 0 = mọi khoản cần duyệt.",
      },
    ];
    return (
      <>
        <section aria-labelledby="invite-h">
          <h2 id="invite-h">Mời nhân viên</h2>
          <CommandForm
            path="member/invite"
            fields={inviteFields}
            submitLabel="Gửi lời mời"
            successText="Đã gửi lời mời. Người nhận mở liên kết trong email (hạn 7 ngày) để tham gia."
            testId="invite-form"
          />
        </section>

        <section aria-labelledby="pending-h">
          <h2 id="pending-h">Lời mời đang chờ</h2>
          {invitations.length === 0 ? (
            <EmptyState title="Không có lời mời đang chờ" />
          ) : (
            <ul className="choice-list" data-testid="invitations">
              {invitations.map((i) => (
                <li key={i.invitationId}>
                  <strong>{i.email}</strong> · {ROLE_LABEL[i.role] ?? i.role}
                  {i.properties.length > 0
                    ? ` · ${i.properties.map((p) => p.name).join(", ")}`
                    : " · Tất cả cơ sở"}{" "}
                  {t("member.invitation.expires", { date: day(i.expiresAt.slice(0, 10)) })}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="members-h">
          <h2 id="members-h">Đang làm việc</h2>
          {others.length === 0 ? (
            <EmptyState title="Chưa có nhân viên" text="Mời người đầu tiên ở phần trên." />
          ) : null}
          <ul className="member-list" data-testid="members">
            {members.map((m) => (
              <li key={m.membershipId} className="member-list__item" data-testid="member">
                <h3>
                  {m.fullName}
                  {m.isSelf ? " (bạn)" : ""}
                </h3>
                <p>
                  {m.email ? `${m.email} · ` : ""}
                  {ROLE_LABEL[m.role] ?? m.role} · {STATUS_LABEL[m.status] ?? m.status} ·{" "}
                  {m.allProperties
                    ? "Tất cả cơ sở"
                    : m.properties.map((p) => p.name).join(", ") || "Chưa có cơ sở"}
                </p>
                {isOwner ? (
                  <>
                    <details className="details-box">
                      <summary>Đổi vai trò — {m.fullName}</summary>
                      <CommandForm
                        path="member/updateRole"
                        fixed={{ membership_id: m.membershipId }}
                        fields={[
                          {
                            name: "role",
                            label: "Vai trò mới",
                            type: "select",
                            required: true,
                            options: roleOptions(STAFF_ALL),
                            defaultValue: m.role,
                          },
                          {
                            name: "property_id",
                            label: "Cơ sở (nếu đổi sang vai trò theo cơ sở)",
                            type: "select",
                            path: "property_ids",
                            array: true,
                            options: propertyOptions("Giữ nguyên phạm vi"),
                          },
                          { name: "reason", label: "Lý do", required: true, maxLength: 500 },
                        ]}
                        submitLabel="Đổi vai trò"
                        successText="Đã đổi vai trò. Có hiệu lực ở thao tác kế tiếp của người đó."
                        confirm="Quyền của người này đổi ngay ở thao tác kế tiếp; thay đổi được ghi vào nhật ký."
                        confirmLabel={`Đổi vai trò của ${m.fullName}`}
                      />
                    </details>
                    {m.role !== "owner" ? (
                      <details className="details-box">
                        <summary>Đổi cơ sở được làm việc — {m.fullName}</summary>
                        <CommandForm
                          path="member/updateScope"
                          fixed={{ membership_id: m.membershipId }}
                          fields={[
                            {
                              name: "property_id",
                              label: "Cơ sở",
                              type: "select",
                              path: "property_ids",
                              array: true,
                              required: true,
                              options: props.data.map((p) => ({ value: p.propertyId, label: p.name })),
                              defaultValue: m.properties[0]?.id ?? props.data[0]?.propertyId ?? "",
                            },
                            { name: "reason", label: "Lý do", required: true, maxLength: 500 },
                          ]}
                          submitLabel="Đổi cơ sở"
                          successText="Đã đổi phạm vi cơ sở."
                        />
                      </details>
                    ) : null}
                  </>
                ) : null}
                {!m.isSelf && (isOwner || (STAFF_LOW as readonly string[]).includes(m.role)) ? (
                  <CommandForm
                    path="session/revokeAll"
                    fixed={{ membership_id: m.membershipId }}
                    submitLabel={`Thu hồi phiên đăng nhập — ${m.fullName}`}
                    successText="Đã đăng xuất người này khỏi mọi thiết bị."
                    variant="secondary"
                    confirm="Người này bị đăng xuất khỏi mọi thiết bị ngay và phải đăng nhập lại."
                    confirmLabel={`Thu hồi phiên của ${m.fullName}`}
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
