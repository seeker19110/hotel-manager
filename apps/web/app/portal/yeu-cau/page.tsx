import { getMyLease, listMyRequests, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { RequestForm } from "../../../components/portal/request-form.tsx";
import { EmptyState } from "../../../components/ui/state.tsx";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: t("portal.request.metadata.title") };

const ICON: Record<string, string> = {
  open: "○",
  assigned: "◔",
  in_progress: "◑",
  done: "◕",
  verified: "✓",
  cancelled: "✕",
};

// SPEC-portal S-008, S-009: gửi yêu cầu sửa chữa (kèm ảnh) + theo dõi trạng thái; không lộ tên/SĐT nhân viên kỹ thuật.
export default async function PortalRequestsPage() {
  return withPortal(t("portal.request.page.title"), "/portal/yeu-cau", async ({ actor }) => {
    const db = serverContext().db;
    const [requests, leases] = await Promise.all([listMyRequests(db, actor), getMyLease(db, actor)]);
    const units = leases
      .filter((l) => l.status === "active" || l.status === "notice_given")
      .map((l) => ({ unitId: l.unitId, propertyId: l.propertyId, unitCode: l.unitCode }));
    return (
      <>
        <section aria-labelledby="ds" className="panel">
          <h2 id="ds">{t("portal.request.list.heading")}</h2>
          {requests.length === 0 ? (
            <EmptyState
              title={t("portal.request.empty.title")}
              action={
                units.length > 0 ? (
                  <a className="btn" href="#gui-yeu-cau">
                    {t("portal.request.empty.action")}
                  </a>
                ) : undefined
              }
            />
          ) : (
            <ul className="card-list">
              {requests.map((r) => (
                <li key={r.id} className="card" data-testid="request">
                  <p className="card__title">
                    {t("portal.request.title", { title: r.title, unit: r.unitCode })}
                  </p>
                  <p className="card__meta">{t("portal.request.updated", { at: r.updatedAtLocal })}</p>
                  <span className="badge" data-status={r.status}>
                    <span aria-hidden="true">{ICON[r.status] ?? "•"} </span>
                    {r.statusLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="gui" id="gui-yeu-cau" className="panel">
          <h2 id="gui">{t("portal.request.new.heading")}</h2>
          {units.length === 0 ? (
            <EmptyState title={t("portal.request.no_lease.title")} text={t("portal.request.no_lease.text")} />
          ) : (
            <RequestForm units={units} m={messagesFor("request_form.")} />
          )}
        </section>
      </>
    );
  });
}
