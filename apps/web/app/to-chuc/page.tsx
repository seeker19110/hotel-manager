import {
  accountHasPassword,
  listMyExports,
  ORG_DELETION_GRACE_DAYS,
  orgDeletionStatus,
  serverContext,
} from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CommandForm } from "../../components/command/command-form.tsx";
import {
  CancelOrgDeletion,
  DownloadOrgExport,
  RequestOrgDeletion,
} from "../../components/tenancy/org-deletion.tsx";
import { DEFAULT_TIME_ZONE, dateTime } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: t("org_page.metadata.title") };

// Trang Tổ chức của owner (PLAN T-2312; IND-SAAS-006, UX-CONTENT-005; D-125): xuất toàn bộ dữ liệu tổ chức (S-018, có sẵn) và
// "Xoá tổ chức" — nêu rõ 30 ngày giữ, phần sẽ bị xoá, phần còn lại, xác thực lại. Khi tổ chức `pending_deletion`, MỌI trang khác
// chuyển về đây (lib/page.tsx): biểu ngữ trạng thái + huỷ một bước + xuất dữ liệu; thành viên khác chỉ thấy biểu ngữ.
const when = (d: Date) => dateTime(d, DEFAULT_TIME_ZONE);

const EXPORT_STATUS = {
  queued: () => t("org_page.export.status.queued"),
  running: () => t("org_page.export.status.running"),
  ready: () => t("org_page.export.status.ready"),
  failed: () => t("org_page.export.status.failed"),
  expired: () => t("org_page.export.status.expired"),
} as const;

export default async function OrganizationPage() {
  return withActor(
    t("org_page.page.title"),
    "/to-chuc",
    async (actor) => {
      const db = serverContext().db;
      const status = await orgDeletionStatus(db, actor);
      const pending = status.status === "pending_deletion";
      if (!pending && actor.role === "tenant") redirect("/portal");
      const owner = actor.role === "owner";
      const m = messagesFor("org_deletion.", "tenant_login_form.", "auth_form.");
      const exports = owner ? (await listMyExports(db, actor)).filter((e) => e.kind === "org_full") : [];
      const hasPassword = owner && !pending ? await accountHasPassword(db, actor.authUserId) : false;
      return (
        <>
          {pending && status.dueAt ? (
            <div className="banner banner--warn" role="status" data-testid="org-pending-banner">
              <h2>{t("org_page.pending.title")}</h2>
              <p>
                {t("org_page.pending.text", {
                  due: when(status.dueAt),
                  days: ORG_DELETION_GRACE_DAYS,
                })}
              </p>
              {owner ? (
                <>
                  <p>
                    <a className="btn btn--secondary" href="#xuat-du-lieu">
                      {t("org_page.pending.export_link")}
                    </a>
                  </p>
                  <CancelOrgDeletion m={m} />
                </>
              ) : (
                <p>{t("org_page.pending.ask_owner")}</p>
              )}
            </div>
          ) : null}

          <section aria-labelledby="xuat-du-lieu" className="panel">
            <h2 id="xuat-du-lieu">{t("org_page.export.title")}</h2>
            <p>{t("org_page.export.text")}</p>
            {owner ? (
              <>
                <CommandForm
                  path="/api/v1/exports/requestOrgExport"
                  submitLabel={t("org_page.export.request")}
                  successText={t("org_page.export.requested")}
                  variant="secondary"
                  testId="org-export-request"
                />
                {exports.length > 0 ? (
                  <ul className="card-list" data-testid="org-export-list">
                    {exports.map((e) => (
                      <li key={e.exportId} className="card">
                        <p>
                          {t("org_page.export.item", {
                            when: when(e.createdAt),
                            status: EXPORT_STATUS[e.status](),
                          })}
                        </p>
                        {e.status === "ready" ? <DownloadOrgExport exportId={e.exportId} m={m} /> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p>{t("org_page.export.owner_only")}</p>
            )}
          </section>

          {owner && !pending ? (
            <section aria-labelledby="xoa-to-chuc" className="panel" data-testid="org-delete-card">
              <h2 id="xoa-to-chuc">{t("org_page.delete.title")}</h2>
              <p>{t("org_page.delete.text", { days: ORG_DELETION_GRACE_DAYS })}</p>
              <p>
                <a className="btn btn--secondary" href="#xuat-du-lieu">
                  {t("org_page.delete.export_first")}
                </a>
              </p>
              <h3>{t("org_page.delete.removed_title")}</h3>
              <ul>
                <li>{t("org_page.delete.removed.operations")}</li>
                <li>{t("org_page.delete.removed.people")}</li>
                <li>{t("org_page.delete.removed.money")}</li>
                <li>{t("org_page.delete.removed.files")}</li>
                <li>{t("org_page.delete.removed.members")}</li>
              </ul>
              <h3>{t("org_page.delete.kept_title")}</h3>
              <ul>
                <li>{t("org_page.delete.kept.accounts")}</li>
                <li>{t("org_page.delete.kept.certificate")}</li>
              </ul>
              <p>{t("org_page.delete.legal")}</p>
              <RequestOrgDeletion hasPassword={hasPassword} m={m} />
            </section>
          ) : null}
        </>
      );
    },
    { allowPendingDeletion: true },
  );
}
