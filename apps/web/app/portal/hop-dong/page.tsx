import { getMyLease, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { Money } from "../../../components/portal/money.tsx";
import { EmptyState } from "../../../components/ui/state.tsx";
import { day, LEASE_STATUS } from "../../../lib/format.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: "Hợp đồng — Hotel Manager" };

// SPEC-portal S-006: phiên bản điều khoản đang hiệu lực + cọc tách nhãn; không hiện giấy tờ (Q-08).
export default async function PortalLeasePage() {
  return withPortal("Hợp đồng", "/portal/hop-dong", async ({ actor }) => {
    const leases = await getMyLease(serverContext().db, actor);
    if (leases.length === 0) return <EmptyState title="Bạn chưa có hợp đồng nào" />;
    return (
      <ul className="card-list">
        {leases.map((l) => (
          <li key={l.id} className="card" data-testid="lease">
            <p className="card__title">
              Hợp đồng {l.number} — Phòng {l.unitCode}
            </p>
            <dl className="facts">
              <dt>Trạng thái</dt>
              <dd>{LEASE_STATUS[l.status] ?? l.status}</dd>
              {l.currentVersion ? (
                <>
                  <dt>Điều khoản</dt>
                  <dd data-testid="lease-version">
                    v{l.currentVersion.versionNo} — hiệu lực từ {day(l.currentVersion.effectiveFrom)}
                  </dd>
                  <dt>Giá thuê</dt>
                  <dd>
                    <Money value={l.currentVersion.rentAmount} />
                  </dd>
                </>
              ) : null}
              <dt>{l.deposit.label}</dt>
              <dd>
                <Money value={l.deposit.amount} testId="deposit-amount" /> (đã nhận{" "}
                <Money value={l.deposit.balance} />)
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  });
}
