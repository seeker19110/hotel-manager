import { listLeases, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState } from "../../components/ui/state.tsx";
import { day, LEASE_STATUS, vnd } from "../../lib/format.ts";
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
              <span className="card__title">
                Phòng {l.unit} — {l.tenant}
              </span>
              <span className="card__meta">
                {l.number} · {l.property} · từ {day(l.billing_start_on)} · {vnd(l.rent_amount)}/tháng
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
