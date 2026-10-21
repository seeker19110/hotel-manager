import { listBillingPeriods, rentalProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { month, PERIOD_STATUS, vnd } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Kỳ thu — Hotel Manager" };

export default async function PeriodsPage() {
  return withActor("Kỳ thu", "/ky-thu", async (actor) => {
    const db = serverContext().db;
    const [periods, properties] = await Promise.all([
      listBillingPeriods(db, actor),
      rentalProperties(db, actor),
    ]);
    return (
      <>
        {properties.map((p) => (
          <section key={p.id} aria-labelledby={`tao-${p.id}`} className="panel">
            <h2 id={`tao-${p.id}`}>Tạo kỳ — {p.name}</h2>
            <CommandForm
              path="billing/createPeriod"
              fixed={{ property_id: p.id }}
              fields={[
                { name: "month", label: "Tháng (YYYY-MM)", required: true, defaultValue: p.local_month },
              ]}
              submitLabel="Tạo kỳ"
              successText="Đã có kỳ thu cho tháng này."
              testId={`create-period-${p.id}`}
            />
          </section>
        ))}
        <section aria-labelledby="ds" className="panel">
          <h2 id="ds">Các kỳ</h2>
          {periods.length === 0 ? (
            <EmptyState title="Chưa có kỳ thu" text="Kỳ được tạo tự động đầu tháng, hoặc tạo ở trên." />
          ) : (
            <ul className="card-list">
              {periods.map((b) => (
                <li key={b.id} className="card" data-testid="period">
                  <a href={`/ky-thu/${b.id}`} className="card__link">
                    <span className="card__title">
                      {t("billing.period.title", { month: month(b.period_start), property: b.property })}
                    </span>
                    <span className="card__meta">
                      {t("billing.period.meta", { invoices: b.invoices, total: vnd(b.total) })}
                    </span>
                    <span className="badge" data-status={b.status}>
                      {PERIOD_STATUS[b.status] ?? b.status}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  });
}
