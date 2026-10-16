import { listRooms, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ORG_CONTEXT_META } from "../../components/command/org-context.ts";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { currentActor } from "../../lib/session.ts";

export const metadata: Metadata = { title: "Phòng — Hotel Manager" };

const HK_LABEL: Record<string, string> = {
  dirty: "Bẩn",
  assigned: "Đã giao dọn",
  cleaning: "Đang dọn",
  clean: "Sạch",
  inspected: "Đã kiểm",
};

export default async function RoomsPage() {
  const r = await currentActor();
  if (r.kind === "login") redirect("/dang-nhap");
  if (r.kind === "choose-org") redirect("/chon-to-chuc");
  if (r.kind === "mfa-required") {
    return (
      <main id="main" className="page">
        <h1>Phòng</h1>
        <ErrorState
          title="Cần bật xác thực hai lớp"
          text="Vai trò của bạn có quyền về tiền hoặc quản trị. Hãy bật xác thực hai lớp trước khi thao tác."
        />
      </main>
    );
  }
  // Người thuê chỉ có portal (SPEC-portal S-005).
  if (r.actor.role === "tenant") redirect("/portal");
  const properties = await listRooms(serverContext().db, r.actor);
  return (
    <main id="main" className="page">
      <meta name={ORG_CONTEXT_META} content={r.actor.orgId} />
      <h1>Phòng</h1>
      {properties.length === 0 ? (
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
      )}
    </main>
  );
}
