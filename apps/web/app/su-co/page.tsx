import { listRooms, listWorkOrders, opsProperties, serverContext, type WorkOrderView } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { IncidentForm } from "../../components/hotel/incident-form.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, SEVERITY, WORK_ORDER_STATUS } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Sự cố — Hotel Manager" };

const LEAD = ["owner", "manager"];
const ACTIVE = new Set(["open", "assigned", "in_progress", "done"]);

export default async function IncidentsPage() {
  return withActor("Sự cố", "/su-co", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không xem được sự cố" text={props.message} />;
    if (props.data.length === 0)
      return <EmptyState title="Chưa có cơ sở nào được giao" text="Liên hệ quản lý để được giao cơ sở." />;
    const [lists, rooms] = await Promise.all([
      Promise.all(
        props.data.map(async (p) => ({
          p,
          orders: await safe(listWorkOrders(db, actor, { propertyId: p.id })),
        })),
      ),
      listRooms(db, actor),
    ]);
    const roomOptions = rooms.flatMap((p) =>
      p.rooms.map((u) => ({
        unitId: u.unitId,
        propertyId: p.propertyId,
        label: `${u.code}${rooms.length > 1 ? ` · ${p.propertyName}` : ""}`,
      })),
    );
    const action = (w: WorkOrderView) => {
      const lead = LEAD.includes(actor.role);
      const mine = w.assigneeMembershipId === actor.membershipId;
      return (
        <div className="card__actions">
          {w.status === "open" && lead ? (
            <CommandForm
              path="maintenance/assignWorkOrder"
              fixed={{ work_order_id: w.id, assignee_membership_id: actor.membershipId }}
              submitLabel="Nhận xử lý"
              successText="Đã nhận xử lý."
            />
          ) : null}
          {w.status === "assigned" && (lead || mine) ? (
            <CommandForm
              path="maintenance/startWorkOrder"
              fixed={{ work_order_id: w.id }}
              submitLabel="Bắt đầu sửa"
              successText="Đã bắt đầu sửa."
            />
          ) : null}
          {w.status === "in_progress" && (lead || mine) ? (
            <CommandForm
              path="maintenance/completeWorkOrder"
              fixed={{ work_order_id: w.id }}
              fields={[{ name: "note", label: `Ghi chú sau sửa (${w.unitCode})`, maxLength: 2000 }]}
              submitLabel="Đã sửa xong"
              successText="Đã báo sửa xong — chờ nghiệm thu."
            />
          ) : null}
          {w.status === "done" && lead ? (
            <CommandForm
              path="maintenance/verifyWorkOrder"
              fixed={{ work_order_id: w.id }}
              submitLabel="Nghiệm thu"
              successText="Đã nghiệm thu — việc dọn phòng đã được tạo."
            />
          ) : null}
          {lead && ["open", "assigned", "in_progress"].includes(w.status) ? (
            <details className="details-box">
              <summary>Huỷ phiếu {w.unitCode}</summary>
              <CommandForm
                path="maintenance/cancelWorkOrder"
                confirm="Huỷ phiếu sự cố; không mở lại được."
                confirmLabel={`Huỷ phiếu sự cố phòng ${w.unitCode}`}
                fixed={{ work_order_id: w.id }}
                fields={[{ name: "reason", label: "Lý do huỷ", required: true, maxLength: 1000 }]}
                submitLabel="Huỷ phiếu"
                successText="Đã huỷ phiếu."
                variant="secondary"
              />
            </details>
          ) : null}
        </div>
      );
    };
    return (
      <>
        {lists.map(({ p, orders }) => (
          <section key={p.id} aria-labelledby={`s-${p.id}`} className="panel">
            <h2 id={`s-${p.id}`}>{p.name}</h2>
            {!orders.ok ? (
              <ErrorState
                title="Không tải được sự cố"
                text={orders.message}
                action={
                  <a className="btn" href="/su-co">
                    Thử lại
                  </a>
                }
              />
            ) : orders.data.filter((w) => ACTIVE.has(w.status)).length === 0 ? (
              <EmptyState title="Không có sự cố đang mở" />
            ) : (
              <ul className="card-list">
                {orders.data
                  .filter((w) => ACTIVE.has(w.status))
                  .map((w) => (
                    <li key={w.id} className="card" data-testid="work-order">
                      <p className="card__title">
                        Phòng {w.unitCode}: {w.title}
                      </p>
                      <p className="card__meta">
                        {t("workorder.list.meta", {
                          severity: SEVERITY[w.severity]?.toLowerCase() ?? w.severity,
                          createdAt: dateTime(w.createdAt, p.timezone),
                        })}
                        {w.photoFileIds.length > 0 ? ` · ${w.photoFileIds.length} ảnh đính kèm` : ""}
                      </p>
                      <p className="card__meta">{w.description}</p>
                      <StatusBadge status={w.status} label={WORK_ORDER_STATUS[w.status] ?? w.status} />
                      {action(w)}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        ))}
        {roomOptions.length > 0 ? (
          <section aria-labelledby="bao" className="panel">
            <h2 id="bao">Báo sự cố mới</h2>
            <IncidentForm rooms={roomOptions} />
          </section>
        ) : null}
      </>
    );
  });
}
