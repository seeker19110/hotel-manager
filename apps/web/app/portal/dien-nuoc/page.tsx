import { listMyMeterReadings, serverContext } from "@hm/app";
import { safeUrl } from "@hm/app/http";
import type { Metadata } from "next";
import { EmptyState } from "../../../components/ui/state.tsx";
import { day, METER_LABEL } from "../../../lib/format.ts";
import { withPortal } from "../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: "Điện nước — Hotel Manager" };

// SPEC-portal S-007: chỉ chỉ số đã duyệt; ảnh qua URL ký ngắn hạn (mở bằng liên kết — CSP không cho ảnh ngoài origin).
export default async function PortalMetersPage() {
  return withPortal("Điện nước", "/portal/dien-nuoc", async ({ actor }) => {
    const rows = await listMyMeterReadings(serverContext().db, actor, serverContext().services);
    if (rows.length === 0)
      return (
        <EmptyState title="Chưa có chỉ số nào được duyệt" text="Chỉ số hiện ở đây sau khi chủ trọ chốt." />
      );
    return (
      <ul className="card-list">
        {rows.map((r) => (
          <li key={r.id} className="card" data-testid="reading">
            <p className="card__title">
              {METER_LABEL[r.kind] ?? r.kind}: {new Intl.NumberFormat("vi-VN").format(r.value)}
            </p>
            <p className="card__meta">Ngày {day(r.readOn)}</p>
            {safeUrl(r.photoUrl) ? (
              <a
                className="btn btn--secondary"
                href={safeUrl(r.photoUrl) as string}
                target="_blank"
                rel="noopener noreferrer"
              >
                Xem ảnh công tơ ngày {day(r.readOn)}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    );
  });
}
