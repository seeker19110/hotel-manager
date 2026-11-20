import { getHousekeepingTaskBoard, listRooms, opsProperties, serverContext, type TaskView } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../components/command/command-form.tsx";
import { FloorTaskFilter } from "../../components/hotel/floor-task-filter.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, priorityLabel, taskKindLabel, taskStatusLabel } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor(
  "label.task_status.",
  "housekeeping.list.create.kind_",
  "housekeeping.list.create.priority_",
);

export const metadata: Metadata = { title: t("housekeeping.list.metadata.title") };

const CREATE = ["owner", "manager", "front_desk"];

// SPEC-housekeeping-maintenance §5: danh sách việc theo tầng; khách đến hôm nay → vừa trả phòng → thời gian tạo (đã sắp ở máy chủ).
export default async function HousekeepingPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string | string[]; floor?: string | string[] }>;
}) {
  const { property, floor } = await searchParams;
  return withActor(t("housekeeping.list.page.title"), "/buong-phong", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("housekeeping.list.error.load")} text={props.message} />;
    if (Array.isArray(floor) || Array.isArray(property) || (property === undefined) !== (floor === undefined))
      notFound();
    if (property !== undefined && !props.data.some((p) => p.id === property)) notFound();
    if (props.data.length === 0)
      return <EmptyState title={t("ops.no_property.title")} text={t("ops.no_property.text")} />;
    const lists = await Promise.all(
      props.data.map(async (p) => {
        const selected = p.id === property ? floor : undefined;
        const board = await safe(getHousekeepingTaskBoard(db, actor, p.id, selected));
        if (selected !== undefined && !board.ok && board.status === 404) notFound();
        return { p, board, selected };
      }),
    );
    const rooms = CREATE.includes(actor.role) ? await listRooms(db, actor) : [];
    return (
      <>
        {lists.map(({ p, board, selected }) => (
          <section key={p.id} aria-labelledby={`h-${p.id}`} className="panel">
            <h2 id={`h-${p.id}`}>{p.name}</h2>
            {board.ok && (
              <FloorTaskFilter
                propertyId={p.id}
                floors={board.data.floors}
                selected={selected}
                label={t("housekeeping.list.filter.label", { property: p.name })}
                all={t("housekeeping.list.filter.all")}
              />
            )}
            {!board.ok ? (
              <ErrorState
                title={t("housekeeping.list.error.tasks")}
                text={board.message}
                action={
                  <a className="btn" href="/buong-phong">
                    {t("common.retry")}
                  </a>
                }
              />
            ) : board.data.tasks.length === 0 ? (
              <EmptyState title={t("housekeeping.list.empty.title")} />
            ) : (
              byFloor(board.data.tasks).map(([floor, items]) => (
                <div key={floor}>
                  <h3>{floor}</h3>
                  <ul className="card-list">
                    {items.map((task) => (
                      <li key={task.id} className="card" data-testid="task">
                        <a href={`/buong-phong/${task.id}`} className="card__link">
                          <span className="card__title">
                            {t("housekeeping.list.card.title", {
                              unit: task.unitCode,
                              kind: taskKindLabel(LABELS, task.kind),
                            })}
                          </span>
                          <span className="card__meta">
                            {task.priority !== "normal" ? `${priorityLabel(LABELS, task.priority)} · ` : ""}
                            {task.arrivalToday && task.expectedArrivalAt
                              ? t("housekeeping.list.card.arrival", {
                                  time: dateTime(task.expectedArrivalAt, p.timezone),
                                })
                              : ""}
                            {task.assigneeName
                              ? t("housekeeping.list.card.assignee", { name: task.assigneeName })
                              : t("housekeeping.task.facts.assignee_none")}
                          </span>
                          <StatusBadge status={task.status} label={taskStatusLabel(LABELS, task.status)} />
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
