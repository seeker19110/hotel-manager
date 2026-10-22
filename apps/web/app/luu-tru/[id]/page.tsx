import { getFolio, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { ShiftPanel } from "../../../components/hotel/shift-panel.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import {
  CHARGE_KIND,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  STAY_STATUS,
  vnd,
  vndUnitPrice,
} from "../../../lib/format.ts";
import { t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: t("stay.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = ["owner", "manager", "front_desk"];

// SPEC-reservation-stay S-017…S-020, S-026, S-027: folio (cọc tách riêng, INV-F5), dịch vụ, trả phòng với tiền mặt trong ca của mình.
export default async function StayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("stay.page.title"), "/dat-phong", async (actor) => {
    const db = serverContext().db;
    const r = await safe(getFolio(db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title={t("stay.error.load")} text={r.message} />;
    }
    const f = r.data;
    const props = await safe(opsProperties(db, actor));
    const property = props.ok ? props.data.find((p) => p.id === f.propertyId) : undefined;
    const canManage = MANAGE.includes(actor.role);
    const inHouse = f.stayStatus === "in_house";
    const owes = f.balance > 0;
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">{t("stay.room.heading", { code: f.unitCode })}</h2>
          <dl className="facts">
            <dt>{t("stay.facts.status")}</dt>
            <dd>
              <StatusBadge
                status={f.stayStatus}
                label={STAY_STATUS[f.stayStatus] ?? f.stayStatus}
                testId="stay-status"
              />
            </dd>
            <dt>{t("stay.facts.charges")}</dt>
            <dd data-testid="folio-charges">{vnd(f.chargesTotal)}</dd>
            <dt>{t("stay.facts.paid")}</dt>
            <dd data-testid="folio-paid">{vnd(f.paidTotal)}</dd>
            <dt>{t("stay.facts.balance")}</dt>
            <dd data-testid="folio-balance">{vnd(f.balance)}</dd>
            <dt>{t("stay.facts.deposit")}</dt>
            <dd data-testid="folio-deposit">
              {f.deposit ? vnd(f.deposit.balance) : t("stay.facts.deposit_none")}
            </dd>
          </dl>
          <p>
            <a className="btn btn--secondary" href={`/dat-phong/${f.reservationId}`}>
              {t("stay.link.reservation")}
            </a>
          </p>
        </section>

        <section aria-labelledby="khoan" className="panel">
          <h2 id="khoan">{t("stay.charges.heading")}</h2>
          <table className="lines">
            <caption>{t("stay.charges.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("stay.charges.col_kind")}</th>
                <th scope="col">{t("stay.charges.col_amount")}</th>
              </tr>
            </thead>
            <tbody>
              {f.charges.map((c) => (
                <tr key={c.id} data-testid="charge">
                  <th scope="row">
                    {CHARGE_KIND[c.kind] ?? c.kind}: {c.description}
                    {c.quantity > 1
                      ? t("stay.charges.quantity", { quantity: c.quantity, price: vndUnitPrice(c.unitPrice) })
                      : ""}
                    {c.voided ? t("stay.charges.voided") : ""}
                  </th>
                  <td>{c.voided ? <s>{vnd(c.amount)}</s> : vnd(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.payments.length > 0 ? (
            <ul className="card-list" aria-label={t("stay.payments.aria")}>
              {f.payments.map((p) => (
                <li key={p.id} className="card" data-testid="folio-payment">
                  {PAYMENT_METHOD[p.method] ?? p.method} {vnd(p.amount)} —{" "}
                  {PAYMENT_STATUS[p.status] ?? p.status}
                  {p.receiptNo ? t("stay.payments.receipt", { receipt: p.receiptNo }) : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {canManage && inHouse ? (
          <section aria-labelledby="dv" className="panel">
            <h2 id="dv">{t("stay.add.heading")}</h2>
            <CommandForm
              path="stay/postCharge"
              fixed={{ stay_id: id }}
              fields={[
                {
                  name: "kind",
                  label: t("stay.add.kind"),
                  type: "select",
                  defaultValue: "service",
                  options: [
                    { value: "service", label: t("stay.add.kind_service") },
                    { value: "fee", label: t("stay.add.kind_fee") },
                    { value: "discount", label: t("stay.add.kind_discount") },
                  ],
                },
                { name: "description", label: t("stay.add.description"), required: true, maxLength: 500 },
                {
                  name: "quantity",
                  label: t("stay.add.quantity"),
                  type: "integer",
                  defaultValue: 1,
                  required: true,
                },
                { name: "unit_price", label: t("stay.add.unit_price"), type: "money", required: true },
              ]}
              submitLabel={t("stay.add.submit")}
              successText={t("stay.add.success")}
              testId="charge-form"
            />
            {f.charges
              .filter((c) => !c.voided && c.kind !== "room")
              .map((c) => (
                <details key={c.id} className="details-box">
                  <summary>{t("stay.void.summary", { description: c.description })}</summary>
                  <CommandForm
                    path="stay/voidCharge"
                    confirm={t("stay.void.confirm")}
                    confirmLabel={t("stay.void.confirm_label", {
                      description: c.description,
                      room: f.unitCode,
                    })}
                    fixed={{ charge_id: c.id }}
                    fields={[
                      {
                        name: "reason",
                        label: t("stay.void.reason", { description: c.description }),
                        required: true,
                        maxLength: 1000,
                      },
                    ]}
                    submitLabel={t("stay.void.submit")}
                    successText={t("stay.void.success")}
                    variant="secondary"
                  />
                </details>
              ))}
          </section>
        ) : null}

        {canManage && inHouse ? (
          <section aria-labelledby="out" className="panel">
            <h2 id="out">{t("stay.checkout.heading")}</h2>
            {property ? <ShiftPanel property={property} /> : null}
            {/* key theo số tiền: form mount lại khi folio đổi → ô tiền luôn mặc định đúng số còn lại */}
            {owes ? (
              <>
                <p>
                  {t("stay.checkout.owes_before")}
                  <strong>{vnd(f.balance)}</strong>
                  {t("stay.checkout.owes_after")}
                </p>
                <CommandForm
                  key={`cash-${f.balance}`}
                  path="stay/checkOut"
                  confirm={t("stay.checkout.confirm")}
                  confirmLabel={t("stay.checkout.cash_label", { cash: "{cash}", room: f.unitCode })}
                  fixed={{ stay_id: id, payments: [{ method: "cash" }] }}
                  fields={[
                    {
                      name: "cash",
                      path: "payments.0.amount",
                      label: t("stay.checkout.cash_field"),
                      type: "money",
                      required: true,
                      defaultValue: f.balance,
                    },
                  ]}
                  submitLabel={t("stay.checkout.cash_submit")}
                  successText={t("stay.checkout.cash_success")}
                  testId="checkout-cash"
                />
                <p className="card__meta">{t("stay.checkout.debt_note")}</p>
              </>
            ) : f.deposit && f.deposit.balance > 0 ? (
              <>
                <CommandForm
                  key={`refund-${f.deposit.balance}`}
                  path="stay/checkOut"
                  confirm={t("stay.checkout.confirm")}
                  confirmLabel={t("stay.checkout.refund_label", { refund: "{refund}", room: f.unitCode })}
                  fixed={{ stay_id: id, deposit_refund: { method: "cash" } }}
                  fields={[
                    {
                      name: "refund",
                      path: "deposit_refund.amount",
                      label: t("stay.checkout.refund_field"),
                      type: "money",
                      required: true,
                      defaultValue: f.deposit.balance,
                    },
                  ]}
                  submitLabel={t("stay.checkout.refund_submit")}
                  successText={t("stay.checkout.refund_success")}
                  testId="checkout-refund"
                />
                <CommandForm
                  path="stay/checkOut"
                  confirm={t("stay.checkout.confirm")}
                  confirmLabel={t("stay.checkout.keep_label", { room: f.unitCode })}
                  fixed={{ stay_id: id }}
                  submitLabel={t("stay.checkout.keep_submit")}
                  successText={t("stay.checkout.success")}
                  variant="secondary"
                />
              </>
            ) : (
              <CommandForm
                path="stay/checkOut"
                confirm={t("stay.checkout.confirm")}
                confirmLabel={t("stay.checkout.plain_label", { room: f.unitCode })}
                fixed={{ stay_id: id }}
                submitLabel={t("stay.checkout.plain_submit")}
                successText={t("stay.checkout.success")}
                testId="checkout-plain"
              />
            )}
          </section>
        ) : null}

        {f.stayStatus === "checked_out" ? (
          <p>
            <a className="btn" href="/buong-phong">
              {t("stay.link.housekeeping")}
            </a>
          </p>
        ) : null}
      </>
    );
  });
}
