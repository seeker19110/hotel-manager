import { listMyInvoices, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { Money } from "../../components/portal/money.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { day } from "../../lib/format.ts";
import { withPortal } from "../../lib/portal-page.tsx";

export const metadata: Metadata = { title: "Kỳ thu — Hotel Manager" };

// SPEC-portal S-001, S-021: phiếu của kỳ đã phát hành; số dư lấy từ sổ (không tính ở client).
export default async function PortalInvoicesPage() {
  return withPortal("Kỳ thu", "/portal", async ({ actor }) => {
    const invoices = await listMyInvoices(serverContext().db, actor);
    if (invoices.length === 0)
      return (
        <EmptyState
          title="Chưa có kỳ thu nào được phát hành"
          text="Khi chủ trọ phát hành kỳ thu, phiếu sẽ hiện ở đây."
        />
      );
    return (
      <ul className="card-list">
        {invoices.map((i) => (
          <li key={i.id} className="card" data-testid="invoice">
            <a href={`/portal/phieu/${i.id}`} className="card__link">
              <span className="card__title">Kỳ {i.period}</span>
              <span className="card__meta">
                Tổng <Money value={i.total} /> · Hạn {day(i.dueOn)}
              </span>
              <span className="badge" data-status={i.balance > 0 ? "owing" : "paid"}>
                {i.statusLabel}: <Money value={i.balance} testId="invoice-balance" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    );
  });
}
