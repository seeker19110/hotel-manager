import { listLeases, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState } from "../../components/ui/state.tsx";
import { day, leaseStatusLabel, vnd } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.lease_status.");

export const metadata: Metadata = { title: t("lease.list.metadata.title") };

export default async function LeasesPage() {
  return withActor(t("common.route_title.hop_dong"), "/hop-dong", async (actor) => {
    const leases = await listLeases(serverContext().db, actor);
    if (leases.length === 0)
      return <EmptyState title={t("lease.list.empty.title")} text={t("lease.list.empty.text")} />;
    return (
      <ul className="card-list">
        {leases.map((l) => (
          <li key={l.id} className="card" data-testid="lease">
            <a href={`/hop-dong/${l.id}`} className="card__link">
              <span className="card__title">{t("lease.list.title", { unit: l.unit, tenant: l.tenant })}</span>
              <span className="card__meta">
                {t("lease.list.meta", {
                  number: l.number,
                  property: l.property,
                  start: day(l.billing_start_on),
                  rent: vnd(l.rent_amount),
                })}
              </span>
              <span className="badge" data-status={l.status}>
                {leaseStatusLabel(LABELS, l.status)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    );
  });
}
