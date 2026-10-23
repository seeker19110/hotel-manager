import { listNotices, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { NoticeActions } from "../../components/hotel/notice-actions.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, NOTICE_STATUS } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("notice.metadata.title") };

// Thông báo lưu trú là nghĩa vụ của cơ sở: màn này chỉ xuất file theo mẫu và ghi dấu vết; quá hạn chưa nộp nổi lên đầu.
export default async function NoticesPage() {
  return withActor(t("notice.page.title"), "/thong-bao-luu-tru", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("notice.error.load")} text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    if (hotels.length === 0) return <EmptyState title={t("calendar.empty.no_hotel.title")} />;
    const lists = await Promise.all(
      hotels.map(async (p) => ({ p, notices: await safe(listNotices(db, actor, { propertyId: p.id })) })),
    );
    return (
      <>
        {lists.map(({ p, notices }) => (
          <section key={p.id} aria-labelledby={`n-${p.id}`} className="panel">
            <h2 id={`n-${p.id}`}>{p.name}</h2>
            {!notices.ok ? (
              <ErrorState
                title={t("notice.error.list")}
                text={notices.status === 404 ? t("notice.error.forbidden") : notices.message}
              />
            ) : notices.data.length === 0 ? (
              <EmptyState title={t("notice.empty.title")} text={t("notice.empty.text")} />
            ) : (
              <ul className="card-list">
                {notices.data.map((n) => (
                  <li key={n.id} className="card" data-testid="notice">
                    <p className="card__title">
                      {t("notice.card.title", { unit: n.unitCode })}
                      {n.isForeign ? t("notice.card.foreign") : ""}
                    </p>
                    <p className="card__meta">
                      {n.dueAt
                        ? t("notice.card.due", { due: dateTime(n.dueAt, p.timezone) })
                        : t("notice.card.no_due")}
                      {n.submittedAt
                        ? t("notice.card.submitted", { at: dateTime(n.submittedAt, p.timezone) })
                        : ""}
                    </p>
                    <StatusBadge status={n.status} label={NOTICE_STATUS[n.status] ?? n.status} />
                    {n.overdue ? (
                      <span className="badge" data-status="overdue">
                        <Icon name="warning" /> {t("today_list.item.overdue")}
                      </span>
                    ) : null}
                    {["owner", "manager", "front_desk"].includes(actor.role) ? (
                      <NoticeActions
                        noticeId={n.id}
                        stayId={n.stayId}
                        unitCode={n.unitCode}
                        submitted={n.status === "submitted"}
                        m={messagesFor("notice_actions.")}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </>
    );
  });
}
