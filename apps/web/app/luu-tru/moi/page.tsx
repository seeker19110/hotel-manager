import { listRooms, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { GuestsForm } from "../../../components/hotel/guests-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { addDays, HK_STATUS } from "../../../lib/format.ts";
import { messagesFor } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Khách vãng lai — Hotel Manager" };

// SPEC-reservation-stay S-015/S-016: walk-in = một lệnh tạo booking + lượt ở `in_house`; phòng phải sẵn sàng (đã dọn + kiểm).
export default async function WalkInPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string }>;
}) {
  const q = await searchParams;
  return withActor("Khách vãng lai", "/dat-phong", async (actor) => {
    if (!["owner", "manager", "front_desk"].includes(actor.role))
      return <ErrorState title="Không có quyền" text="Chỉ chủ, quản lý và lễ tân nhận khách." />;
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không mở được form" text={props.message} />;
    const hotels = props.data.filter(
      (p) => p.template !== "rental" && (!q.property_id || p.id === q.property_id),
    );
    const rooms = (await listRooms(db, actor))
      .filter((p) => hotels.some((h) => h.id === p.propertyId))
      .flatMap((p) =>
        p.rooms
          .filter((u) => u.availability === "active")
          .map((u) => ({
            unitId: u.unitId,
            label: `${u.code} — ${HK_STATUS[u.housekeepingStatus] ?? u.housekeepingStatus}`,
          })),
      );
    if (rooms.length === 0) return <EmptyState title="Chưa có phòng để nhận khách" />;
    const today = hotels[0]?.businessDate ?? new Date().toISOString().slice(0, 10);
    return (
      <GuestsForm
        path="stay/walkIn"
        fixed={{}}
        rooms={rooms}
        defaultDeparture={addDays(today, 1)}
        submitLabel="Nhận khách ngay"
        successText="Đã nhận khách — đang mở folio."
        m={messagesFor("guests_form.")}
      />
    );
  });
}
