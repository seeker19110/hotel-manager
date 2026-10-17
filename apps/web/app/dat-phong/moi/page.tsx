import { isoDateOr, listRooms, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { BookingForm } from "../../../components/hotel/booking-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { addDays } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Đặt phòng mới — Hotel Manager" };

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string; unit?: string; arrival?: string }>;
}) {
  const q = await searchParams;
  return withActor("Đặt phòng mới", "/dat-phong", async (actor) => {
    if (!["owner", "manager", "front_desk"].includes(actor.role))
      return <ErrorState title="Không có quyền" text="Chỉ chủ, quản lý và lễ tân tạo được đặt phòng." />;
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không mở được form" text={props.message} />;
    const hotels = props.data.filter((p) => p.template !== "rental");
    const rooms = (await listRooms(db, actor)).filter((p) => hotels.some((h) => h.id === p.propertyId));
    const bookable = rooms.flatMap((p) =>
      p.rooms
        .filter((u) => u.availability === "active")
        .map((u) => ({
          unitId: u.unitId,
          label: `${u.code}${u.roomTypeName ? ` · ${u.roomTypeName}` : ""}${rooms.length > 1 ? ` · ${p.propertyName}` : ""}`,
          propertyId: p.propertyId,
        })),
    );
    if (bookable.length === 0)
      return <EmptyState title="Chưa có phòng để đặt" text="Cơ sở cần có phòng đang hoạt động." />;
    const today = hotels[0]?.businessDate ?? new Date().toISOString().slice(0, 10);
    const arrival = isoDateOr(q.arrival, today);
    const preferred =
      bookable.find((r) => r.unitId === q.unit) ?? bookable.find((r) => r.propertyId === q.property_id);
    return (
      <BookingForm
        rooms={bookable.map(({ unitId, label }) => ({ unitId, label }))}
        defaults={{
          unitId: (preferred ?? bookable[0])?.unitId ?? "",
          arrival,
          departure: addDays(arrival, 1),
        }}
      />
    );
  });
}
