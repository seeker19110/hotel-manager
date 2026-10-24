import { listMyMeterReadings, serverContext } from "@hm/app";
import { safeUrl } from "@hm/app/http";
import type { Metadata } from "next";
import { EmptyState } from "../../../components/ui/state.tsx";
import { day, decimal, METER_LABEL } from "../../../lib/format.ts";
import { t } from "../../../lib/i18n.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: t("portal.meter.metadata.title") };

// SPEC-portal S-007: chỉ chỉ số đã duyệt; ảnh qua URL ký ngắn hạn (mở bằng liên kết — CSP không cho ảnh ngoài origin).
export default async function PortalMetersPage() {
  return withPortal(t("portal.meter.page.title"), "/portal/dien-nuoc", async ({ actor }) => {
    const rows = await listMyMeterReadings(serverContext().db, actor, serverContext().services);
    if (rows.length === 0)
      return <EmptyState title={t("portal.meter.empty.title")} text={t("portal.meter.empty.text")} />;
    return (
      <ul className="card-list">
        {rows.map((r) => (
          <li key={r.id} className="card" data-testid="reading">
            <p className="card__title">
              {METER_LABEL[r.kind] ?? r.kind}: {decimal(r.value)}
            </p>
            <p className="card__meta">{t("portal.meter.card.read_on", { date: day(r.readOn) })}</p>
            {safeUrl(r.photoUrl) ? (
              <a
                className="btn btn--secondary"
                href={safeUrl(r.photoUrl) as string}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("portal.meter.card.photo_link", { date: day(r.readOn) })}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    );
  });
}
