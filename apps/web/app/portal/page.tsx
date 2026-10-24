import { listMyInvoices, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { Money } from "../../components/portal/money.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { day } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withPortal } from "../../lib/portal-page.tsx";

export const metadata: Metadata = { title: t("portal.invoice_list.metadata.title") };

// SPEC-portal S-001, S-021: phiếu của kỳ đã phát hành; số dư lấy từ sổ (không tính ở client).
export default async function PortalInvoicesPage() {
  return withPortal(t("portal.invoice_list.page.title"), "/portal", async ({ actor }) => {
    const invoices = await listMyInvoices(serverContext().db, actor);
    if (invoices.length === 0)
      return (
        <EmptyState title={t("portal.invoice_list.empty.title")} text={t("portal.invoice_list.empty.text")} />
      );
    return (
      <ul className="card-list">
        {invoices.map((i) => (
          <li key={i.id} className="card" data-testid="invoice">
            <a href={`/portal/phieu/${i.id}`} className="card__link">
              <span className="card__title">
                {t("portal.invoice_list.card.period", { period: i.period })}
              </span>
              <span className="card__meta">
                {t("portal.invoice_list.card.total")} <Money value={i.total} /> ·{" "}
                {t("portal.invoice_list.card.due", { date: day(i.dueOn) })}
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
