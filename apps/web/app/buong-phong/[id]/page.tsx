import { getHousekeepingTask, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import {
  DEFAULT_TIME_ZONE,
  dateTime,
  priorityLabel,
  taskKindLabel,
  taskStatusLabel,
} from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor(
  "label.task_status.",
  "housekeeping.list.create.kind_",
  "housekeeping.list.create.priority_",
);

export const metadata: Metadata = { title: t("housekeeping.task.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Một tác vụ mỗi màn; nút lớn ≥ 44 CSS px "Nhận / Bắt đầu / Xong" (SPEC-housekeeping-maintenance §5). Thành công chỉ báo sau phản hồi máy chủ.
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("housekeeping.task.page.title"), "/buong-phong", async (actor) => {
    const r = await safe(getHousekeepingTask(serverContext().db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title={t("housekeeping.task.error.load")} text={r.message} />;
    }
    const task = r.data;
    const props = await safe(opsProperties(serverContext().db, actor));
    const timeZone =
      (props.ok ? props.data.find((p) => p.id === task.propertyId)?.timezone : undefined) ??
      DEFAULT_TIME_ZONE;
    const lead = ["owner", "manager"].includes(actor.role);
    const mine = task.assigneeMembershipId === actor.membershipId;
    const canClaim = task.status === "open" && ["housekeeping", "owner", "manager"].includes(actor.role);
    const canProgress =
      (lead || (actor.role === "housekeeping" && mine)) && ["assigned", "in_progress"].includes(task.status);
    const canCancel =
      ["owner", "manager", "front_desk"].includes(actor.role) &&
      ["open", "assigned", "in_progress"].includes(task.status);
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">
            {t("housekeeping.task.heading", {
              code: task.unitCode,
              kind: taskKindLabel(LABELS, task.kind),
            })}
          </h2>
          <dl className="facts">
            <dt>{t("housekeeping.task.facts.status")}</dt>
            <dd>
              <StatusBadge
                status={task.status}
                label={taskStatusLabel(LABELS, task.status)}
                testId="task-status"
              />
            </dd>
            <dt>{t("housekeeping.task.facts.floor")}</dt>
            <dd>{task.floor}</dd>
            <dt>{t("housekeeping.task.facts.priority")}</dt>
            <dd>{priorityLabel(LABELS, task.priority)}</dd>
            <dt>{t("housekeeping.task.facts.assignee")}</dt>
            <dd>{task.assigneeName ?? t("housekeeping.task.facts.assignee_none")}</dd>
            {task.arrivalToday && task.expectedArrivalAt ? (
              <>
                <dt>{t("housekeeping.task.facts.arrival")}</dt>
                <dd>
                  {t("housekeeping.task.facts.arrival_today", {
                    time: dateTime(task.expectedArrivalAt, timeZone),
                  })}
                </dd>
              </>
            ) : null}
            {task.note ? (
              <>
                <dt>{t("housekeeping.task.facts.note")}</dt>
                <dd>{task.note}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {canClaim ? (
          <CommandForm
            path="housekeeping/claimTask"
            fixed={{ task_id: id }}
            submitLabel={t("housekeeping.task.claim.submit")}
            successText={t("housekeeping.task.claim.success")}
            className="btn--large"
          />
        ) : null}
        {canProgress && task.status === "assigned" ? (
          <CommandForm
            path="housekeeping/startTask"
            fixed={{ task_id: id }}
            submitLabel={t("housekeeping.task.start.submit")}
            successText={t("housekeeping.task.start.success")}
            className="btn--large"
          />
        ) : null}
        {canProgress && task.status === "in_progress" ? (
          <CommandForm
            path="housekeeping/completeTask"
            fixed={{ task_id: id }}
            fields={[{ name: "note", label: t("housekeeping.task.complete.note"), maxLength: 2000 }]}
            submitLabel={t("housekeeping.task.complete.submit")}
            successText={t("housekeeping.task.complete.success")}
            className="btn--large"
          />
        ) : null}
        {lead && task.status === "done" ? (
          <section aria-labelledby="nt" className="panel">
            <h2 id="nt">{t("housekeeping.task.verify.heading")}</h2>
            <CommandForm
              path="housekeeping/verifyTask"
              fixed={{ task_id: id, result: "pass" }}
              submitLabel={t("housekeeping.task.verify.pass_submit")}
              successText={t("housekeeping.task.verify.pass_success")}
              className="btn--large"
              testId="verify-pass"
            />
            <CommandForm
              path="housekeeping/verifyTask"
              fixed={{ task_id: id, result: "fail" }}
              fields={[
                {
                  name: "reason",
                  label: t("housekeeping.task.verify.fail_reason"),
                  required: true,
                  maxLength: 1000,
                },
              ]}
              submitLabel={t("housekeeping.task.verify.fail_submit")}
              successText={t("housekeeping.task.verify.fail_success")}
              variant="secondary"
              className="btn--large"
            />
          </section>
        ) : null}
        {canCancel ? (
          <details className="details-box">
            <summary>{t("housekeeping.task.cancel.summary")}</summary>
            <CommandForm
              path="housekeeping/cancelTask"
              confirm={t("housekeeping.task.cancel.confirm")}
              confirmLabel={t("housekeeping.task.cancel.label", {
                kind: taskKindLabel(LABELS, task.kind).toLowerCase(),
                room: task.unitCode,
              })}
              fixed={{ task_id: id }}
              fields={[
                {
                  name: "reason",
                  label: t("housekeeping.task.cancel.reason"),
                  required: true,
                  maxLength: 1000,
                },
              ]}
              submitLabel={t("housekeeping.task.cancel.submit")}
              successText={t("housekeeping.task.cancel.success")}
              variant="secondary"
            />
          </details>
        ) : null}
        <p>
          <a className="btn btn--secondary" href="/buong-phong">
            {t("housekeeping.task.back")}
          </a>
        </p>
      </>
    );
  });
}
