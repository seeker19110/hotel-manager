import { listReservations, listRooms, opsProperties, type ReservationView, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { addDays, BOOKING_STATUS, day, weekdayDay } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Lịch phòng — Hotel Manager" };

const DAYS = 7;
const SHOWN = new Set(["held", "confirmed", "in_house", "checked_out"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// SPEC-inventory-allocation §5: trên điện thoại là danh sách theo ngày (không timeline, không kéo thả); trạng thái có chữ + biểu tượng.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string; from?: string }>;
}) {
  const q = await searchParams;
  return withActor("Lịch phòng", "/lich-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không xem được lịch" text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    const property = hotels.find((p) => p.id === q.property_id) ?? (q.property_id ? undefined : hotels[0]);
    if (q.property_id && !property) notFound();
    if (!property)
      return <EmptyState title="Chưa có cơ sở khách sạn" text="Cơ sở nhà trọ dùng màn Hợp đồng và Phòng." />;
    const from = q.from && ISO.test(q.from) ? q.from : property.businessDate;
    const to = addDays(from, DAYS);
    const [rooms, list] = await Promise.all([
      listRooms(db, actor),
      safe(listReservations(db, actor, { propertyId: property.id, from, to })),
    ]);
    if (!list.ok)
      return (
        <ErrorState
          title="Không xem được đặt phòng"
          text={
            list.status === 403 || list.status === 404
              ? "Vai trò của bạn không xem được lịch đặt phòng."
              : list.message
          }
        />
      );
    const units = rooms.find((r) => r.propertyId === property.id)?.rooms ?? [];
    const bookings = list.data.filter((b) => SHOWN.has(b.status));
    const at = (unitId: string, d: string): ReservationView | undefined =>
      bookings.find((b) => b.unitId === unitId && b.arrivalDate <= d && d < b.departureDate);
    const link = (f: string) => `/lich-phong?property_id=${property.id}&from=${f}`;
    return (
      <>
        {hotels.length > 1 ? (
          <nav aria-label="Chọn cơ sở" className="pager">
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
          {property.name} · từ {day(from)} đến {day(addDays(to, -1))}
        </p>
        <nav aria-label="Chuyển tuần" className="pager">
          <a className="btn btn--secondary" href={link(addDays(from, -DAYS))}>
            Tuần trước
          </a>
          <a className="btn btn--secondary" href={link(property.businessDate)}>
            Hôm nay
          </a>
          <a className="btn btn--secondary" href={link(to)}>
            Tuần sau
          </a>
        </nav>
        {units.length === 0 ? (
          <EmptyState title="Cơ sở chưa có phòng" />
        ) : (
          Array.from({ length: DAYS }, (_, i) => addDays(from, i)).map((d) => (
            <section key={d} aria-labelledby={`d-${d}`} className="day-block" data-testid="calendar-day">
              <h2 id={`d-${d}`}>{weekdayDay(d)}</h2>
              <ul className="day-rooms">
                {units.map((u) => {
                  const b = at(u.unitId, d);
                  return (
                    <li key={u.unitId} className="day-rooms__item" data-testid="calendar-room">
                      <span className="day-rooms__code">{u.code}</span>
                      {u.availability === "out_of_service" ? (
                        <span>
                          <Icon name="blocked" /> Ngừng sử dụng
                        </span>
                      ) : b ? (
                        <a href={`/dat-phong/${b.id}`} className="card__link">
                          <StatusBadge status={b.status} label={BOOKING_STATUS[b.status] ?? b.status} />
                          <span>
                            {b.number} · {b.bookerName}
                          </span>
                        </a>
                      ) : (
                        <span className="card__actions">
                          <span>
                            <span aria-hidden="true">○ </span>Trống
                          </span>
                          <a
                            className="btn btn--secondary"
                            href={`/dat-phong/moi?property_id=${property.id}&unit=${u.unitId}&arrival=${d}`}
                            aria-label={`Đặt phòng ${u.code} từ ${day(d)}`}
                          >
                            Đặt phòng
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
