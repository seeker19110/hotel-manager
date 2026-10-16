import { getReservation, listRooms, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { GuestsForm } from "../../../components/hotel/guests-form.tsx";
import { HoldCountdown } from "../../../components/hotel/hold-countdown.tsx";
import { ShiftPanel } from "../../../components/hotel/shift-panel.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import { BOOKING_STATUS, dateTime, day, vnd } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Chi tiết đặt phòng — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = ["owner", "manager", "front_desk"];

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Chi tiết đặt phòng", "/dat-phong", async (actor) => {
    const db = serverContext().db;
    const r = await safe(getReservation(db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title="Không xem được đặt phòng" text={r.message} />;
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
          <h2 id="tt">
            {b.number} — Phòng {room?.code ?? "—"}
          </h2>
          <dl className="facts">
            <dt>Trạng thái</dt>
            <dd>
              <StatusBadge
                status={b.status}
                label={BOOKING_STATUS[b.status] ?? b.status}
                testId="booking-status"
              />
            </dd>
            <dt>Người đặt</dt>
            <dd>{b.bookerName}</dd>
            <dt>Ở từ</dt>
            <dd>
              {day(b.arrivalDate)} → {day(b.departureDate)} ({b.nights} đêm, {b.guests} khách)
            </dd>
            <dt>Tiền phòng</dt>
            <dd data-testid="room-total">{vnd(b.roomTotal)}</dd>
            {b.status === "held" && b.heldUntil ? (
              <>
                <dt>Hạn giữ phòng</dt>
                <dd>
                  <HoldCountdown until={b.heldUntil.toISOString()} untilText={dateTime(b.heldUntil)} />
                </dd>
              </>
            ) : null}
          </dl>
          <table className="lines">
            <caption>Giá từng đêm (đã chốt khi đặt)</caption>
            <thead>
              <tr>
                <th scope="col">Đêm</th>
                <th scope="col">Giá</th>
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
              Mở folio lượt ở
            </a>
          </p>
        ) : null}

        {canManage && b.status === "draft" ? (
          <section aria-labelledby="a-hold" className="panel">
            <h2 id="a-hold">Giữ phòng</h2>
            <CommandForm
              path="reservation/hold"
              fixed={{ reservation_id: id }}
              submitLabel="Giữ phòng"
              successText="Đã giữ phòng."
            />
          </section>
        ) : null}

        {canManage && b.status === "held" ? (
          <section aria-labelledby="a-confirm" className="panel">
            <h2 id="a-confirm">Xác nhận đặt phòng</h2>
            <CommandForm
              path="reservation/confirm"
              fixed={{ reservation_id: id }}
              submitLabel="Xác nhận (chưa thu trước)"
              successText="Đã xác nhận đặt phòng."
              testId="confirm-plain"
            />
            <h3>Xác nhận kèm ứng trước tiền mặt</h3>
            {property ? <ShiftPanel property={property} /> : null}
            <CommandForm
              path="reservation/confirm"
              fixed={{ reservation_id: id, payment: { method: "cash", kind: "advance" } }}
              fields={[
                {
                  name: "advance",
                  path: "payment.amount",
                  label: "Ứng trước tiền mặt (đồng)",
                  type: "money",
                  required: true,
                },
              ]}
              submitLabel="Xác nhận + thu ứng trước"
              successText="Đã xác nhận và ghi nhận ứng trước."
              variant="secondary"
            />
          </section>
        ) : null}

        {canManage && b.status === "confirmed" && b.stayId && b.stayStatus === "expected" ? (
          <section aria-labelledby="a-in" className="panel">
            <h2 id="a-in">Nhận phòng</h2>
            <p className="card__meta">
              Chỉ nhận phòng trong khoảng ngày của đặt phòng và khi phòng đã dọn + kiểm xong.
            </p>
            <GuestsForm
              path="stay/checkIn"
              fixed={{ reservation_id: id }}
              submitLabel="Xác nhận nhận phòng"
              successText="Đã nhận phòng — đang mở folio."
            />
          </section>
        ) : null}

        {canManage && ["draft", "held", "confirmed"].includes(b.status) ? (
          <section aria-labelledby="a-cancel" className="panel">
            <h2 id="a-cancel">Huỷ đặt phòng</h2>
            <CommandForm
              path="reservation/cancel"
              fixed={{ reservation_id: id }}
              fields={[
                { name: "reason", label: "Lý do huỷ", required: true, maxLength: 1000 },
                { name: "cancellation_fee", label: "Phí huỷ (đồng, tuỳ chọn)", type: "money" },
              ]}
              submitLabel="Huỷ đặt phòng"
              successText="Đã huỷ đặt phòng."
              variant="secondary"
            />
          </section>
        ) : null}

        {canManage && b.status === "confirmed" ? (
          <section aria-labelledby="a-noshow" className="panel">
            <h2 id="a-noshow">Khách không đến</h2>
            <CommandForm
              path="reservation/markNoShow"
              fixed={{ reservation_id: id }}
              fields={[{ name: "reason", label: "Ghi chú", required: true, maxLength: 1000 }]}
              submitLabel="Đánh dấu không đến"
              successText="Đã đánh dấu không đến."
              variant="secondary"
            />
          </section>
        ) : null}
      </>
    );
  });
}
