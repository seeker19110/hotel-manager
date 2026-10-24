import { listOpenInvoices, listPendingPayments, rentalProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { day, vnd } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: t("payment.collect.metadata.title") };

export default async function CollectPage() {
  return withActor(t("common.route_title.thu_tien"), "/thu-tien", async (actor) => {
    const db = serverContext().db;
    const [invoices, pending, properties] = await Promise.all([
      listOpenInvoices(db, actor),
      listPendingPayments(db, actor),
      rentalProperties(db, actor),
    ]);
    const shiftOpen = new Map(properties.map((p) => [p.id, p.open_shift]));
    return (
      <>
        {properties
          .filter((p) => !p.open_shift)
          .map((p) => (
            <section key={p.id} aria-labelledby={`ca-${p.id}`} className="panel">
              <h2 id={`ca-${p.id}`}>{t("shift.form.heading", { name: p.name })}</h2>
              <CommandForm
                path="shift/open"
                fixed={{ property_id: p.id }}
                fields={[
                  {
                    name: "opening_cash",
                    label: t("shift.form.opening_cash"),
                    type: "money",
                    required: true,
                    defaultValue: 0,
                  },
                ]}
                submitLabel={t("shift.form.submit")}
                successText={t("shift.form.success")}
              />
            </section>
          ))}
        <section aria-labelledby="cho" className="panel">
          <h2 id="cho">{t("payment.collect.pending.heading")}</h2>
          {pending.length === 0 ? (
            <EmptyState title={t("payment.collect.pending.empty")} />
          ) : (
            <ul className="card-list">
              {pending.map((p) => (
                <li key={p.id} className="card" data-testid="pending-payment">
                  <p className="card__title">
                    {p.purpose === "deposit"
                      ? t("payment.collect.pending.title_deposit", { amount: vnd(p.amount), payer: p.payer })
                      : t("payment.collect.pending.title_cash", { amount: vnd(p.amount), payer: p.payer })}
                  </p>
                  <p className="card__meta">
                    {t("payment.collect.pending.meta", {
                      method:
                        p.method === "cash"
                          ? t("label.payment_method.cash")
                          : t("label.payment_method.bank_transfer"),
                      property: p.property,
                    })}
                  </p>
                  <CommandForm
                    path="payment/confirm"
                    confirm={t("payment.collect.pending.confirm")}
                    confirmLabel={
                      p.purpose === "deposit"
                        ? t("payment.collect.pending.confirm_label_deposit", {
                            amount: vnd(p.amount),
                            payer: p.payer,
                          })
                        : t("payment.collect.pending.confirm_label_cash", {
                            amount: vnd(p.amount),
                            payer: p.payer,
                          })
                    }
                    fixed={{ payment_id: p.id }}
                    submitLabel={t("payment.collect.pending.submit_label")}
                    successText={t("payment.collect.pending.success")}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="no" className="panel">
          <h2 id="no">{t("payment.collect.open.heading")}</h2>
          {invoices.length === 0 ? (
            <EmptyState title={t("payment.collect.open.empty")} />
          ) : (
            <ul className="card-list">
              {invoices.map((i) => (
                <li key={i.id} className="card" data-testid="open-invoice">
                  <p className="card__title">
                    {i.unit
                      ? t("payment.collect.open.title_unit", {
                          number: i.number,
                          unit: i.unit,
                          payer: i.payer,
                        })
                      : t("payment.collect.open.title", { number: i.number, payer: i.payer })}
                  </p>
                  <p className="card__meta">
                    {t("payment.invoice.meta", { date: day(i.business_date), total: vnd(i.total) })}{" "}
                    <strong data-testid="open-amount">{vnd(i.open_amount)}</strong>
                  </p>
                  {shiftOpen.get(i.property_id) ? (
                    <CommandForm
                      path="payment/collectCash"
                      confirm={t("payment.collect.open.confirm")}
                      confirmLabel={t("payment.collect.open.confirm_label", {
                        amount: "{amount}",
                        number: i.number,
                      })}
                      fixed={{ invoice_id: i.id }}
                      fields={[
                        {
                          name: "amount",
                          label: t("payment.collect.open.amount", { number: i.number }),
                          type: "money",
                          required: true,
                          defaultValue: i.open_amount,
                        },
                      ]}
                      submitLabel={t("payment.collect.open.submit_label")}
                      successText={t("payment.collect.open.success")}
                    />
                  ) : (
                    <p className="card__meta">{t("payment.collect.open.need_shift")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  });
}
