import { listNotices, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { NoticeActions } from "../../components/hotel/notice-actions.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, NOTICE_STATUS } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Thông báo lưu trú — Hotel Manager" };

// Thông báo lưu trú là nghĩa vụ của cơ sở: màn này chỉ xuất file theo mẫu và ghi dấu vết; quá hạn chưa nộp nổi lên đầu.
export default async function NoticesPage() {
  return withActor("Thông báo lưu trú", "/thong-bao-luu-tru", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không xem được thông báo lưu trú" text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    if (hotels.length === 0) return <EmptyState title="Chưa có cơ sở khách sạn" />;
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
                title="Không tải được danh sách"
                text={notices.status === 404 ? "Vai trò của bạn không xem được mục này." : notices.message}
              />
            ) : notices.data.length === 0 ? (
              <EmptyState
                title="Chưa có thông báo lưu trú"
                text="Mỗi lượt ở đã nhận phòng có một thông báo cần nộp."
              />
            ) : (
              <ul className="card-list">
                {notices.data.map((n) => (
                  <li key={n.id} className="card" data-testid="notice">
                    <p className="card__title">
                      Phòng {n.unitCode}
                      {n.isForeign ? " · khách nước ngoài" : ""}
                    </p>
                    <p className="card__meta">
                      {n.dueAt ? `Hạn nộp ${dateTime(n.dueAt)}` : "Chưa cấu hình hạn nộp"}
                      {n.submittedAt ? ` · đã nộp ${dateTime(n.submittedAt)}` : ""}
                    </p>
                    <StatusBadge status={n.status} label={NOTICE_STATUS[n.status] ?? n.status} />
                    {n.overdue ? (
                      <span className="badge" data-status="overdue">
                        <span aria-hidden="true">⚠ </span>Quá hạn
                      </span>
                    ) : null}
                    {["owner", "manager", "front_desk"].includes(actor.role) ? (
                      <NoticeActions
                        noticeId={n.id}
                        stayId={n.stayId}
                        unitCode={n.unitCode}
                        submitted={n.status === "submitted"}
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
