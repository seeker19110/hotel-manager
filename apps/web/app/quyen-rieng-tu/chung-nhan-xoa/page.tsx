import { listOrgDeletionCertificates, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "../../../components/ui/state.tsx";
import { DEFAULT_TIME_ZONE, dateTime } from "../../../lib/format.ts";
import { t } from "../../../lib/i18n.ts";
import { currentSession } from "../../../lib/session.ts";

export const metadata: Metadata = { title: t("org_certificate_page.metadata.title") };

// Chứng nhận xoá tổ chức (PLAN T-2312, IND-SAAS-006; D-125) của CHÍNH người đã yêu cầu xoá — theo tài khoản (RLS `app.user_id`),
// không cần ngữ cảnh tổ chức (tổ chức đã không còn). Nêu mã tổ chức, các mốc thời gian, số hàng đã xoá theo bảng, số tệp và mã
// SHA-256 để đối chiếu.
const when = (d: Date) => dateTime(d, DEFAULT_TIME_ZONE);

export default async function OrgDeletionCertificatesPage() {
  const session = await currentSession();
  if (!session) redirect("/dang-nhap");
  const certs = await listOrgDeletionCertificates(serverContext().db, session.user.id);
  return (
    <main id="main" className="page">
      <h1>{t("org_certificate_page.page.title")}</h1>
      <p>{t("org_certificate_page.intro")}</p>
      {certs.length === 0 ? (
        <EmptyState title={t("org_certificate_page.empty")} />
      ) : (
        <ul className="card-list" data-testid="org-certificates">
          {certs.map((c) => (
            <li key={c.id} className="card" data-testid="org-certificate">
              <h2>{t("org_certificate_page.item.title", { purged: when(c.purgedAt) })}</h2>
              <dl className="privacy-facts">
                <dt>{t("org_certificate_page.item.organization")}</dt>
                <dd>{c.organizationId}</dd>
                <dt>{t("org_certificate_page.item.requested")}</dt>
                <dd>{when(c.requestedAt)}</dd>
                <dt>{t("org_certificate_page.item.purged")}</dt>
                <dd>{when(c.purgedAt)}</dd>
                <dt>{t("org_certificate_page.item.rows")}</dt>
                <dd data-testid="org-certificate-rows">{c.totalRows}</dd>
                <dt>{t("org_certificate_page.item.files")}</dt>
                <dd>{c.objectsDeleted}</dd>
                <dt>{t("org_certificate_page.item.digest")}</dt>
                <dd>
                  <code>{c.digest}</code>
                </dd>
              </dl>
              <details>
                <summary>{t("org_certificate_page.item.tables")}</summary>
                <ul>
                  {Object.entries(c.counts)
                    .filter(([, n]) => n > 0)
                    .map(([table, n]) => (
                      <li key={table}>{t("org_certificate_page.item.table_row", { table, n })}</li>
                    ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a className="btn btn--secondary" href="/quyen-rieng-tu">
          {t("org_certificate_page.back")}
        </a>
      </p>
    </main>
  );
}
