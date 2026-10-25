import { myOrgDeletionCertificates, serverContext } from "@hm/app";
import { DEFAULT_TIME_ZONE, dateInZone } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { safe } from "../../lib/safe.ts";
import { currentSession } from "../../lib/session.ts";

/**
 * Chứng nhận xoá tổ chức (T-2312, IND-SAAS-006): chủ cũ (người đã yêu cầu xoá) tải tệp JSON nguyên văn + đối chiếu sha256. Không có
 * chứng nhận ⇒ không hiện gì (đa số người dùng không có).
 */
export async function OrgCertificates() {
  const session = await safe(currentSession());
  if (!session.ok || !session.data) return null;
  const certs = await safe(myOrgDeletionCertificates(serverContext().db, session.data.user.id));
  if (!certs.ok || certs.data.length === 0) return null;
  return (
    <section aria-labelledby="org-certs-heading" className="panel" data-testid="org-certificates">
      <h2 id="org-certs-heading">{t("org_certificates.heading")}</h2>
      <p>{t("org_certificates.intro")}</p>
      <ul className="choice-list">
        {certs.data.map((c) => (
          <li key={c.id} data-testid="org-certificate">
            <p>
              {t("org_certificates.item", {
                org: c.organizationId,
                date: dateInZone(new Date(c.purgedAt), DEFAULT_TIME_ZONE),
              })}
            </p>
            <p>
              {t("org_certificates.sha")} <code>{c.contentSha256}</code>
            </p>
            <a
              className="btn btn--secondary"
              href={`/api/v1/privacy/org-deletion-certificates?id=${encodeURIComponent(c.id)}`}
              download
            >
              {t("org_certificates.download")}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
