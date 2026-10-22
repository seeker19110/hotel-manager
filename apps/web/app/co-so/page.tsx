import { listProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("property.metadata.title") };

const TEMPLATE_LABEL: Record<string, string> = {
  rental: t("property.template.rental"),
  hotel: t("property.template.hotel"),
  mixed: t("property.template.mixed"),
};
// Mẫu Hỗn hợp chỉ mở khi cờ `mixed_template_enabled` bật (SPEC-access S-003) — màn tạo chỉ đưa hai mẫu đã mở.
const CREATE_TEMPLATES = [
  { value: "rental", label: TEMPLATE_LABEL.rental as string },
  { value: "hotel", label: TEMPLATE_LABEL.hotel as string },
];

// SPEC-access-and-property S-001, S-002, S-023: chủ tạo/sửa cơ sở (múi giờ, giờ chốt ngày, giờ nhận/trả phòng). Mọi vai trò nhân viên
// xem được danh sách trong phạm vi; sửa/tạo chỉ owner (quyền thật kiểm ở server). Đổi múi giờ/giờ chốt khi cơ sở đã có giao dịch bị
// từ chối (PROPERTY_IN_USE) — màn hiện đúng thông báo của server.
export default async function PropertiesPage() {
  return withActor(t("property.page.title"), "/co-so", async (actor) => {
    const list = await safe(listProperties(serverContext().db, actor));
    if (!list.ok) return <ErrorState title={t("property.error.load")} text={list.message} />;
    const isOwner = actor.role === "owner";
    return (
      <>
        {list.data.length === 0 ? (
          <EmptyState
            title={t("property.empty.title")}
            text={isOwner ? t("property.empty.owner") : t("property.empty.staff")}
          />
        ) : (
          <ul className="member-list" data-testid="properties">
            {list.data.map((p) => (
              <li key={p.propertyId} className="member-list__item" data-testid="property">
                <h2>{p.name}</h2>
                <p>
                  {t("property.list.meta", {
                    template: TEMPLATE_LABEL[p.template] ?? p.template,
                    timezone: p.timezone,
                    cutoff: p.businessDayCutoff,
                  })}
                  {p.checkInTime ? t("property.list.checkin", { time: p.checkInTime }) : ""}
                  {p.checkOutTime ? t("property.list.checkout", { time: p.checkOutTime }) : ""}
                </p>
                {isOwner ? (
                  <details className="details-box">
                    <summary>{t("property.edit.summary", { name: p.name })}</summary>
                    <CommandForm
                      path="property/update"
                      fixed={{ property_id: p.propertyId }}
                      fields={[
                        {
                          name: "name",
                          label: t("property.field.name"),
                          required: true,
                          maxLength: 200,
                          defaultValue: p.name,
                        },
                        {
                          name: "timezone",
                          label: t("property.field.timezone"),
                          defaultValue: p.timezone,
                          hint: t("property.hint.timezone_edit"),
                        },
                        {
                          name: "business_day_cutoff",
                          label: t("property.field.cutoff"),
                          defaultValue: p.businessDayCutoff,
                          hint: t("property.hint.locked"),
                        },
                        {
                          name: "check_in_time",
                          label: t("property.field.check_in"),
                          defaultValue: p.checkInTime ?? "",
                        },
                        {
                          name: "check_out_time",
                          label: t("property.field.check_out"),
                          defaultValue: p.checkOutTime ?? "",
                        },
                      ]}
                      submitLabel={t("property.edit.submit")}
                      successText={t("property.edit.success")}
                    />
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isOwner ? (
          <section aria-labelledby="new-property-h">
            <h2 id="new-property-h">{t("property.create.heading")}</h2>
            <CommandForm
              path="property/create"
              fields={[
                { name: "name", label: t("property.field.name"), required: true, maxLength: 200 },
                {
                  name: "template",
                  label: t("property.field.template"),
                  type: "select",
                  required: true,
                  options: CREATE_TEMPLATES,
                  defaultValue: "rental",
                },
                {
                  name: "timezone",
                  label: t("property.field.timezone"),
                  hint: t("property.hint.timezone_create"),
                },
                {
                  name: "business_day_cutoff",
                  label: t("property.field.cutoff"),
                  hint: t("property.hint.cutoff_create"),
                },
                {
                  name: "check_in_time",
                  label: t("property.field.check_in"),
                  hint: t("property.hint.hotel_optional"),
                },
                {
                  name: "check_out_time",
                  label: t("property.field.check_out"),
                  hint: t("property.hint.hotel_optional"),
                },
              ]}
              submitLabel={t("property.create.submit")}
              successText={t("property.create.success")}
              testId="property-create-form"
            />
          </section>
        ) : null}
      </>
    );
  });
}
