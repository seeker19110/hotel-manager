import { listReservations, listRooms, opsProperties, RESERVATION_LIST_LIMIT, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { TruncatedNotice } from "../../components/ui/truncated-notice.tsx";
import { addDays, BOOKING_STATUS, day, vnd } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("booking.list.metadata.title") };

const MANAGE = ["owner", "manager", "front_desk"];

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string }>;
}) {
  const q = await searchParams;
  return withActor(t("booking.list.page.title"), "/dat-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("booking.list.error.load")} text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    const property = hotels.find((p) => p.id === q.property_id) ?? hotels[0];
    if (!property) return <EmptyState title={t("calendar.empty.no_hotel.title")} />;
    const from = addDays(property.businessDate, -7);
    const [rooms, list] = await Promise.all([
      listRooms(db, actor),
      safe(
        listReservations(db, actor, {
          propertyId: property.id,
          from,
          to: addDays(property.businessDate, 90),
        }),
      ),
    ]);
    if (!list.ok)
      return (
        <ErrorState
          title={t("booking.list.error.load")}
          text={list.status === 403 || list.status === 404 ? t("booking.list.error.forbidden") : list.message}
        />
      );
    const code = new Map(
      (rooms.find((r) => r.propertyId === property.id)?.rooms ?? []).map((u) => [u.unitId, u.code]),
    );
    return (
      <>
        {hotels.length > 1 ? (
          <nav aria-label={t("calendar.nav.property")} className="pager">
            {hotels.map((p) => (
              <a
                key={p.id}
                className="btn btn--secondary"
                href={`/dat-phong?property_id=${p.id}`}
                aria-current={p.id === property.id ? "page" : undefined}
              >
                {p.name}
              </a>
            ))}
          </nav>
        ) : null}
        {MANAGE.includes(actor.role) ? (
          <p className="pager">
            <a className="btn" href={`/dat-phong/moi?property_id=${property.id}`}>
              {t("home.action.new_booking")}
            </a>
            <a className="btn btn--secondary" href={`/luu-tru/moi?property_id=${property.id}`}>
              {t("home.action.walk_in")}
            </a>
          </p>
        ) : null}
        <TruncatedNotice shown={list.data.length} limit={RESERVATION_LIST_LIMIT} />
        {list.data.length === 0 ? (
          <EmptyState title={t("booking.list.empty.title")} text={t("booking.list.empty.text")} />
        ) : (
          <ul className="card-list">
            {list.data.map((b) => (
              <li key={b.id} className="card" data-testid="booking">
                <a href={`/dat-phong/${b.id}`} className="card__link">
                  <span className="card__title">
                    {t("booking.list.title", {
                      number: b.number,
                      room: code.get(b.unitId) ?? "—",
                      booker: b.bookerName,
                    })}
                  </span>
                  <span className="card__meta">
                    {t("booking.list.meta", {
                      arrival: day(b.arrivalDate),
                      departure: day(b.departureDate),
                      nights: b.nights,
                      total: vnd(b.roomTotal),
                    })}
                  </span>
                  <StatusBadge status={b.status} label={BOOKING_STATUS[b.status] ?? b.status} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  });
}
