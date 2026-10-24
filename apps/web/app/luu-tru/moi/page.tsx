import { listRooms, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { GuestsForm } from "../../../components/hotel/guests-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { addDays, hkStatusLabel } from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("rooms.hk.", "label.hk_status.");

export const metadata: Metadata = { title: t("walk_in.metadata.title") };

// SPEC-reservation-stay S-015/S-016: walk-in = một lệnh tạo booking + lượt ở `in_house`; phòng phải sẵn sàng (đã dọn + kiểm).
export default async function WalkInPage({
  searchParams,
}: {
  searchParams: Promise<{ property_id?: string }>;
}) {
  const q = await searchParams;
  return withActor(t("walk_in.page.title"), "/dat-phong", async (actor) => {
    if (!["owner", "manager", "front_desk"].includes(actor.role))
      return (
        <ErrorState title={t("walk_in.error.forbidden_title")} text={t("walk_in.error.forbidden_text")} />
      );
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("walk_in.error.load_title")} text={props.message} />;
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
            label: `${u.code} — ${hkStatusLabel(LABELS, u.housekeepingStatus)}`,
          })),
      );
    if (rooms.length === 0) return <EmptyState title={t("walk_in.empty.title")} />;
    const today = hotels[0]?.businessDate ?? new Date().toISOString().slice(0, 10);
    return (
      <GuestsForm
        path="stay/walkIn"
        fixed={{}}
        rooms={rooms}
        defaultDeparture={addDays(today, 1)}
        submitLabel={t("walk_in.submit")}
        successText={t("walk_in.success")}
        m={messagesFor("guests_form.")}
      />
    );
  });
}
