import { listProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Cơ sở — Hotel Manager" };

const TEMPLATE_LABEL: Record<string, string> = {
  rental: "Nhà trọ",
  hotel: "Khách sạn / nhà nghỉ",
  mixed: "Hỗn hợp",
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
  return withActor("Cơ sở", "/co-so", async (actor) => {
    const list = await safe(listProperties(serverContext().db, actor));
    if (!list.ok) return <ErrorState title="Không tải được danh sách cơ sở" text={list.message} />;
    const isOwner = actor.role === "owner";
    return (
      <>
        {list.data.length === 0 ? (
          <EmptyState
            title="Chưa có cơ sở nào"
            text={isOwner ? "Tạo cơ sở đầu tiên bên dưới để bắt đầu." : "Chủ sở hữu cần tạo cơ sở."}
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
                  {p.checkInTime ? ` · nhận phòng ${p.checkInTime}` : ""}
                  {p.checkOutTime ? ` · trả phòng ${p.checkOutTime}` : ""}
                </p>
                {isOwner ? (
                  <details className="details-box">
                    <summary>Sửa cơ sở — {p.name}</summary>
                    <CommandForm
                      path="property/update"
                      fixed={{ property_id: p.propertyId }}
                      fields={[
                        {
                          name: "name",
                          label: "Tên cơ sở",
                          required: true,
                          maxLength: 200,
                          defaultValue: p.name,
                        },
                        {
                          name: "timezone",
                          label: "Múi giờ (tên IANA)",
                          defaultValue: p.timezone,
                          hint: "Ví dụ Asia/Ho_Chi_Minh. Không đổi được khi cơ sở đã có giao dịch.",
                        },
                        {
                          name: "business_day_cutoff",
                          label: "Giờ chốt ngày (HH:MM)",
                          defaultValue: p.businessDayCutoff,
                          hint: "Không đổi được khi cơ sở đã có giao dịch.",
                        },
                        {
                          name: "check_in_time",
                          label: "Giờ nhận phòng (HH:MM)",
                          defaultValue: p.checkInTime ?? "",
                        },
                        {
                          name: "check_out_time",
                          label: "Giờ trả phòng (HH:MM)",
                          defaultValue: p.checkOutTime ?? "",
                        },
                      ]}
                      submitLabel="Lưu thay đổi"
                      successText="Đã lưu cơ sở."
                    />
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isOwner ? (
          <section aria-labelledby="new-property-h">
            <h2 id="new-property-h">Tạo cơ sở mới</h2>
            <CommandForm
              path="property/create"
              fields={[
                { name: "name", label: "Tên cơ sở", required: true, maxLength: 200 },
                {
                  name: "template",
                  label: "Loại hình",
                  type: "select",
                  required: true,
                  options: CREATE_TEMPLATES,
                  defaultValue: "rental",
                },
                {
                  name: "timezone",
                  label: "Múi giờ (tên IANA)",
                  hint: "Để trống = Asia/Ho_Chi_Minh.",
                },
                { name: "business_day_cutoff", label: "Giờ chốt ngày (HH:MM)", hint: "Để trống = 00:00." },
                {
                  name: "check_in_time",
                  label: "Giờ nhận phòng (HH:MM)",
                  hint: "Khách sạn/nhà nghỉ; có thể để trống.",
                },
                {
                  name: "check_out_time",
                  label: "Giờ trả phòng (HH:MM)",
                  hint: "Khách sạn/nhà nghỉ; có thể để trống.",
                },
              ]}
              submitLabel="Tạo cơ sở"
              successText="Đã tạo cơ sở."
              testId="property-create-form"
            />
          </section>
        ) : null}
      </>
    );
  });
}
