import { ORG_DELETION_GRACE_DAYS, orgDeletionStatus, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("org_page.metadata.title") };

// Trang Tổ chức (T-2312; IND-SAAS-006, UX-CONTENT-005; D-121): khối "Xoá tổ chức" cho owner — nói rõ cái bị xoá, cái được giữ kèm lý
// do, 30 ngày chờ (chỉ xem + xuất, huỷ một bước); xác nhận = gõ lại tên tổ chức + MỘT nút (không hộp thoại thêm, không đếm ngược, không
// câu bêu xấu). Xuất toàn bộ dữ liệu trước khi xoá (owner). Quyền thật kiểm ở server (`org.delete`, `exports.requestOrgExport`).
export default async function OrganizationPage() {
  return withActor(t("org_page.page.title"), "/to-chuc", async (actor) => {
    if (actor.role !== "owner") return <EmptyState title={t("org_deletion.owner_only")} />;
    const st = await safe(orgDeletionStatus(serverContext().db, actor));
    if (!st.ok) return <ErrorState title={t("org_page.page.title")} text={t("org_deletion.failed")} />;
    return (
      <>
        <section aria-labelledby="org-export" className="panel">
          <h2 id="org-export">{t("org_deletion.export.heading")}</h2>
          <p>{t("org_deletion.export.intro")}</p>
          <CommandForm
            path="exports/requestOrgExport"
            submitLabel={t("org_deletion.export.submit")}
            successText={t("org_deletion.export.success")}
            variant="secondary"
            testId="org-export"
          />
        </section>
        <section aria-labelledby="org-delete" className="panel" data-testid="org-delete">
          <h2 id="org-delete">{t("org_deletion.heading")}</h2>
          {st.data.state === "pending" ? (
            <p>{t("org_deletion.already_pending")}</p>
          ) : (
            <>
              <p>{t("org_deletion.intro", { days: ORG_DELETION_GRACE_DAYS })}</p>
              <p>{t("org_deletion.erased")}</p>
              <p>{t("org_deletion.retained")}</p>
              <CommandForm
                path="org/requestDeletion"
                fields={[
                  {
                    name: "confirm_name",
                    label: t("org_deletion.confirm_label"),
                    hint: t("org_deletion.confirm_hint"),
                    required: true,
                    maxLength: 200,
                  },
                ]}
                submitLabel={t("org_deletion.submit")}
                successText={t("org_deletion.success")}
                testId="org-delete-form"
              />
            </>
          )}
        </section>
      </>
    );
  });
}
