import { randomUUID } from "node:crypto";
import { getMyInvoice, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Money } from "../../../../components/portal/money.tsx";
import { EmptyState } from "../../../../components/ui/state.tsx";
import { dateTime } from "../../../../lib/format.ts";
import { t } from "../../../../lib/i18n.ts";
import { withPortal } from "../../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: t("portal.invoice.metadata.title") };

// SPEC-portal S-002…S-004: dòng phiếu + phân bổ; phiếu không thuộc mình → 404 (đã ghi audit ở server).
export default async function PortalInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPortal(t("portal.invoice.page.title"), "/portal", async ({ actor }) => {
    let inv: Awaited<ReturnType<typeof getMyInvoice>>;
    try {
      inv = await getMyInvoice(serverContext().db, actor, id, { correlationId: randomUUID() });
    } catch (e) {
      if ((e as { code?: string }).code === "NOT_FOUND") notFound();
      throw e;
    }
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">{t("portal.invoice.period", { period: inv.period })}</h2>
          <dl className="facts">
            <dt>{t("portal.invoice.facts.total")}</dt>
            <dd>
              <Money value={inv.total} testId="inv-total" />
            </dd>
            <dt>{t("portal.invoice.facts.paid")}</dt>
            <dd>
              <Money value={inv.paid} testId="inv-paid" />
            </dd>
            <dt>{inv.statusLabel}</dt>
            <dd>
              <Money value={inv.balance} testId="inv-balance" />
            </dd>
          </dl>
          {inv.balance > 0 ? (
            <p>
              <a className="btn" href={`/portal/thanh-toan/${inv.id}`}>
                {t("portal.invoice.pay")}
              </a>
            </p>
          ) : null}
        </section>
        <section aria-labelledby="dong" className="panel">
          <h2 id="dong">{t("portal.invoice.lines.heading")}</h2>
          <table className="lines" data-testid="invoice-lines">
            <thead>
              <tr>
                <th scope="col">{t("portal.invoice.lines.col_kind")}</th>
                <th scope="col">{t("portal.invoice.lines.col_amount")}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={`${l.kind}-${l.description}`}>
                  <th scope="row">{l.description}</th>
                  <td>
                    <Money value={l.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section aria-labelledby="pb" className="panel">
          <h2 id="pb">{t("portal.invoice.facts.paid")}</h2>
          {inv.allocations.length === 0 ? (
            <EmptyState title={t("portal.invoice.allocations.empty")} />
          ) : (
            <ul className="card-list">
              {inv.allocations.map((a) => (
                <li
                  key={`${a.allocatedAt.toISOString()}-${a.amount}`}
                  className="card"
                  data-testid="allocation"
                >
                  <Money value={a.amount} />
                  {t("portal.invoice.allocations.confirmed", { at: dateTime(a.allocatedAt, inv.timeZone) })}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  });
}
