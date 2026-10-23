import { getTodaySummary, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState, ErrorState } from "../components/ui/state.tsx";
import { CARD_LABEL, commonTimeZone, dateTime, day, vnd } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";
import { withActor } from "../lib/page.tsx";
import { safe } from "../lib/safe.ts";
import { currentSession } from "../lib/session.ts";

export const metadata: Metadata = { title: t("home.metadata.title") };

const FRONT_ROLES = ["owner", "manager", "front_desk"];

// SPEC-audit-reporting S-006…S-008: thẻ theo vai trò, số thẻ = số dòng danh sách (bấm ra đúng số dòng), ngày kinh doanh từng cơ sở.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string }>;
}) {
  const { property_id: propertyId } = await searchParams;
  if (!(await currentSession())) {
    return (
      <main id="main" className="page">
        <h1>{t("home.page.title")}</h1>
        <EmptyState
          title={t("home.anonymous.title")}
          text={t("home.anonymous.text")}
          action={
            <a className="btn" href="/dang-nhap">
              {t("home.anonymous.login")}
            </a>
          }
        />
      </main>
    );
  }
  return withActor(t("home.page.title"), "/", async (actor) => {
    const r = await safe(getTodaySummary(serverContext().db, actor, propertyId ? { propertyId } : {}));
    if (!r.ok)
      return (
        <ErrorState
          title={t("home.error.load")}
          text={r.status === 403 ? t("home.error.forbidden") : r.message}
          action={
            <a className="btn" href="/">
              {t("common.retry")}
            </a>
          }
        />
      );
    const s = r.data;
    const q = propertyId ? `?property_id=${encodeURIComponent(propertyId)}` : "";
    return (
      <>
        {s.properties.length > 1 ? (
          <nav aria-label={t("home.filter.aria")} className="pager">
            <a className="btn btn--secondary" href="/" aria-current={propertyId ? undefined : "page"}>
              {t("home.filter.all")}
            </a>
            {s.properties.map((p) => (
              <a
                key={p.id}
                className="btn btn--secondary"
                href={`/?property_id=${p.id}`}
                aria-current={propertyId === p.id ? "page" : undefined}
              >
                {p.name}
              </a>
            ))}
          </nav>
        ) : null}
        <ul className="card-list" aria-label={t("home.business_dates.aria")}>
          {s.properties.map((p) => (
            <li key={p.id} className="card__meta" data-testid="business-date">
              {t("home.business_date", { property: p.name, date: day(p.businessDate) })}
            </li>
          ))}
        </ul>
        {s.cards.length === 0 ? (
          <EmptyState title={t("home.empty.title")} />
        ) : (
          <ul className="today-cards">
            {s.cards.map((c) => {
              const label = CARD_LABEL[c.key] ?? c.label;
              return (
                <li key={c.key}>
                  <a
                    className="today-card"
                    href={`/hom-nay/${c.key}${q}`}
                    aria-label={`${label}: ${c.count}`}
                    data-testid={`card-${c.key}`}
                  >
                    <span className="today-card__label">{label}</span>
                    <span className="today-card__count">{c.count}</span>
                    {c.amount !== undefined ? (
                      <span className="today-card__hint">{vnd(c.amount)}</span>
                    ) : null}
                    {c.count === 0 ? <span className="today-card__hint">{t("home.card.none")}</span> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <p className="card__meta">
          {t("home.as_of", { time: dateTime(s.asOf, commonTimeZone(s.properties)) })}
        </p>
        {FRONT_ROLES.includes(actor.role) ? (
          <p className="pager">
            <a className="btn" href="/dat-phong/moi">
              {t("home.action.new_booking")}
            </a>
            <a className="btn btn--secondary" href="/luu-tru/moi">
              {t("home.action.walk_in")}
            </a>
          </p>
        ) : null}
      </>
    );
  });
}
