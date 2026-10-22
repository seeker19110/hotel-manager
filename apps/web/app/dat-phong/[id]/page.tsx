import { getReservation, listRooms, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { GuestsForm } from "../../../components/hotel/guests-form.tsx";
import { HoldCountdown } from "../../../components/hotel/hold-countdown.tsx";
import { ShiftPanel } from "../../../components/hotel/shift-panel.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import { BOOKING_STATUS, DEFAULT_TIME_ZONE, dateTime, day, vnd } from "../../../lib/format.ts";
import { t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: t("reservation.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = ["owner", "manager", "front_desk"];

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("reservation.page.title"), "/dat-phong", async (actor) => {
    const db = serverContext().db;
    const r = await safe(getReservation(db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title={t("reservation.error.load")} text={r.message} />;
    }
    const b = r.data;
    const rooms = (await listRooms(db, actor)).find((p) => p.propertyId === b.propertyId)?.rooms ?? [];
    const room = rooms.find((u) => u.unitId === b.unitId);
    const canManage = MANAGE.includes(actor.role);
    const props = await safe(opsProperties(db, actor));
    const property = props.ok ? props.data.find((p) => p.id === b.propertyId) : undefined;
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">{t("booking.detail.title", { number: b.number, room: room?.code ?? "—" })}</h2>
          <dl className="facts">
            <dt>{t("reservation.facts.status")}</dt>
            <dd>
              <StatusBadge
                status={b.status}
                label={BOOKING_STATUS[b.status] ?? b.status}
                testId="booking-status"
              />
            </dd>
            <dt>{t("reservation.facts.booker")}</dt>
            <dd>{b.bookerName}</dd>
            <dt>{t("reservation.facts.stay")}</dt>
            <dd>
              {t("booking.detail.stay", {
                arrival: day(b.arrivalDate),
                departure: day(b.departureDate),
                nights: b.nights,
                guests: b.guests,
              })}
            </dd>
            <dt>{t("reservation.facts.room_total")}</dt>
            <dd data-testid="room-total">{vnd(b.roomTotal)}</dd>
            {b.status === "held" && b.heldUntil ? (
              <>
                <dt>{t("reservation.facts.held_until")}</dt>
                <dd>
                  <HoldCountdown
                    until={b.heldUntil.toISOString()}
                    untilText={dateTime(b.heldUntil, property?.timezone ?? DEFAULT_TIME_ZONE)}
                  />
                </dd>
              </>
            ) : null}
          </dl>
          <table className="lines">
            <caption>{t("reservation.nightly.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("reservation.nightly.col_night")}</th>
                <th scope="col">{t("reservation.nightly.col_price")}</th>
              </tr>
            </thead>
            <tbody>
              {b.nightlyPrices.map((n) => (
                <tr key={n.businessDate}>
                  <th scope="row">{day(n.businessDate)}</th>
                  <td>{vnd(n.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {b.stayId && ["in_house", "checked_out"].includes(b.status) ? (
          <p>
            <a className="btn" href={`/luu-tru/${b.stayId}`}>
              {t("reservation.link.stay")}
            </a>
          </p>
        ) : null}

        {canManage && b.status === "draft" ? (
          <section aria-labelledby="a-hold" className="panel">
            <h2 id="a-hold">{t("reservation.hold.heading")}</h2>
            <CommandForm
              path="reservation/hold"
              fixed={{ reservation_id: id }}
              submitLabel={t("reservation.hold.heading")}
              successText={t("reservation.hold.success")}
            />
          </section>
        ) : null}

        {canManage && b.status === "held" ? (
          <section aria-labelledby="a-confirm" className="panel">
            <h2 id="a-confirm">{t("reservation.confirm.heading")}</h2>
            <CommandForm
              path="reservation/confirm"
              confirm={t("reservation.confirm.plain_confirm")}
              confirmLabel={t("reservation.confirm.plain_label", {
                number: b.number,
                room: room?.code ?? "—",
              })}
              fixed={{ reservation_id: id }}
              submitLabel={t("reservation.confirm.plain_submit")}
              successText={t("reservation.confirm.plain_success")}
              testId="confirm-plain"
            />
            <h3>{t("reservation.confirm.advance_heading")}</h3>
            {property ? <ShiftPanel property={property} /> : null}
            <CommandForm
              path="reservation/confirm"
              confirm={t("reservation.confirm.advance_confirm")}
              confirmLabel={t("reservation.confirm.advance_label", {
                number: b.number,
                advance: "{advance}",
              })}
              fixed={{ reservation_id: id, payment: { method: "cash", kind: "advance" } }}
              fields={[
                {
                  name: "advance",
                  path: "payment.amount",
                  label: t("reservation.confirm.advance_field"),
                  type: "money",
                  required: true,
                },
              ]}
              submitLabel={t("reservation.confirm.advance_submit")}
              successText={t("reservation.confirm.advance_success")}
              variant="secondary"
            />
          </section>
        ) : null}

        {canManage && b.status === "confirmed" && b.stayId && b.stayStatus === "expected" ? (
          <section aria-labelledby="a-in" className="panel">
            <h2 id="a-in">{t("reservation.checkin.heading")}</h2>
            <p className="card__meta">{t("reservation.checkin.note")}</p>
            <GuestsForm
              path="stay/checkIn"
              fixed={{ reservation_id: id }}
              submitLabel={t("reservation.checkin.submit")}
              successText={t("reservation.checkin.success")}
            />
          </section>
        ) : null}

        {canManage && ["draft", "held", "confirmed"].includes(b.status) ? (
          <section aria-labelledby="a-cancel" className="panel">
            <h2 id="a-cancel">{t("reservation.cancel.heading")}</h2>
            <CommandForm
              path="reservation/cancel"
              confirm={t("reservation.cancel.confirm")}
              confirmLabel={t("reservation.cancel.label", { number: b.number, room: room?.code ?? "—" })}
              fixed={{ reservation_id: id }}
              fields={[
                { name: "reason", label: t("reservation.cancel.reason"), required: true, maxLength: 1000 },
                { name: "cancellation_fee", label: t("reservation.cancel.fee"), type: "money" },
              ]}
              submitLabel={t("reservation.cancel.heading")}
              successText={t("reservation.cancel.success")}
              variant="secondary"
            />
          </section>
        ) : null}

        {canManage && b.status === "confirmed" ? (
          <section aria-labelledby="a-noshow" className="panel">
            <h2 id="a-noshow">{t("reservation.noshow.heading")}</h2>
            <CommandForm
              path="reservation/markNoShow"
              confirm={t("reservation.noshow.confirm")}
              confirmLabel={t("reservation.noshow.label", { number: b.number, room: room?.code ?? "—" })}
              fixed={{ reservation_id: id }}
              fields={[
                { name: "reason", label: t("reservation.noshow.reason"), required: true, maxLength: 1000 },
              ]}
              submitLabel={t("reservation.noshow.submit")}
              successText={t("reservation.noshow.success")}
              variant="secondary"
            />
          </section>
        ) : null}
      </>
    );
  });
}
