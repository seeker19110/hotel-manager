import { listRooms, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState } from "../../components/ui/state.tsx";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: t("rooms.metadata.title") };

const HK_LABEL: Record<string, string> = {
  dirty: t("rooms.hk.dirty"),
  assigned: t("rooms.hk.assigned"),
  cleaning: t("rooms.hk.cleaning"),
  clean: t("rooms.hk.clean"),
  inspected: t("rooms.hk.inspected"),
};

export default async function RoomsPage() {
  // Khung chung (đăng nhập, tổ chức, MFA, người thuê → portal, thanh điều hướng): đây là trang đầu sau khi chọn tổ chức.
  return withActor(t("rooms.title"), "/phong", async (actor) => {
    const properties = await listRooms(serverContext().db, actor);
    return properties.length === 0 ? (
      <EmptyState title={t("ops.no_property.title")} text={t("ops.no_property.text")} />
    ) : (
      properties.map((p) => (
        <section key={p.propertyId} aria-labelledby={`p-${p.propertyId}`} className="room-group">
          <h2 id={`p-${p.propertyId}`}>{p.propertyName}</h2>
          {p.rooms.length === 0 ? (
            <EmptyState title={t("calendar.empty.units")} />
          ) : (
            <ul className="room-list">
              {p.rooms.map((u) => (
                <li key={u.unitId} className="room-list__item" data-testid="room">
                  <span className="room-list__code">{u.code}</span>
                  <span className="room-list__meta">
                    {u.floorName}
                    {u.roomTypeName ? ` · ${u.roomTypeName}` : ""}
                  </span>
                  <span className="room-list__status">
                    {u.availability === "out_of_service"
                      ? t("calendar.room.out_of_service")
                      : (HK_LABEL[u.housekeepingStatus] ?? u.housekeepingStatus)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))
    );
  });
}
