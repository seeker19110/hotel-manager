import {
  accountHasPassword,
  listAuditEvents,
  listMembers,
  listMyExports,
  listSupportAccess,
  SUPPORT_TTL_DEFAULT_HOURS,
  SUPPORT_TTL_MAX_HOURS,
  serverContext,
} from "@hm/app";
import type { Metadata } from "next";
import { CommandForm, type FieldSpec } from "../../components/command/command-form.tsx";
import { DownloadOrgExport } from "../../components/tenancy/org-deletion.tsx";
import { SelectField, TextField } from "../../components/ui/field.tsx";
import { EmptyState, ErrorState } from "../../components/ui/state.tsx";
import { addDays, DEFAULT_TIME_ZONE, dateTime, isoDateIn } from "../../lib/format.ts";
import { messagesFor, t, tOr } from "../../lib/i18n.ts";
import { withActor } from "../../lib/page.tsx";
import { safe } from "../../lib/safe.ts";

export const metadata: Metadata = { title: t("audit_log.metadata.title") };

// Nhật ký hoạt động cho admin tổ chức (PLAN T-2313; IND-SAAS-009, CMP-AUDIT-002; D-128). Owner + manager (vai khác: thông báo không
// có quyền như màn Thành viên; dòng thấy được do RLS 0042 + `audit.listEvents` quyết). Lọc theo khoảng ngày (giờ Việt Nam), người,
// loại hành động, loại đối tượng; phân trang keyset (`cursor`, không OFFSET). Chỉ hiện trường cần cho kiểm soát: thời điểm, người,
// hành động (nhãn i18n), đối tượng (loại + mã rút gọn), kết quả, lý do, IP đã cắt /24 — không hiện trước/sau (dữ liệu nghiệp vụ) hay
// User-Agent đầy đủ. Owner: xuất CSV qua `exports.request` (kind `audit`, cùng bộ lọc) và quản lý truy cập hỗ trợ (cấp/thu hồi).

/** Hành động có nhãn riêng (còn lại hiện mã gốc). */
const ACTIONS = [
  "auth.login",
  "auth.logout",
  "auth.mfa_enabled",
  "auth.mfa_disabled",
  "auth.password_changed",
  "auth.account_locked",
  "member.invited",
  "member.accepted",
  "member.role_changed",
  "member.scope_changed",
  "member.mfa_reset",
  "member.invite_denied",
  "session.revoked",
  "property.created",
  "property.updated",
  "organization.created",
  "organization.deletion_requested",
  "organization.deletion_cancelled",
  "export.requested",
  "export.downloaded",
  "support.access_granted",
  "support.access_revoked",
  "support.accessed",
  "command.denied",
] as const;
const ENTITY_TYPES = [
  "membership",
  "invitation",
  "property",
  "organization",
  "export_job",
  "page",
  "query",
] as const;

const actionLabel = (a: string) => tOr(`audit_log.action.${a}`, a);
const entityLabel = (e: string) => tOr(`audit_log.entity.${e}`, e);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z_]+(\.[a-z_]+)*$/;
const SUPPORT_ACTOR = "platform_support";

type Query = {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  entity_type?: string;
  cursor?: string;
};

/** Ngày lịch Việt Nam → mốc UTC đầu ngày (UTC+7 cố định, không DST). */
const vnStart = (d: string) => new Date(`${d}T00:00:00+07:00`);
const vnToday = () => isoDateIn(new Date(), DEFAULT_TIME_ZONE);

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Query> }) {
  const q = await searchParams;
  return withActor(t("audit_log.page.title"), "/nhat-ky", async (actor) => {
    if (actor.role !== "owner" && actor.role !== "manager")
      return (
        <ErrorState title={t("audit_log.error.forbidden_title")} text={t("audit_log.error.forbidden_text")} />
      );
    const db = serverContext().db;
    const owner = actor.role === "owner";
    const today = vnToday();
    const from = q.from && DATE.test(q.from) ? q.from : addDays(today, -6);
    const to = q.to && DATE.test(q.to) ? q.to : today;
    const who = q.actor && (UUID.test(q.actor) || q.actor === SUPPORT_ACTOR) ? q.actor : "";
    const action = q.action && KEY.test(q.action) ? q.action : "";
    const entityType = q.entity_type && KEY.test(q.entity_type) ? q.entity_type : "";
    // D-129: cấp truy cập hỗ trợ cần xác thực lại — owner có mật khẩu nhập ở form; không có mật khẩu thì dựa vào phiên mới (≤ 5 phút).
    const [hasPassword, events, members, support, exports] = await Promise.all([
      owner ? accountHasPassword(db, actor.authUserId) : Promise.resolve(false),
      safe(
        listAuditEvents(db, actor, {
          from: vnStart(from),
          to: vnStart(addDays(to, 1)),
          ...(who === SUPPORT_ACTOR ? { actorType: SUPPORT_ACTOR } : who ? { actorPersonId: who } : {}),
          ...(action ? { action } : {}),
          ...(entityType ? { entityType } : {}),
          ...(q.cursor ? { cursor: q.cursor } : {}),
          limit: 50,
        }),
      ),
      safe(listMembers(db, actor)),
      owner ? safe(listSupportAccess(db, actor)) : Promise.resolve(null),
      owner ? safe(listMyExports(db, actor)) : Promise.resolve(null),
    ]);
    const filterQuery = new URLSearchParams({
      from,
      to,
      ...(who ? { actor: who } : {}),
      ...(action ? { action } : {}),
      ...(entityType ? { entity_type: entityType } : {}),
    });
    const people = members.ok ? members.data.members : [];
    const supportFields: FieldSpec[] = [
      { name: "email", label: t("audit_log.support.email"), required: true, maxLength: 320 },
      {
        name: "reason",
        label: t("audit_log.support.reason"),
        required: true,
        maxLength: 500,
        hint: t("audit_log.support.reason_hint"),
      },
      {
        name: "ttl_hours",
        label: t("audit_log.support.ttl"),
        type: "integer",
        required: true,
        defaultValue: SUPPORT_TTL_DEFAULT_HOURS,
        hint: t("audit_log.support.ttl_hint", { max: SUPPORT_TTL_MAX_HOURS }),
      },
      ...(hasPassword
        ? [
            {
              name: "password",
              label: t("audit_log.support.password"),
              type: "password" as const,
              required: true,
              maxLength: 256,
              hint: t("audit_log.support.password_hint"),
            },
          ]
        : []),
    ];
    const auditExports = exports?.ok ? exports.data.filter((e) => e.kind === "audit").slice(0, 5) : [];
    return (
      <>
        <section aria-labelledby="loc-nhat-ky" className="panel">
          <h2 id="loc-nhat-ky">{t("audit_log.filter.title")}</h2>
          <form method="get" action="/nhat-ky" data-testid="audit-filter">
            <TextField label={t("audit_log.filter.from")} type="date" name="from" defaultValue={from} />
            <TextField label={t("audit_log.filter.to")} type="date" name="to" defaultValue={to} />
            <SelectField
              label={t("audit_log.filter.actor")}
              name="actor"
              defaultValue={who}
              options={[
                { value: "", label: t("audit_log.filter.any") },
                ...people.map((p) => ({ value: p.personId, label: p.fullName })),
                { value: SUPPORT_ACTOR, label: t("audit_log.filter.support_actor") },
              ]}
            />
            <SelectField
              label={t("audit_log.filter.action")}
              name="action"
              defaultValue={action}
              options={[
                { value: "", label: t("audit_log.filter.any") },
                ...ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })),
              ]}
            />
            <SelectField
              label={t("audit_log.filter.entity")}
              name="entity_type"
              defaultValue={entityType}
              options={[
                { value: "", label: t("audit_log.filter.any") },
                ...ENTITY_TYPES.map((e) => ({ value: e, label: entityLabel(e) })),
              ]}
            />
            <button type="submit" className="btn btn--secondary">
              {t("audit_log.filter.submit")}
            </button>
          </form>
        </section>

        <section aria-labelledby="su-kien" className="panel">
          <h2 id="su-kien">{t("audit_log.list.title")}</h2>
          {!events.ok ? (
            <ErrorState title={t("audit_log.error.load")} text={events.message} />
          ) : events.data.items.length === 0 ? (
            <EmptyState title={t("audit_log.list.empty")} />
          ) : (
            <>
              <ul className="card-list" data-testid="audit-events">
                {events.data.items.map((e) => (
                  <li key={e.id} className="card" data-testid="audit-event" data-action={e.action}>
                    <p>
                      <strong>{actionLabel(e.action)}</strong>
                      {e.outcome === "denied" ? ` · ${t("audit_log.list.denied")}` : ""}
                    </p>
                    <p>
                      {t("audit_log.list.meta", {
                        when: e.occurredAtLocal,
                        who:
                          e.actorType === SUPPORT_ACTOR
                            ? t("audit_log.list.support_actor", { name: e.actorName ?? "" })
                            : (e.actorName ?? t("audit_log.list.system_actor")),
                      })}
                    </p>
                    <p>
                      {t("audit_log.list.target", {
                        type: entityLabel(e.entityType),
                        id: e.entityId ? e.entityId.slice(0, 8) : "—",
                      })}
                      {e.sourceIp ? ` · ${t("audit_log.list.ip", { ip: e.sourceIp })}` : ""}
                    </p>
                    {e.reason ? <p>{t("audit_log.list.reason", { reason: e.reason })}</p> : null}
                  </li>
                ))}
              </ul>
              {events.data.nextCursor ? (
                <p>
                  <a
                    className="btn btn--secondary"
                    href={`/nhat-ky?${new URLSearchParams({ ...Object.fromEntries(filterQuery), cursor: events.data.nextCursor })}`}
                    data-testid="audit-next"
                  >
                    {t("audit_log.list.next")}
                  </a>
                </p>
              ) : null}
            </>
          )}
        </section>

        {owner ? (
          <section aria-labelledby="xuat-nhat-ky" className="panel">
            <h2 id="xuat-nhat-ky">{t("audit_log.export.title")}</h2>
            <p>{t("audit_log.export.text", { from, to })}</p>
            <CommandForm
              path="exports/request"
              fixed={{
                kind: "audit",
                format: "csv",
                filters: {
                  from,
                  to,
                  ...(who && who !== SUPPORT_ACTOR ? { actor_person_id: who } : {}),
                  ...(action ? { action } : {}),
                  ...(entityType ? { entity_type: entityType } : {}),
                },
              }}
              submitLabel={t("audit_log.export.request")}
              successText={t("audit_log.export.requested")}
              variant="secondary"
              testId="audit-export"
            />
            {auditExports.length > 0 ? (
              <ul className="card-list" data-testid="audit-export-list">
                {auditExports.map((e) => (
                  <li key={e.exportId} className="card">
                    <p>
                      {t("audit_log.export.item", {
                        when: dateTime(e.createdAt, DEFAULT_TIME_ZONE),
                        status: tOr(`org_page.export.status.${e.status}`, e.status),
                      })}
                    </p>
                    {e.status === "ready" ? (
                      <DownloadOrgExport
                        exportId={e.exportId}
                        m={messagesFor("org_deletion.", "tenant_login_form.", "auth_form.")}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {owner ? (
          <section aria-labelledby="truy-cap-ho-tro" className="panel" data-testid="support-access">
            <h2 id="truy-cap-ho-tro">{t("audit_log.support.title")}</h2>
            <p>{t("audit_log.support.text", { max: SUPPORT_TTL_MAX_HOURS })}</p>
            {support?.ok && support.data.length > 0 ? (
              <ul className="card-list" data-testid="support-list">
                {support.data.map((s) => (
                  <li key={s.invitationId} className="card">
                    <p>
                      {s.state === "active"
                        ? t("audit_log.support.active", {
                            who: s.name ?? s.email ?? "",
                            until: dateTime(s.until, DEFAULT_TIME_ZONE),
                          })
                        : t("audit_log.support.pending", {
                            who: s.email ?? "",
                            until: dateTime(s.until, DEFAULT_TIME_ZONE),
                          })}
                    </p>
                    {s.reason ? <p>{t("audit_log.list.reason", { reason: s.reason })}</p> : null}
                    <CommandForm
                      path="member/revokeSupportAccess"
                      fixed={{ invitation_id: s.invitationId }}
                      submitLabel={t("support_banner.revoke")}
                      successText={t("support_banner.revoked")}
                      variant="secondary"
                      testId="support-revoke-item"
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("audit_log.support.none")}</p>
            )}
            <CommandForm
              path="member/grantSupportAccess"
              fields={supportFields}
              submitLabel={t("audit_log.support.grant")}
              successText={t("audit_log.support.granted")}
              testId="support-grant"
            />
          </section>
        ) : null}
      </>
    );
  });
}
