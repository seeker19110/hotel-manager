// Biểu ngữ truy cập hỗ trợ (T-2313, D-128) trên MỌI trang của tổ chức khi đang có tài khoản hỗ trợ còn hiệu lực: ai, đến khi nào.
// Server component THUẦN, không JS client (D-133): biểu ngữ nằm trong khung trang chung (`withActor`), nhập form lệnh ở đây chép
// form + `useCommand` vào chunk client của mọi trang (ngân sách bundle FE-PERF-004). Owner có liên kết tới khối quản lý truy cập
// hỗ trợ ở /nhat-ky (thu hồi một bước ở đó); manager có liên kết xem thao tác của hỗ trợ trong nhật ký. Liên kết là `<a>` thường,
// không `next/link` (client component — kéo runtime liên kết vào chunk mọi trang). Quyền thật kiểm ở server.
import type { SupportAccessRow } from "@hm/app";
import { DEFAULT_TIME_ZONE, dateTime } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";

export function SupportBanner({
  rows,
  viewerRole,
}: {
  rows: readonly SupportAccessRow[];
  viewerRole: string;
}) {
  return (
    <div className="banner banner--warn" role="status" data-testid="support-banner">
      <h2>{t("support_banner.title")}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.invitationId}>
            <p>
              {t("support_banner.item", {
                who: r.name ?? r.email ?? t("support_banner.unnamed"),
                until: dateTime(r.until, DEFAULT_TIME_ZONE),
              })}
            </p>
            {r.reason ? <p>{t("support_banner.reason", { reason: r.reason })}</p> : null}
          </li>
        ))}
      </ul>
      <p>{t("support_banner.note")}</p>
      {viewerRole === "owner" ? (
        <p>
          <a className="btn btn--secondary" href="/nhat-ky#truy-cap-ho-tro" data-testid="support-manage">
            {t("support_banner.manage")}
          </a>
        </p>
      ) : viewerRole === "manager" ? (
        <p>
          <a
            className="btn btn--secondary"
            href="/nhat-ky?actor=platform_support"
            data-testid="support-view-log"
          >
            {t("support_banner.view_log")}
          </a>
        </p>
      ) : null}
    </div>
  );
}
