import { listHousekeepingTasks, listRooms, opsProperties, serverContext, type TaskView } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, PRIORITY, TASK_KIND, TASK_STATUS } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: "Buồng phòng — Hotel Manager" };

const CREATE = ["owner", "manager", "front_desk"];

// SPEC-housekeeping-maintenance §5: danh sách việc theo tầng; khách đến hôm nay → vừa trả phòng → thời gian tạo (đã sắp ở máy chủ).
export default async function HousekeepingPage() {
  return withActor("Buồng phòng", "/buong-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title="Không xem được việc dọn" text={props.message} />;
    if (props.data.length === 0)
      return <EmptyState title="Chưa có cơ sở nào được giao" text="Liên hệ quản lý để được giao cơ sở." />;
    const lists = await Promise.all(
      props.data.map(async (p) => ({
        p,
        tasks: await safe(listHousekeepingTasks(db, actor, { propertyId: p.id })),
      })),
    );
    const rooms = CREATE.includes(actor.role) ? await listRooms(db, actor) : [];
    return (
      <>
        {lists.map(({ p, tasks }) => (
          <section key={p.id} aria-labelledby={`h-${p.id}`} className="panel">
            <h2 id={`h-${p.id}`}>{p.name}</h2>
            {!tasks.ok ? (
              <ErrorState
                title="Không tải được việc dọn"
                text={tasks.message}
                action={
                  <a className="btn" href="/buong-phong">
                    Thử lại
                  </a>
                }
              />
            ) : tasks.data.length === 0 ? (
              <EmptyState title="Không có phòng cần dọn" />
            ) : (
              byFloor(tasks.data).map(([floor, items]) => (
                <div key={floor}>
                  <h3>{floor}</h3>
                  <ul className="card-list">
                    {items.map((t) => (
                      <li key={t.id} className="card" data-testid="task">
                        <a href={`/buong-phong/${t.id}`} className="card__link">
                          <span className="card__title">
                            Phòng {t.unitCode} — {TASK_KIND[t.kind] ?? t.kind}
                          </span>
                          <span className="card__meta">
                            {t.priority !== "normal" ? `${PRIORITY[t.priority] ?? t.priority} · ` : ""}
                            {t.arrivalToday && t.expectedArrivalAt
                              ? `Khách đến hôm nay lúc ${dateTime(t.expectedArrivalAt, p.timezone)} · `
                              : ""}
                            {t.assigneeName ? `Người làm: ${t.assigneeName}` : "Chưa có người nhận"}
                          </span>
                          <StatusBadge status={t.status} label={TASK_STATUS[t.status] ?? t.status} />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        ))}
        {CREATE.includes(actor.role) && rooms.length > 0 ? (
          <section aria-labelledby="tao" className="panel">
            <h2 id="tao">Tạo việc thủ công</h2>
            <CommandForm
              path="housekeeping/createTask"
              fields={[
                {
                  name: "unit_id",
                  label: "Phòng",
                  type: "select",
                  options: rooms.flatMap((p) =>
                    p.rooms.map((u) => ({ value: u.unitId, label: `${u.code} · ${p.propertyName}` })),
                  ),
                },
                {
                  name: "kind",
                  label: "Loại việc",
                  type: "select",
                  options: [
                    { value: "cleaning", label: "Dọn phòng" },
                    { value: "inspection", label: "Kiểm tra phòng" },
                  ],
                },
                {
                  name: "priority",
                  label: "Mức ưu tiên",
                  type: "select",
                  options: [
                    { value: "normal", label: "Thường" },
                    { value: "high", label: "Ưu tiên" },
                    { value: "urgent", label: "Khẩn" },
                  ],
                },
                { name: "note", label: "Ghi chú (tuỳ chọn)", maxLength: 2000 },
              ]}
              submitLabel="Tạo việc"
              successText="Đã tạo việc."
              variant="secondary"
            />
          </section>
        ) : null}
      </>
    );
  });
}

function byFloor(tasks: TaskView[]): [string, TaskView[]][] {
  const m = new Map<string, TaskView[]>();
  for (const t of tasks) m.set(t.floor, [...(m.get(t.floor) ?? []), t]);
  return [...m.entries()];
}
