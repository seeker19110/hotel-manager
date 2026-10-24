import {
  isoDateOr,
  listReservations,
  listRooms,
  opsProperties,
  RESERVATION_LIST_LIMIT,
  type ReservationView,
  serverContext,
} from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { TruncatedNotice } from "../../components/ui/truncated-notice.tsx";
import { addDays, bookingStatusLabel, day, weekdayDay } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.booking_status.", "label.weekday.");

export const metadata: Metadata = { title: t("calendar.metadata.title") };

const DAYS = 7;
const SHOWN = new Set(["held", "confirmed", "in_house", "checked_out"]);

// SPEC-inventory-allocation §5: trên điện thoại là danh sách theo ngày (không timeline, không kéo thả); trạng thái có chữ + biểu tượng.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string; from?: string }>;
}) {
  const q = await searchParams;
  return withActor(t("calendar.page.title"), "/lich-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("calendar.error.load")} text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    const property = hotels.find((p) => p.id === q.property_id) ?? (q.property_id ? undefined : hotels[0]);
    if (q.property_id && !property) notFound();
    if (!property)
      return (
        <EmptyState title={t("calendar.empty.no_hotel.title")} text={t("calendar.empty.no_hotel.text")} />
      );
    const from = isoDateOr(q.from, property.businessDate);
    const to = addDays(from, DAYS);
    const [rooms, list] = await Promise.all([
      listRooms(db, actor),
      safe(listReservations(db, actor, { propertyId: property.id, from, to })),
    ]);
    if (!list.ok)
      return (
        <ErrorState
          title={t("calendar.error.reservations")}
          text={list.status === 403 || list.status === 404 ? t("calendar.error.forbidden") : list.message}
        />
      );
    const units = rooms.find((r) => r.propertyId === property.id)?.rooms ?? [];
    const bookings = list.data.filter((b) => SHOWN.has(b.status));
    const at = (unitId: string, d: string): ReservationView | undefined =>
      bookings.find((b) => b.unitId === unitId && b.arrivalDate <= d && d < b.departureDate);
    const link = (f: string) => `/lich-phong?property_id=${property.id}&from=${f}`;
    return (
      <>
        <TruncatedNotice shown={list.data.length} limit={RESERVATION_LIST_LIMIT} />
        {hotels.length > 1 ? (
          <nav aria-label={t("calendar.nav.property")} className="pager">
            {hotels.map((p) => (
              <a
                key={p.id}
                className="btn btn--secondary"
                href={`/lich-phong?property_id=${p.id}`}
                aria-current={p.id === property.id ? "page" : undefined}
              >
                {p.name}
              </a>
            ))}
          </nav>
        ) : null}
        <p className="card__meta">
          {t("calendar.range", { property: property.name, from: day(from), to: day(addDays(to, -1)) })}
        </p>
        <nav aria-label={t("calendar.nav.week")} className="pager">
          <a className="btn btn--secondary" href={link(addDays(from, -DAYS))}>
            {t("calendar.nav.prev")}
          </a>
          <a className="btn btn--secondary" href={link(property.businessDate)}>
            {t("calendar.nav.today")}
          </a>
          <a className="btn btn--secondary" href={link(to)}>
            {t("calendar.nav.next")}
          </a>
        </nav>
        {units.length === 0 ? (
          <EmptyState title={t("calendar.empty.units")} />
        ) : (
          Array.from({ length: DAYS }, (_, i) => addDays(from, i)).map((d) => (
            <section key={d} aria-labelledby={`d-${d}`} className="day-block" data-testid="calendar-day">
              <h2 id={`d-${d}`}>{weekdayDay(LABELS, d)}</h2>
              <ul className="day-rooms">
                {units.map((u) => {
                  const b = at(u.unitId, d);
                  return (
                    <li key={u.unitId} className="day-rooms__item" data-testid="calendar-room">
                      <span className="day-rooms__code">{u.code}</span>
                      {u.availability === "out_of_service" ? (
                        <span>
                          <Icon name="blocked" /> {t("calendar.room.out_of_service")}
                        </span>
                      ) : b ? (
                        <a href={`/dat-phong/${b.id}`} className="card__link">
                          <StatusBadge status={b.status} label={bookingStatusLabel(LABELS, b.status)} />
                          <span>
                            {b.number} · {b.bookerName}
                          </span>
                        </a>
                      ) : (
                        <span className="card__actions">
                          <span>
                            <span aria-hidden="true">○ </span>
                            {t("calendar.room.free")}
                          </span>
                          <a
                            className="btn btn--secondary"
                            href={`/dat-phong/moi?property_id=${property.id}&unit=${u.unitId}&arrival=${d}`}
                            aria-label={t("calendar.room.book_aria", { unit: u.code, date: day(d) })}
                          >
                            {t("calendar.room.book")}
                          </a>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </>
    );
  });
}
