import {
  AUDIT_ACTOR_TYPES,
  type AuditEvent,
  listAuditActions,
  listAuditActors,
  listAuditEvents,
  listMyExports,
  listSupportGrants,
  SUPPORT_GRANT_MAX_HOURS,
  serverContext,
} from "@hm/app";
import { safeUrl } from "@hm/app/http";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { StatusBadge } from "../../components/ui/badge.tsx";
import { SelectField, TextField } from "../../components/ui/field.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { addDays } from "../../lib/format.ts";
import { t, tOr } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("audit_log.metadata.title") };

// IND-SAAS-009, CMP-AUDIT-002 (T-2313, D-122): nhật ký hoạt động của tổ chức — lọc theo khoảng thời gian (ngày UTC), người thực hiện,
// loại hành động, nguồn (hỗ trợ nền tảng hiện rõ); phân trang con trỏ; xuất CSV qua cơ chế exports (chỉ owner — ma trận `data.export`
// + loại `audit`). Khối "Truy cập hỗ trợ": danh sách grant, owner cấp (lý do + ≤ 72 giờ) và thu hồi một bước. Quyền thật kiểm ở server.
const VIEW_ROLES = ["owner", "manager", "accountant"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z_]+(\.[a-z_]+)+$/;
const DEFAULT_DAYS = 7;

interface Query {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  source?: string;
  cursor?: string;
}

/** `YYYY-MM-DDTHH:MM:SS UTC` — giờ UTC như dữ liệu lưu (không đổi theo múi giờ máy). */
const utc = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;

function hrefWith(q: Query, extra: Partial<Query>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/nhat-ky?${s}` : "/nhat-ky";
}

function actionLabel(action: string): string {
  return tOr(`audit_log.action.${action}`, action);
}

function EventItem({ e }: { e: AuditEvent }) {
  const support = e.actorType === "platform_support";
  const who = e.actorName ?? tOr(`audit_log.source.${e.actorType}`, e.actorType);
  return (
    <li className="card audit-item" data-testid="audit-event" data-action={e.action}>
      <p className="card__title">
        {actionLabel(e.action)} · {who}
      </p>
      {support ? (
        <StatusBadge
          status="platform_support"
          label={t("audit_log.source.platform_support")}
          testId="support-badge"
        />
      ) : null}
      <dl className="facts">
        <dt>{t("audit_log.field.when")}</dt>
        <dd>
          <time dateTime={new Date(e.occurredAt).toISOString()}>{utc(new Date(e.occurredAt))}</time>
        </dd>
        <dt>{t("audit_log.field.action")}</dt>
        <dd>
          <code>{e.action}</code>
        </dd>
        <dt>{t("audit_log.field.target")}</dt>
        <dd>{e.entityId ? `${e.entityType} ${e.entityId}` : e.entityType}</dd>
        <dt>{t("audit_log.field.result")}</dt>
        <dd>{tOr(`audit_log.outcome.${e.outcome}`, e.outcome)}</dd>
        <dt>{t("audit_log.field.where")}</dt>
        <dd>{[e.sourceIp, e.userAgent].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>{t("audit_log.field.reason")}</dt>
        <dd>{e.reason ?? "—"}</dd>
        {support ? (
          <>
            <dt>{t("audit_log.field.support_grant")}</dt>
            <dd>{t("audit_log.support_grant_ref", { reason: e.supportReason ?? "—" })}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Query> }) {
  const raw = await searchParams;
  return withActor(t("audit_log.page.title"), "/nhat-ky", async (actor) => {
    if (!VIEW_ROLES.includes(actor.role))
      return (
        <ErrorState title={t("audit_log.error.forbidden_title")} text={t("audit_log.error.forbidden_text")} />
      );
    const db = serverContext().db;
    const today = new Date().toISOString().slice(0, 10);
    // Bộ lọc từ URL: chỉ nhận dạng hợp lệ (sai ⇒ bỏ qua, về mặc định) — server vẫn kiểm lại.
    const to = raw.to && DATE.test(raw.to) ? raw.to : today;
    const from = raw.from && DATE.test(raw.from) && raw.from <= to ? raw.from : addDays(to, -DEFAULT_DAYS);
    const q: Query = {
      from,
      to,
      ...(raw.actor && UUID.test(raw.actor) ? { actor: raw.actor } : {}),
      ...(raw.action && ACTION.test(raw.action) ? { action: raw.action } : {}),
      ...(raw.source && (AUDIT_ACTOR_TYPES as readonly string[]).includes(raw.source)
        ? { source: raw.source }
        : {}),
    };
    const fromAt = `${from}T00:00:00.000Z`;
    const toAt = `${addDays(to, 1)}T00:00:00.000Z`;
    const isOwner = actor.role === "owner";
    const [events, actions, actors, grants, exportsMine] = await Promise.all([
      safe(
        listAuditEvents(db, actor, {
          from: new Date(fromAt),
          to: new Date(toAt),
          ...(q.actor ? { actorPersonId: q.actor } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.source ? { actorType: q.source as (typeof AUDIT_ACTOR_TYPES)[number] } : {}),
          ...(raw.cursor ? { cursor: raw.cursor } : {}),
          limit: 50,
        }),
      ),
      safe(listAuditActions(db, actor)),
      safe(listAuditActors(db, actor)),
      safe(listSupportGrants(db, actor)),
      isOwner ? safe(listMyExports(db, actor)) : Promise.resolve(null),
    ]);
    if (!events.ok) return <ErrorState title={t("audit_log.error.load")} text={events.message} />;
    const sourceOptions = [
      { value: "", label: t("audit_log.filter.source_all") },
      ...AUDIT_ACTOR_TYPES.map((s) => ({ value: s, label: tOr(`audit_log.source.${s}`, s) })),
    ];
    const actionOptions = [
      { value: "", label: t("audit_log.filter.action_all") },
      ...(actions.ok ? actions.data : []).map((a) => ({ value: a, label: `${actionLabel(a)} (${a})` })),
    ];
    const actorOptions = [
      { value: "", label: t("audit_log.filter.actor_all") },
      ...(actors.ok ? actors.data : []).map((a) => ({
        value: a.personId,
        label:
          a.actorType === "platform_support"
            ? t("audit_log.filter.actor_support", { name: a.name ?? a.personId })
            : (a.name ?? a.personId),
      })),
    ];
    const auditExports = exportsMine?.ok
      ? exportsMine.data.filter((x) => x.kind === "audit").slice(0, 5)
      : [];
    const exportFilters = {
      from_at: fromAt,
      to_at: toAt,
      ...(q.actor ? { actor_person_id: q.actor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.source ? { actor_type: q.source } : {}),
    };
    return (
      <>
        <section aria-labelledby="filter-h">
          <h2 id="filter-h">{t("audit_log.filter.heading")}</h2>
          <form method="get" action="/nhat-ky" className="command-form" data-testid="audit-filter">
            <TextField name="from" type="date" label={t("audit_log.filter.from")} defaultValue={from} />
            <TextField name="to" type="date" label={t("audit_log.filter.to")} defaultValue={to} />
            <SelectField
              name="actor"
              label={t("audit_log.filter.actor")}
              options={actorOptions}
              defaultValue={q.actor ?? ""}
            />
            <SelectField
              name="action"
              label={t("audit_log.filter.action")}
              options={actionOptions}
              defaultValue={q.action ?? ""}
            />
            <SelectField
              name="source"
              label={t("audit_log.filter.source")}
              options={sourceOptions}
              defaultValue={q.source ?? ""}
            />
            <p className="pager">
              <button type="submit" className="btn">
                {t("audit_log.filter.submit")}
              </button>
              <a className="btn btn--secondary" href="/nhat-ky">
                {t("audit_log.filter.reset")}
              </a>
            </p>
          </form>
        </section>

        <section aria-labelledby="export-h">
          <h2 id="export-h">{t("audit_log.export.heading")}</h2>
          {isOwner ? (
            <>
              <p>{t("audit_log.export.hint")}</p>
              <CommandForm
                path="exports/request"
                fixed={{ kind: "audit", format: "csv", filters: exportFilters }}
                submitLabel={t("audit_log.export.submit")}
                successText={t("audit_log.export.success")}
                testId="audit-export"
              />
              {auditExports.length > 0 ? (
                <ul className="choice-list" data-testid="audit-exports">
                  {auditExports.map((x) => (
                    <li key={x.exportId}>
                      {utc(new Date(x.createdAt))} · {tOr(`audit_log.export.status.${x.status}`, x.status)}
                      {x.status === "ready" ? (
                        // Tải bản xuất đã sẵn sàng (T-2313): `exports.download` trả URL ký ngắn hạn (≤ 5 phút) cho chính người yêu
                        // cầu — liên kết tải hiện sau khi lệnh thành công; hết hạn ⇒ bấm lại để lấy URL mới.
                        <CommandForm
                          path="exports/download"
                          fixed={{ export_id: x.exportId }}
                          variant="secondary"
                          submitLabel={t("audit_log.download.prepare")}
                          successText={t("audit_log.download.ready")}
                          resultLink={{
                            label: t("audit_log.download.link"),
                            testId: "audit-export-download",
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p>{t("audit_log.export.owner_only")}</p>
          )}
        </section>

        <section aria-labelledby="events-h">
          <h2 id="events-h">{t("audit_log.events.heading")}</h2>
          {events.data.items.length === 0 ? (
            <EmptyState title={t("audit_log.events.empty_title")} text={t("audit_log.events.empty_text")} />
          ) : (
            <ul className="card-list audit-list" data-testid="audit-events">
              {events.data.items.map((e) => (
                <EventItem key={e.id} e={e} />
              ))}
            </ul>
          )}
          <nav aria-label={t("audit_log.events.pager")} className="pager">
            {raw.cursor ? (
              <a className="btn btn--secondary" href={safeUrl(hrefWith(q, {})) ?? "/nhat-ky"}>
                {t("audit_log.events.first_page")}
              </a>
            ) : null}
            {events.data.nextCursor ? (
              <a
                className="btn"
                href={safeUrl(hrefWith(q, { cursor: events.data.nextCursor })) ?? "/nhat-ky"}
                data-testid="audit-next"
              >
                {t("audit_log.events.next_page")}
              </a>
            ) : null}
          </nav>
        </section>

        <section aria-labelledby="support-h" data-testid="support-access">
          <h2 id="support-h">{t("audit_log.support.heading")}</h2>
          <p>{t("audit_log.support.intro", { max: SUPPORT_GRANT_MAX_HOURS })}</p>
          {isOwner ? (
            <CommandForm
              path="support/grantAccess"
              fields={[
                {
                  name: "email",
                  label: t("audit_log.support.email"),
                  required: true,
                  maxLength: 320,
                  hint: t("audit_log.support.email_hint"),
                },
                {
                  name: "hours",
                  label: t("audit_log.support.hours", { max: SUPPORT_GRANT_MAX_HOURS }),
                  type: "integer",
                  required: true,
                  defaultValue: 24,
                },
                { name: "reason", label: t("audit_log.support.reason"), required: true, maxLength: 500 },
              ]}
              submitLabel={t("audit_log.support.grant_submit")}
              successText={t("audit_log.support.grant_success")}
              testId="support-grant-form"
            />
          ) : null}
          {!grants.ok ? (
            <ErrorState title={t("audit_log.support.error_load")} text={grants.message} />
          ) : grants.data.length === 0 ? (
            <EmptyState title={t("audit_log.support.empty")} />
          ) : (
            <ul className="member-list" data-testid="support-grants">
              {grants.data.map((g) => (
                <li
                  key={g.grantId}
                  className="member-list__item"
                  data-testid="support-grant"
                  data-status={g.status}
                >
                  <h3>{g.granteeName ?? g.granteeEmail ?? "—"}</h3>
                  <StatusBadge
                    status={g.status}
                    label={tOr(`audit_log.support.status.${g.status}`, g.status)}
                  />
                  <p>
                    {t("audit_log.support.meta", {
                      reason: g.reason,
                      by: g.grantedByName ?? "—",
                      granted: utc(new Date(g.grantedAt)),
                      expires: utc(new Date(g.expiresAt)),
                    })}
                    {g.revokedAt
                      ? ` ${t("audit_log.support.revoked_meta", { at: utc(new Date(g.revokedAt)), by: g.revokedByName ?? "—" })}`
                      : ""}
                  </p>
                  {isOwner && g.status === "active" ? (
                    <CommandForm
                      path="support/revokeAccess"
                      fixed={{ grant_id: g.grantId }}
                      submitLabel={t("audit_log.support.revoke_submit", {
                        name: g.granteeName ?? g.granteeEmail ?? "",
                      })}
                      successText={t("audit_log.support.revoke_success")}
                      variant="secondary"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  });
}
