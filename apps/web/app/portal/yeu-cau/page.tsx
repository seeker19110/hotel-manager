import { getMyLease, listMyRequests, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { RequestForm } from "../../../components/portal/request-form.tsx";
import { EmptyState } from "../../../components/ui/state.tsx";
import { t } from "../../../lib/i18n.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: "Yêu cầu — Hotel Manager" };

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
  return withPortal("Yêu cầu", "/portal/yeu-cau", async ({ actor }) => {
    const db = serverContext().db;
    const [requests, leases] = await Promise.all([listMyRequests(db, actor), getMyLease(db, actor)]);
    const units = leases
      .filter((l) => l.status === "active" || l.status === "notice_given")
      .map((l) => ({ unitId: l.unitId, propertyId: l.propertyId, unitCode: l.unitCode }));
    return (
      <>
        <section aria-labelledby="ds" className="panel">
          <h2 id="ds">Yêu cầu của bạn</h2>
          {requests.length === 0 ? (
            <EmptyState
              title="Bạn chưa gửi yêu cầu nào"
              action={
                units.length > 0 ? (
                  <a className="btn" href="#gui-yeu-cau">
                    Gửi yêu cầu
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
                  <p className="card__meta">Cập nhật {r.updatedAtLocal}</p>
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
          <h2 id="gui">Gửi yêu cầu sửa chữa</h2>
          {units.length === 0 ? (
            <EmptyState
              title="Chưa có hợp đồng đang hiệu lực"
              text="Bạn gửi được yêu cầu khi hợp đồng đang hiệu lực."
            />
          ) : (
            <RequestForm units={units} />
          )}
        </section>
      </>
    );
  });
}
