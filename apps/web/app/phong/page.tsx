import { listRooms, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { EmptyState } from "../../components/ui/state.tsx";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Phòng — Hotel Manager" };

const HK_LABEL: Record<string, string> = {
  dirty: "Bẩn",
  assigned: "Đã giao dọn",
  cleaning: "Đang dọn",
  clean: "Sạch",
  inspected: "Đã kiểm",
};

export default async function RoomsPage() {
  // Khung chung (đăng nhập, tổ chức, MFA, người thuê → portal, thanh điều hướng): đây là trang đầu sau khi chọn tổ chức.
  return withActor("Phòng", "/phong", async (actor) => {
    const properties = await listRooms(serverContext().db, actor);
    return properties.length === 0 ? (
      <EmptyState title="Chưa có cơ sở nào được giao" text="Liên hệ quản lý để được giao cơ sở." />
    ) : (
      properties.map((p) => (
        <section key={p.propertyId} aria-labelledby={`p-${p.propertyId}`} className="room-group">
          <h2 id={`p-${p.propertyId}`}>{p.propertyName}</h2>
          {p.rooms.length === 0 ? (
            <EmptyState title="Cơ sở chưa có phòng" />
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
                      ? "Ngừng sử dụng"
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
