import { getMyLease, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { Money } from "../../../components/portal/money.tsx";
import { EmptyState } from "../../../components/ui/state.tsx";
import { day, leaseStatusLabel } from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.lease_status.");

export const metadata: Metadata = { title: t("portal.lease.metadata.title") };

// SPEC-portal S-006: phiên bản điều khoản đang hiệu lực + cọc tách nhãn; không hiện giấy tờ (Q-08).
export default async function PortalLeasePage() {
  return withPortal(t("route_title.portal_contract"), "/portal/hop-dong", async ({ actor }) => {
    const leases = await getMyLease(serverContext().db, actor);
    if (leases.length === 0) return <EmptyState title={t("portal.lease.empty")} />;
    return (
      <ul className="card-list">
        {leases.map((l) => (
          <li key={l.id} className="card" data-testid="lease">
            <p className="card__title">{t("portal.lease.title", { number: l.number, unit: l.unitCode })}</p>
            <dl className="facts">
              <dt>{t("portal.lease.fact.status")}</dt>
              <dd>{leaseStatusLabel(LABELS, l.status)}</dd>
              {l.currentVersion ? (
                <>
                  <dt>{t("portal.lease.fact.terms")}</dt>
                  <dd data-testid="lease-version">
                    {t("portal.lease.version", {
                      version: l.currentVersion.versionNo,
                      from: day(l.currentVersion.effectiveFrom),
                    })}
                  </dd>
                  <dt>{t("portal.lease.fact.rent")}</dt>
                  <dd>
                    <Money value={l.currentVersion.rentAmount} />
                  </dd>
                </>
              ) : null}
              <dt>{l.deposit.label}</dt>
              <dd>
                <Money value={l.deposit.amount} testId="deposit-amount" />{" "}
                {t("portal.lease.deposit.received")} <Money value={l.deposit.balance} />)
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  });
}
