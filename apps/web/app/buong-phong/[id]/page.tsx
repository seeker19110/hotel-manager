import { getHousekeepingTask, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import { dateTime, PRIORITY, TASK_KIND, TASK_STATUS } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Việc dọn phòng — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Một tác vụ mỗi màn; nút lớn ≥ 44 CSS px "Nhận / Bắt đầu / Xong" (SPEC-housekeeping-maintenance §5). Thành công chỉ báo sau phản hồi máy chủ.
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Việc dọn phòng", "/buong-phong", async (actor) => {
    const r = await safe(getHousekeepingTask(serverContext().db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title="Không xem được việc" text={r.message} />;
    }
    const t = r.data;
    const lead = ["owner", "manager"].includes(actor.role);
    const mine = t.assigneeMembershipId === actor.membershipId;
    const canClaim = t.status === "open" && ["housekeeping", "owner", "manager"].includes(actor.role);
    const canProgress =
      (lead || (actor.role === "housekeeping" && mine)) && ["assigned", "in_progress"].includes(t.status);
    const canCancel =
      ["owner", "manager", "front_desk"].includes(actor.role) &&
      ["open", "assigned", "in_progress"].includes(t.status);
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">
            Phòng {t.unitCode} — {TASK_KIND[t.kind] ?? t.kind}
          </h2>
          <dl className="facts">
            <dt>Trạng thái</dt>
            <dd>
              <StatusBadge status={t.status} label={TASK_STATUS[t.status] ?? t.status} testId="task-status" />
            </dd>
            <dt>Tầng</dt>
            <dd>{t.floor}</dd>
            <dt>Ưu tiên</dt>
            <dd>{PRIORITY[t.priority] ?? t.priority}</dd>
            <dt>Người làm</dt>
            <dd>{t.assigneeName ?? "Chưa có người nhận"}</dd>
            {t.arrivalToday && t.expectedArrivalAt ? (
              <>
                <dt>Khách đến</dt>
                <dd>Hôm nay lúc {dateTime(t.expectedArrivalAt)}</dd>
              </>
            ) : null}
            {t.note ? (
              <>
                <dt>Ghi chú</dt>
                <dd>{t.note}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {canClaim ? (
          <CommandForm
            path="housekeeping/claimTask"
            fixed={{ task_id: id }}
            submitLabel="Nhận việc"
            successText="Đã nhận việc."
            className="btn--large"
          />
        ) : null}
        {canProgress && t.status === "assigned" ? (
          <CommandForm
            path="housekeeping/startTask"
            fixed={{ task_id: id }}
            submitLabel="Bắt đầu dọn"
            successText="Đã bắt đầu."
            className="btn--large"
          />
        ) : null}
        {canProgress && t.status === "in_progress" ? (
          <CommandForm
            path="housekeeping/completeTask"
            fixed={{ task_id: id }}
            fields={[{ name: "note", label: "Ghi chú (tuỳ chọn)", maxLength: 2000 }]}
            submitLabel="Xong"
            successText="Đã báo xong — chờ nghiệm thu."
            className="btn--large"
          />
        ) : null}
        {lead && t.status === "done" ? (
          <section aria-labelledby="nt" className="panel">
            <h2 id="nt">Nghiệm thu</h2>
            <CommandForm
              path="housekeeping/verifyTask"
              fixed={{ task_id: id, result: "pass" }}
              submitLabel="Đạt — phòng sẵn sàng"
              successText="Đã nghiệm thu — phòng sẵn sàng."
              className="btn--large"
              testId="verify-pass"
            />
            <CommandForm
              path="housekeeping/verifyTask"
              fixed={{ task_id: id, result: "fail" }}
              fields={[{ name: "reason", label: "Lý do không đạt", required: true, maxLength: 1000 }]}
              submitLabel="Không đạt"
              successText="Đã trả lại việc cho người làm."
              variant="secondary"
              className="btn--large"
            />
          </section>
        ) : null}
        {canCancel ? (
          <details className="details-box">
            <summary>Huỷ việc</summary>
            <CommandForm
              path="housekeeping/cancelTask"
              confirm="Huỷ việc dọn phòng; không mở lại được."
              fixed={{ task_id: id }}
              fields={[{ name: "reason", label: "Lý do huỷ", required: true, maxLength: 1000 }]}
              submitLabel="Huỷ việc"
              successText="Đã huỷ việc."
              variant="secondary"
            />
          </details>
        ) : null}
        <p>
          <a className="btn btn--secondary" href="/buong-phong">
            Về danh sách việc
          </a>
        </p>
      </>
    );
  });
}
