import { previewPeriod, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { month, periodStatusLabel, vnd, vndUnitPrice } from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.period_status.");

export const metadata: Metadata = { title: t("billing.preview.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("billing.preview.page.title"), "/ky-thu", async (actor) => {
    let pv: Awaited<ReturnType<typeof previewPeriod>>;
    try {
      pv = await previewPeriod(serverContext().db, actor, { billingPeriodId: id });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") notFound();
      if (code === "FORBIDDEN")
        return (
          <ErrorState
            title={t("billing.preview.forbidden.title")}
            text={t("billing.preview.forbidden.text")}
          />
        );
      throw e;
    }
    const missing = pv.items.filter((i) => i.missing.length > 0);
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">{t("billing.preview.heading", { month: month(pv.period_start) })}</h2>
          <dl className="facts">
            <dt>{t("billing.preview.fact.status")}</dt>
            <dd data-testid="period-status">{periodStatusLabel(LABELS, pv.status)}</dd>
            <dt>{t("billing.preview.fact.total")}</dt>
            <dd data-testid="period-total">{vnd(pv.total)}</dd>
          </dl>
          {pv.status === "draft" ? (
            <p>
              <a className="btn btn--secondary" href={`/chi-so/${id}`}>
                {t("billing.preview.enter_readings")}
              </a>
            </p>
          ) : null}
        </section>
        {missing.length > 0 ? (
          <div className="banner banner--warn" role="note">
            {t("billing.preview.missing", {
              rooms: missing.map((i) => `${i.unit} (${i.missing.join(", ")})`).join("; "),
            })}
          </div>
        ) : null}
        <section aria-labelledby="xt" className="panel">
          <h2 id="xt">{t("billing.preview.rooms.heading")}</h2>
          {pv.items.length === 0 ? (
            <EmptyState title={t("billing.preview.rooms.empty")} />
          ) : (
            pv.items.map((i) => (
              <table key={i.lease_id} className="lines" data-testid="preview-room">
                <caption>
                  {t("billing.preview.room_total", { unit: i.unit })} <strong>{vnd(i.total)}</strong>
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("billing.preview.col.item")}</th>
                    <th scope="col">{t("billing.preview.col.quantity")}</th>
                    <th scope="col">{t("billing.preview.col.unit_price")}</th>
                    <th scope="col">{t("billing.preview.col.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {i.lines.map((l) => (
                    <tr key={`${l.kind}-${l.description}-${l.periodFrom}`}>
                      <th scope="row">{l.description}</th>
                      <td>{l.quantity}</td>
                      <td>{vndUnitPrice(Number(l.unitPrice))}</td>
                      <td>{vnd(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))
          )}
        </section>
        {pv.status === "draft" ? (
          <section aria-labelledby="a-review" className="panel">
            <h2 id="a-review">{t("billing.preview.review.heading")}</h2>
            <CommandForm
              path="billing/submitForReview"
              fixed={{ billing_period_id: id }}
              submitLabel={t("billing.preview.review.submit_label")}
              successText={t("billing.preview.review.success")}
            />
          </section>
        ) : null}
        {pv.status === "reviewing" ? (
          <section aria-labelledby="a-issue" className="panel">
            <h2 id="a-issue">{t("billing.preview.issue.heading")}</h2>
            <p>{t("billing.preview.issue.intro")}</p>
            <CommandForm
              path="billing/issuePeriod"
              confirm={t("billing.preview.issue.confirm")}
              confirmLabel={t("billing.preview.issue.confirm_label", { month: month(pv.period_start) })}
              fixed={{ billing_period_id: id, preview_hash: pv.preview_hash }}
              submitLabel={t("billing.preview.issue.submit_label")}
              successText={t("billing.preview.issue.success")}
            />
            <CommandForm
              path="billing/returnToDraft"
              fixed={{ billing_period_id: id }}
              fields={[{ name: "reason", label: t("billing.preview.return.reason"), required: true }]}
              submitLabel={t("billing.preview.return.submit_label")}
              successText={t("billing.preview.return.success")}
              variant="secondary"
            />
          </section>
        ) : null}
      </>
    );
  });
}
