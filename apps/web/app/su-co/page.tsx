import { listRooms, listWorkOrders, opsProperties, serverContext, type WorkOrderView } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { IncidentForm } from "../../components/hotel/incident-form.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { dateTime, severityLabel, workOrderStatusLabel } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("incident_form.severity.", "label.work_order_status.");

export const metadata: Metadata = { title: t("incident.metadata.title") };

const LEAD = ["owner", "manager"];
const ACTIVE = new Set(["open", "assigned", "in_progress", "done"]);

export default async function IncidentsPage() {
  return withActor(t("incident.page.title"), "/su-co", async (actor) => {
    const db = serverContext().db;
    const props = await safe(opsProperties(db, actor));
    if (!props.ok) return <ErrorState title={t("incident.error.load")} text={props.message} />;
    if (props.data.length === 0)
      return <EmptyState title={t("ops.no_property.title")} text={t("ops.no_property.text")} />;
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
              submitLabel={t("incident.assign.submit")}
              successText={t("incident.assign.success")}
            />
          ) : null}
          {w.status === "assigned" && (lead || mine) ? (
            <CommandForm
              path="maintenance/startWorkOrder"
              fixed={{ work_order_id: w.id }}
              submitLabel={t("incident.start.submit")}
              successText={t("incident.start.success")}
            />
          ) : null}
          {w.status === "in_progress" && (lead || mine) ? (
            <CommandForm
              path="maintenance/completeWorkOrder"
              fixed={{ work_order_id: w.id }}
              fields={[
                { name: "note", label: t("incident.complete.note", { unit: w.unitCode }), maxLength: 2000 },
              ]}
              submitLabel={t("incident.complete.submit")}
              successText={t("incident.complete.success")}
            />
          ) : null}
          {w.status === "done" && lead ? (
            <CommandForm
              path="maintenance/verifyWorkOrder"
              fixed={{ work_order_id: w.id }}
              submitLabel={t("incident.verify.submit")}
              successText={t("incident.verify.success")}
            />
          ) : null}
          {lead && ["open", "assigned", "in_progress"].includes(w.status) ? (
            <details className="details-box">
              <summary>{t("incident.cancel.summary", { unit: w.unitCode })}</summary>
              <CommandForm
                path="maintenance/cancelWorkOrder"
                confirm={t("incident.cancel.confirm")}
                confirmLabel={t("incident.cancel.label", { unit: w.unitCode })}
                fixed={{ work_order_id: w.id }}
                fields={[
                  { name: "reason", label: t("incident.cancel.reason"), required: true, maxLength: 1000 },
                ]}
                submitLabel={t("incident.cancel.submit")}
                successText={t("incident.cancel.success")}
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
                title={t("incident.error.orders")}
                text={orders.message}
                action={
                  <a className="btn" href="/su-co">
                    {t("common.retry")}
                  </a>
                }
              />
            ) : orders.data.filter((w) => ACTIVE.has(w.status)).length === 0 ? (
              <EmptyState title={t("incident.empty.title")} />
            ) : (
              <ul className="card-list">
                {orders.data
                  .filter((w) => ACTIVE.has(w.status))
                  .map((w) => (
                    <li key={w.id} className="card" data-testid="work-order">
                      <p className="card__title">
                        {t("incident.card.title", { unit: w.unitCode, title: w.title })}
                      </p>
                      <p className="card__meta">
                        {t("workorder.list.meta", {
                          severity: severityLabel(LABELS, w.severity)?.toLowerCase() ?? w.severity,
                          createdAt: dateTime(w.createdAt, p.timezone),
                        })}
                        {w.photoFileIds.length > 0
                          ? t("incident.card.photos", { count: w.photoFileIds.length })
                          : ""}
                      </p>
                      <p className="card__meta">{w.description}</p>
                      <StatusBadge status={w.status} label={workOrderStatusLabel(LABELS, w.status)} />
                      {action(w)}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        ))}
        {roomOptions.length > 0 ? (
          <section aria-labelledby="bao" className="panel">
            <h2 id="bao">{t("incident.new.heading")}</h2>
            <IncidentForm rooms={roomOptions} m={messagesFor("incident_form.")} />
          </section>
        ) : null}
      </>
    );
  });
}
