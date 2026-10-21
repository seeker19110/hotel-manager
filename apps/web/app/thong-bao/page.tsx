import { listMyNotifications, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { commonTimeZone, dateTime } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Thông báo — Hotel Manager" };

const SEVERITY_LABEL: Record<string, string> = {
  info: "Thông tin",
  warning: "Cần chú ý",
  critical: "Quá hạn / khẩn",
};

const SEVERITY_ICON: Record<string, "info" | "warning" | "blocked"> = {
  normal: "info",
  urgent: "warning",
  overdue: "blocked",
};

/** Màn đích có thật của từng loại thông báo; liên kết mẫu cũ tới màn chưa có (vd. /xuất-dữ-liệu) thì không hiện. */
const KNOWN = [
  "/hop-dong",
  "/ky-thu",
  "/thu-tien",
  "/doi-soat",
  "/dat-phong",
  "/buong-phong",
  "/su-co",
  "/phong",
];
function linkOf(type: string, link: string | null): string | null {
  if (type === "stay_notice_due") return "/thong-bao-luu-tru";
  if (type === "maintenance_status") return "/su-co";
  if (!link || !/^\/(?!\/)/.test(link)) return null;
  return KNOWN.some((k) => link === k || link.startsWith(`${k}/`)) ? link : null;
}

// SPEC-notifications S-017: hộp thông báo trong app, số chưa đọc ở chuông, thông báo mới đọc qua aria-live="polite".
export default async function InboxPage() {
  return withActor("Thông báo", "/thong-bao", async (actor) => {
    const [r, props] = await Promise.all([
      safe(listMyNotifications(serverContext().db, actor, { limit: 50 })),
      safe(opsProperties(serverContext().db, actor)),
    ]);
    // Thông báo cấp tổ chức: giờ theo múi giờ chung của các cơ sở trong phạm vi (khác nhau ⇒ mặc định).
    const timeZone = commonTimeZone(props.ok ? props.data : []);
    if (!r.ok)
      return (
        <ErrorState
          title="Không tải được thông báo"
          text={r.message}
          action={
            <a className="btn" href="/thong-bao">
              Thử lại
            </a>
          }
        />
      );
    const { items, unreadCount } = r.data;
    return (
      <div aria-live="polite">
        <p className="card__meta" data-testid="unread-count">
          {unreadCount > 0 ? `${unreadCount} thông báo chưa đọc` : "Không có thông báo chưa đọc"}
        </p>
        {unreadCount > 0 ? (
          <CommandForm
            path="notifications/markAllRead"
            submitLabel="Đánh dấu tất cả đã đọc"
            successText="Đã đánh dấu tất cả đã đọc."
            variant="secondary"
          />
        ) : null}
        {items.length === 0 ? (
          <EmptyState title="Chưa có thông báo" />
        ) : (
          <ul className="card-list">
            {items.map((n) => {
              const link = linkOf(n.type, n.link);
              return (
                <li
                  key={n.id}
                  className={`card${n.readAt ? "" : " notif--unread"}`}
                  data-testid="notification"
                >
                  <p className="card__title">{n.title}</p>
                  <p className="card__meta">
                    <Icon name={SEVERITY_ICON[n.severity] ?? "info"} />{" "}
                    {SEVERITY_LABEL[n.severity] ?? n.severity} · {dateTime(n.createdAt, timeZone)}
                    {n.readAt ? " · đã đọc" : " · chưa đọc"}
                  </p>
                  <p>{n.body}</p>
                  <div className="card__actions">
                    {link ? (
                      <a className="btn btn--secondary" href={link}>
                        Mở nội dung
                      </a>
                    ) : null}
                    {n.readAt ? null : (
                      <CommandForm
                        path="notifications/markRead"
                        fixed={{ notification_id: n.id }}
                        submitLabel="Đánh dấu đã đọc"
                        successText="Đã đánh dấu đã đọc."
                        variant="secondary"
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  });
}
