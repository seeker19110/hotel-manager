import { getLease, leaseExtras, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm, type FieldSpec } from "../../../components/command/command-form.tsx";
import { day, leaseStatusLabel, meterLabel, vnd } from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.lease_status.", "label.meter.");

export const metadata: Metadata = { title: t("lease.detail.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("lease.detail.page.title"), "/hop-dong", async (actor) => {
    const db = serverContext().db;
    const x = await leaseExtras(db, actor, id);
    if (!x) notFound();
    const lease = await getLease(db, actor, id);
    const v = lease.versions.at(-1);
    const moveIn = lease.handovers.find((h) => h.kind === "move_in" && h.confirmed_at);
    const moveOut = lease.handovers.find((h) => h.kind === "move_out" && h.confirmed_at);
    const readingFields = (prefix: string): FieldSpec[] =>
      x.meters.map((m) => ({
        name: `${prefix}_${m.kind}`,
        path: `readings.${m.kind}`,
        label: t("lease.detail.reading.label", { kind: meterLabel(LABELS, m.kind)?.toLowerCase() ?? m.kind }),
        type: "decimal",
        required: true,
        hint: t("lease.detail.reading.hint", { last: m.last }),
      }));
    const handoverFixed = (kind: string) => ({
      lease_id: id,
      kind,
      assets: [],
      photo_file_ids: [],
      tenant_confirmation: { method: "in_person" },
    });
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">{t("lease.detail.summary.heading", { unit: x.unit, tenant: x.tenant })}</h2>
          <dl className="facts">
            <dt>{t("lease.detail.fact.number")}</dt>
            <dd>{lease.number}</dd>
            <dt>{t("lease.detail.fact.status")}</dt>
            <dd data-testid="lease-status">{leaseStatusLabel(LABELS, lease.status)}</dd>
            <dt>{t("lease.detail.fact.property")}</dt>
            <dd>{x.property}</dd>
            <dt>{t("lease.detail.fact.phone")}</dt>
            <dd>{x.tenant_phone ?? "—"}</dd>
            <dt>{t("lease.detail.fact.rent")}</dt>
            <dd>{v ? t("lease.detail.fact.rent_value", { rent: vnd(v.rent_amount) }) : "—"}</dd>
            <dt>{t("lease.detail.fact.effective")}</dt>
            <dd>
              {day(v?.effective_from)} –{" "}
              {v?.effective_to ? day(v.effective_to) : t("lease.detail.fact.no_end")}
            </dd>
            <dt>{t("lease.detail.fact.deposit")}</dt>
            <dd data-testid="deposit-balance">
              {x.deposit_balance === null ? t("lease.detail.fact.deposit_none") : vnd(x.deposit_balance)}
            </dd>
            <dt>{t("lease.detail.fact.open_ar")}</dt>
            <dd>{vnd(x.open_ar)}</dd>
          </dl>
        </section>

        {lease.status === "draft" ? (
          <section aria-labelledby="a-submit" className="panel">
            <h2 id="a-submit">{t("lease.detail.submit.heading")}</h2>
            <CommandForm
              path="lease/submitForSignature"
              fixed={{ lease_id: id }}
              submitLabel={t("lease.detail.submit.submit_label")}
              successText={t("lease.detail.submit.success")}
            />
          </section>
        ) : null}

        {lease.status === "pending_signature" ? (
          <section aria-labelledby="a-sign" className="panel">
            <h2 id="a-sign">{t("lease.detail.sign.heading")}</h2>
            <p>{t("lease.detail.sign.intro")}</p>
            <CommandForm
              path="lease/sign"
              confirm={t("lease.detail.sign.confirm")}
              confirmLabel={t("lease.detail.sign.confirm_label", { number: lease.number })}
              fixed={{ lease_id: id, signer_person_id: lease.representative_person_id }}
              submitLabel={t("lease.detail.sign.submit_label")}
              successText={t("lease.detail.sign.success")}
            />
          </section>
        ) : null}

        {lease.status === "signed_awaiting_handover" && !moveIn ? (
          <section aria-labelledby="a-in" className="panel">
            <h2 id="a-in">{t("lease.detail.move_in.heading")}</h2>
            <CommandForm
              path="lease/recordHandover"
              fixed={handoverFixed("move_in")}
              fields={[
                {
                  name: "handed_over_on",
                  label: t("lease.detail.move_in.date"),
                  type: "date",
                  required: true,
                  defaultValue: lease.billing_start_on,
                },
                ...readingFields("in"),
                {
                  name: "keys_count",
                  label: t("lease.detail.move_in.keys"),
                  type: "integer",
                  required: true,
                  defaultValue: 2,
                },
              ]}
              submitLabel={t("lease.detail.move_in.submit_label")}
              successText={t("lease.detail.move_in.success")}
            />
          </section>
        ) : null}

        {lease.status === "signed_awaiting_handover" && moveIn ? (
          <section aria-labelledby="a-act" className="panel">
            <h2 id="a-act">{t("lease.detail.activate.heading")}</h2>
            <p>{t("lease.detail.activate.handed_over", { date: day(moveIn.handed_over_on) })}</p>
            <CommandForm
              path="lease/activate"
              confirm={t("lease.detail.activate.confirm")}
              confirmLabel={t("lease.detail.activate.confirm_label", { number: lease.number })}
              fixed={{ lease_id: id }}
              submitLabel={t("lease.detail.activate.submit_label")}
              successText={t("lease.detail.activate.success")}
            />
          </section>
        ) : null}

        {["active", "notice_given"].includes(lease.status) && x.deposit_balance === null ? (
          <section aria-labelledby="a-dep" className="panel">
            <h2 id="a-dep">{t("lease.detail.deposit.heading")}</h2>
            {x.open_shift ? (
              <CommandForm
                path="deposit/receive"
                confirm={t("lease.detail.deposit.confirm")}
                confirmLabel={t("lease.detail.deposit.confirm_label", {
                  amount: "{amount}",
                  number: lease.number,
                })}
                fixed={{
                  property_id: lease.property_id,
                  lease_id: id,
                  payer_person_id: lease.representative_person_id,
                  method: "cash",
                }}
                fields={[
                  {
                    name: "amount",
                    label: t("lease.detail.deposit.amount"),
                    type: "money",
                    required: true,
                    defaultValue: v?.deposit_amount ?? "",
                  },
                ]}
                submitLabel={t("lease.detail.deposit.submit_label")}
                successText={t("lease.detail.deposit.success")}
              />
            ) : (
              <p>
                {t("lease.detail.deposit.need_shift")}{" "}
                <a className="btn btn--secondary" href="/thu-tien">
                  {t("lease.detail.deposit.to_cash")}
                </a>
              </p>
            )}
          </section>
        ) : null}

        {lease.status === "active" ? (
          <section aria-labelledby="a-notice" className="panel">
            <h2 id="a-notice">{t("lease.detail.notice.heading")}</h2>
            <CommandForm
              path="lease/giveNotice"
              confirm={t("lease.detail.notice.confirm")}
              confirmLabel={t("lease.detail.notice.confirm_label", {
                unit: x.unit,
                number: lease.number,
                planned_move_out_on: "{planned_move_out_on}",
              })}
              fixed={{ lease_id: id }}
              fields={[
                {
                  name: "planned_move_out_on",
                  label: t("lease.detail.notice.date"),
                  type: "date",
                  required: true,
                },
              ]}
              submitLabel={t("lease.detail.notice.submit_label")}
              successText={t("lease.detail.notice.success")}
              variant="secondary"
            />
          </section>
        ) : null}

        {["active", "notice_given"].includes(lease.status) && !moveOut ? (
          <section aria-labelledby="a-out" className="panel">
            <h2 id="a-out">{t("lease.detail.move_out.heading")}</h2>
            <CommandForm
              path="lease/recordHandover"
              confirm={t("lease.detail.move_out.confirm")}
              confirmLabel={t("lease.detail.move_out.confirm_label", {
                unit: x.unit,
                number: lease.number,
                handed_over_on: "{handed_over_on}",
              })}
              fixed={handoverFixed("move_out")}
              fields={[
                {
                  name: "handed_over_on",
                  label: t("lease.detail.move_out.date"),
                  type: "date",
                  required: true,
                },
                ...readingFields("out"),
                {
                  name: "keys_count",
                  label: t("lease.detail.move_out.keys"),
                  type: "integer",
                  required: true,
                  defaultValue: 2,
                },
              ]}
              submitLabel={t("lease.detail.move_out.submit_label")}
              successText={t("lease.detail.move_out.success")}
              variant="secondary"
            />
          </section>
        ) : null}

        {lease.status === "settling" ? (
          <section aria-labelledby="a-settle" className="panel">
            <h2 id="a-settle">{t("lease.detail.settle.heading")}</h2>
            <p>{t("lease.detail.settle.intro")}</p>
            <CommandForm
              path="lease/prepareSettlement"
              confirm={t("lease.detail.settle.confirm")}
              confirmLabel={t("lease.detail.settle.confirm_label", { number: lease.number })}
              fixed={{ lease_id: id, fees: [] }}
              submitLabel={t("lease.detail.settle.submit_label")}
              successText={t("lease.detail.settle.success")}
            />
          </section>
        ) : null}
      </>
    );
  });
}
