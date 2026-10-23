import { listHousekeepingTasks, listRooms, opsProperties, serverContext, type TaskView } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, PRIORITY, TASK_KIND, TASK_STATUS } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("housekeeping.list.metadata.title") };

const CREATE = ["owner", "manager", "front_desk"];

// SPEC-housekeeping-maintenance §5: danh sách việc theo tầng; khách đến hôm nay → vừa trả phòng → thời gian tạo (đã sắp ở máy chủ).
export default async function HousekeepingPage() {
  return withActor(t("housekeeping.list.page.title"), "/buong-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("housekeeping.list.error.load")} text={props.message} />;
    if (props.data.length === 0)
      return <EmptyState title={t("ops.no_property.title")} text={t("ops.no_property.text")} />;
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
                title={t("housekeeping.list.error.tasks")}
                text={tasks.message}
                action={
                  <a className="btn" href="/buong-phong">
                    {t("common.retry")}
                  </a>
                }
              />
            ) : tasks.data.length === 0 ? (
              <EmptyState title={t("housekeeping.list.empty.title")} />
            ) : (
              byFloor(tasks.data).map(([floor, items]) => (
                <div key={floor}>
                  <h3>{floor}</h3>
                  <ul className="card-list">
                    {items.map((task) => (
                      <li key={task.id} className="card" data-testid="task">
                        <a href={`/buong-phong/${task.id}`} className="card__link">
                          <span className="card__title">
                            {t("housekeeping.list.card.title", {
                              unit: task.unitCode,
                              kind: TASK_KIND[task.kind] ?? task.kind,
                            })}
                          </span>
                          <span className="card__meta">
                            {task.priority !== "normal"
                              ? `${PRIORITY[task.priority] ?? task.priority} · `
                              : ""}
                            {task.arrivalToday && task.expectedArrivalAt
                              ? t("housekeeping.list.card.arrival", {
                                  time: dateTime(task.expectedArrivalAt, p.timezone),
                                })
                              : ""}
                            {task.assigneeName
                              ? t("housekeeping.list.card.assignee", { name: task.assigneeName })
                              : t("housekeeping.task.facts.assignee_none")}
                          </span>
                          <StatusBadge status={task.status} label={TASK_STATUS[task.status] ?? task.status} />
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
            <h2 id="tao">{t("housekeeping.list.create.heading")}</h2>
            <CommandForm
              path="housekeeping/createTask"
              fields={[
                {
                  name: "unit_id",
                  label: t("housekeeping.list.create.unit"),
                  type: "select",
                  options: rooms.flatMap((p) =>
                    p.rooms.map((u) => ({ value: u.unitId, label: `${u.code} · ${p.propertyName}` })),
                  ),
                },
                {
                  name: "kind",
                  label: t("housekeeping.list.create.kind"),
                  type: "select",
                  options: [
                    { value: "cleaning", label: t("housekeeping.list.create.kind_cleaning") },
                    { value: "inspection", label: t("housekeeping.list.create.kind_inspection") },
                  ],
                },
                {
                  name: "priority",
                  label: t("housekeeping.list.create.priority"),
                  type: "select",
                  options: [
                    { value: "normal", label: t("housekeeping.list.create.priority_normal") },
                    { value: "high", label: t("housekeeping.list.create.priority_high") },
                    { value: "urgent", label: t("housekeeping.list.create.priority_urgent") },
                  ],
                },
                { name: "note", label: t("housekeeping.list.create.note"), maxLength: 2000 },
              ]}
              submitLabel={t("housekeeping.list.create.submit")}
              successText={t("housekeeping.list.create.success")}
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
