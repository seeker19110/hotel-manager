import { listBillingPeriods, rentalProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { month, periodStatusLabel, vnd } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.period_status.");

export const metadata: Metadata = { title: t("billing.list.metadata.title") };

export default async function PeriodsPage() {
  return withActor(t("common.route_title.ky_thu"), "/ky-thu", async (actor) => {
    const db = serverContext().db;
    const [periods, properties] = await Promise.all([
      listBillingPeriods(db, actor),
      rentalProperties(db, actor),
    ]);
    return (
      <>
        {properties.map((p) => (
          <section key={p.id} aria-labelledby={`tao-${p.id}`} className="panel">
            <h2 id={`tao-${p.id}`}>{t("billing.list.create.heading", { name: p.name })}</h2>
            <CommandForm
              path="billing/createPeriod"
              fixed={{ property_id: p.id }}
              fields={[
                {
                  name: "month",
                  label: t("billing.list.create.month"),
                  required: true,
                  defaultValue: p.local_month,
                },
              ]}
              submitLabel={t("billing.list.create.submit_label")}
              successText={t("billing.list.create.success")}
              testId={`create-period-${p.id}`}
            />
          </section>
        ))}
        <section aria-labelledby="ds" className="panel">
          <h2 id="ds">{t("billing.list.heading")}</h2>
          {periods.length === 0 ? (
            <EmptyState title={t("billing.list.empty.title")} text={t("billing.list.empty.text")} />
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
                      {periodStatusLabel(LABELS, b.status)}
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
