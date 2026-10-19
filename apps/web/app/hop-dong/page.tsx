import { listLeases, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState } from "../../components/ui/state.tsx";
import { day, LEASE_STATUS, vnd } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Hợp đồng — Hotel Manager" };

export default async function LeasesPage() {
  return withActor("Hợp đồng", "/hop-dong", async (actor) => {
    const leases = await listLeases(serverContext().db, actor);
    if (leases.length === 0)
      return (
        <EmptyState title="Chưa có hợp đồng" text="Hợp đồng nhập từ sổ cũ hoặc lập mới sẽ hiện ở đây." />
      );
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
                {LEASE_STATUS[l.status] ?? l.status}
              </span>
            </a>
          </li>
        ))}
      </ul>
    );
  });
}
