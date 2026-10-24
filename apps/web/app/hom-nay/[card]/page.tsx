import { listTodayItems, serverContext, TODAY_CARDS, type TodayCard } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Icon } from "../../../components/ui/icon.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { vnd } from "../../../lib/format.ts";
import { t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: t("today_list.metadata.title") };

const TITLE: Record<TodayCard, string> = {
  arrivals: t("today_list.title.arrivals"),
  departures: t("today_list.title.departures"),
  receivables: t("today_list.title.receivables"),
  periodsReviewing: t("today_list.title.periods_reviewing"),
  dirtyUnits: t("today_list.title.dirty_units"),
  workOrders: t("today_list.title.work_orders"),
  residenceNotices: t("today_list.title.residence_notices"),
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
  return withActor(TITLE[key], "/", async (actor) => {
    const r = await safe(
      listTodayItems(serverContext().db, actor, { card: key, ...(propertyId ? { propertyId } : {}) }),
    );
    if (!r.ok) {
      if (r.status === 404) notFound();
      return (
        <ErrorState
          title={t("today_list.error.load")}
          text={r.status === 403 ? t("today_list.error.forbidden") : r.message}
          action={
            <a className="btn" href="/">
              {t("today_list.back")}
            </a>
          }
        />
      );
    }
    return (
      <>
        <p>
          <a className="btn btn--secondary" href={propertyId ? `/?property_id=${propertyId}` : "/"}>
            {t("today_list.back")}
          </a>
        </p>
        {r.data.length === 0 ? (
          <EmptyState title={t("today_list.empty.title")} text={t("today_list.empty.text")} />
        ) : (
          <ul className="card-list">
            {r.data.map((i) => (
              <li key={i.id} className="card" data-testid="today-item">
                <a href={hrefOf(key, i.id)} className="card__link">
                  <span className="card__title">{i.title}</span>
                  {i.subtitle ? <span className="card__meta">{i.subtitle}</span> : null}
                  {i.amount !== undefined ? (
                    <span className="card__meta">
                      {t("today_list.item.remaining", { amount: vnd(i.amount) })}
                    </span>
                  ) : null}
                  {i.overdue ? (
                    <span className="badge" data-status="overdue">
                      <Icon name="warning" /> {t("today_list.item.overdue")}
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
