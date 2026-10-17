import { listTodayItems, serverContext, TODAY_CARDS, type TodayCard } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { CARD_LABEL, vnd } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Danh sách trong ngày — Hotel Manager" };

const TITLE: Record<TodayCard, string> = {
  arrivals: "Khách đến hôm nay",
  departures: "Khách đi hôm nay",
  receivables: "Nợ đến hạn/quá hạn",
  periodsReviewing: "Kỳ thu cần duyệt",
  dirtyUnits: "Phòng cần dọn",
  workOrders: "Sự cố",
  residenceNotices: "Thông báo lưu trú sắp/quá hạn",
};

/** Dòng của thẻ dẫn tới màn xử lý tương ứng. */
function hrefOf(card: TodayCard, id: string): string {
  switch (card) {
    case "arrivals":
      return `/dat-phong/${id}`;
    case "departures":
      return `/luu-tru/${id}`;
    case "receivables":
      return "/thu-tien";
    case "periodsReviewing":
      return `/ky-thu/${id}`;
    case "dirtyUnits":
      return "/buong-phong";
    case "workOrders":
      return "/su-co";
    case "residenceNotices":
      return "/thong-bao-luu-tru";
  }
}

export default async function TodayListPage({
  params,
  searchParams,
}: {
  params: Promise<{ card: string }>;
  searchParams: Promise<{ property_id?: string }>;
}) {
  const { card } = await params;
  const { property_id: propertyId } = await searchParams;
  if (!(TODAY_CARDS as readonly string[]).includes(card)) notFound();
  const key = card as TodayCard;
  return withActor(CARD_LABEL[key] ?? TITLE[key], "/", async (actor) => {
    const r = await safe(
      listTodayItems(serverContext().db, actor, { card: key, ...(propertyId ? { propertyId } : {}) }),
    );
    if (!r.ok) {
      if (r.status === 404) notFound();
      return (
        <ErrorState
          title="Không xem được danh sách"
          text={r.status === 403 ? "Vai trò của bạn không có thẻ này." : r.message}
          action={
            <a className="btn" href="/">
              Về Hôm nay
            </a>
          }
        />
      );
    }
    return (
      <>
        <p>
          <a className="btn btn--secondary" href={propertyId ? `/?property_id=${propertyId}` : "/"}>
            Về Hôm nay
          </a>
        </p>
        {r.data.length === 0 ? (
          <EmptyState title="Không có việc" text="Không có dòng nào trong mục này hôm nay." />
        ) : (
          <ul className="card-list">
            {r.data.map((i) => (
              <li key={i.id} className="card" data-testid="today-item">
                <a href={hrefOf(key, i.id)} className="card__link">
                  <span className="card__title">{i.title}</span>
                  {i.subtitle ? <span className="card__meta">{i.subtitle}</span> : null}
                  {i.amount !== undefined ? <span className="card__meta">Còn {vnd(i.amount)}</span> : null}
                  {i.overdue ? (
                    <span className="badge" data-status="overdue">
                      <span aria-hidden="true">⚠ </span>Quá hạn
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  });
}
