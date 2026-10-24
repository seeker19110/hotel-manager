import { listOpenBreaks, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { vnd } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: t("reconciliation.breaks.metadata.title") };

const reasons = (): Record<string, string> => ({
  WRONG_REFERENCE: t("reconciliation.breaks.reason.wrong_reference"),
  COMBINED: t("reconciliation.breaks.reason.combined"),
  OVERPAID: t("reconciliation.breaks.reason.overpaid"),
  THIRD_PARTY_PAYER: t("reconciliation.breaks.reason.third_party_payer"),
  UNMATCHED: t("reconciliation.breaks.reason.unmatched"),
  HASH_MISMATCH: t("reconciliation.breaks.reason.hash_mismatch"),
});

export default async function BreaksPage() {
  return withActor(t("common.route_title.doi_soat"), "/doi-soat", async (actor) => {
    const REASON = reasons();
    const breaks = await listOpenBreaks(serverContext().db, actor);
    if (breaks.length === 0)
      return (
        <EmptyState
          title={t("reconciliation.breaks.empty.title")}
          text={t("reconciliation.breaks.empty.text")}
        />
      );
    return (
      <ul className="card-list">
        {breaks.map((b) => (
          <li key={b.id} className="card" data-testid="break">
            <p className="card__title">
              {REASON[b.reason] ?? b.reason}
              {b.amount === null ? "" : ` — ${vnd(b.amount)}`}
            </p>
            <p className="card__meta">
              {b.property}
              {b.description ? ` · "${b.description}"` : ""}
            </p>
            <CommandForm
              path="reconciliation/resolveBreak"
              confirm={t("reconciliation.breaks.confirm")}
              confirmLabel={
                b.amount === null
                  ? t("reconciliation.breaks.confirm_label", { reason: REASON[b.reason] ?? b.reason })
                  : t("reconciliation.breaks.confirm_label_amount", {
                      reason: REASON[b.reason] ?? b.reason,
                      amount: vnd(b.amount),
                    })
              }
              fixed={{ break_id: b.id }}
              fields={[{ name: "resolution", label: t("reconciliation.breaks.resolution"), required: true }]}
              submitLabel={t("reconciliation.breaks.submit_label")}
              successText={t("reconciliation.breaks.success")}
              variant="secondary"
            />
          </li>
        ))}
      </ul>
    );
  });
}
