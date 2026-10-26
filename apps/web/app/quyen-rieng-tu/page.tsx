import {
  accountHasPassword,
  consentHistory,
  consentOverview,
  DSAR_ACCESS_TTL_HOURS,
  DSAR_DAYS,
  DSAR_DEFAULT_REGION,
  type DsarRequest,
  dsarOverview,
  type PurposeStatus,
  serverContext,
} from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConsentToggle } from "../../components/privacy/consent-toggle.tsx";
import { DataRequestButton } from "../../components/privacy/data-request-button.tsx";
import { DeleteAccount } from "../../components/privacy/delete-account.tsx";
import type { ConsentChannel } from "../../components/privacy/post-consent.ts";
import { EmptyState } from "../../components/ui/state.tsx";
import { DEFAULT_TIME_ZONE, dateTime } from "../../lib/format.ts";
import { messagesFor, t } from "../../lib/i18n.ts";
import { currentSession } from "../../lib/session.ts";

export const metadata: Metadata = { title: t("privacy_page.metadata.title") };

// Quyền riêng tư của CHÍNH tài khoản đang đăng nhập (PLAN T-2310; CMP-RIGHTS-001/004, CMP-VN-001; D-122): mỗi mục đích xử lý kèm
// loại dữ liệu, bên nhận, cơ sở, phiên bản văn bản; mục cần đồng ý có ô bật/tắt + "Lưu lựa chọn" (rút cùng số bước như cho); lịch
// sử lựa chọn + tải về. Không cần ngữ cảnh tổ chức (đồng ý thuộc tài khoản) — nhân viên và người thuê dùng chung. `?kenh=portal`
// chỉ ghi nhận nơi chọn (người thuê vào từ portal); quyền thật ở server (phiên + RLS theo người dùng).
// Mục "Yêu cầu về dữ liệu" (T-2311, D-123): tải bản sao dữ liệu (truy cập), hạn chế xử lý, xoá tài khoản (xác thực lại + xác nhận,
// nêu phần được giữ và căn cứ); hạn trả lời theo vùng lấy từ `DSAR_DAYS` (một nơi), lịch sử yêu cầu.
const when = (d: Date) => dateTime(d, DEFAULT_TIME_ZONE);

function statusText(p: PurposeStatus): string {
  if (p.granted === null) return t("privacy_page.status.not_required");
  if (p.granted && p.last) return t("privacy_page.status.granted", { when: when(p.last.recordedAt) });
  if (p.outdated) return t("privacy_page.status.outdated");
  if (p.last?.action === "withdraw")
    return t("privacy_page.status.withdrawn", { when: when(p.last.recordedAt) });
  return t("privacy_page.status.not_granted");
}

const ACTION = {
  grant: () => t("privacy_page.history.action.grant"),
  withdraw: () => t("privacy_page.history.action.withdraw"),
} as const;
const CHANNEL = {
  signup: () => t("privacy_page.history.channel.signup"),
  invite: () => t("privacy_page.history.channel.invite"),
  portal: () => t("privacy_page.history.channel.portal"),
  settings: () => t("privacy_page.history.channel.settings"),
} as const;

const DSAR_TYPE = {
  access: () => t("privacy_page.dsar.type.access"),
  delete: () => t("privacy_page.dsar.type.delete"),
  restrict: () => t("privacy_page.dsar.type.restrict"),
} as const;
const DSAR_STATUS = {
  received: () => t("privacy_page.dsar.status.received"),
  verified: () => t("privacy_page.dsar.status.verified"),
  processing: () => t("privacy_page.dsar.status.processing"),
  completed: () => t("privacy_page.dsar.status.completed"),
  rejected: () => t("privacy_page.dsar.status.rejected"),
} as const;
const isOpen = (r: DsarRequest) =>
  r.status === "received" || r.status === "verified" || r.status === "processing";

/** Trạng thái yêu cầu truy cập gần nhất (null = chưa từng yêu cầu). */
function accessStatus(r: DsarRequest | undefined, now: Date): string | null {
  if (!r) return null;
  if (isOpen(r)) return t("privacy_page.dsar.access.pending", { due: when(r.dueAt) });
  if (r.status === "completed" && r.resultExpiresAt && r.resultExpiresAt > now)
    return t("privacy_page.dsar.access.ready", { until: when(r.resultExpiresAt) });
  if (r.status === "completed") return t("privacy_page.dsar.access.expired");
  return t("privacy_page.dsar.access.rejected");
}

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const fromPortal = (await searchParams).kenh === "portal";
  const session = await currentSession();
  if (!session) {
    if (fromPortal) redirect("/dang-nhap/nguoi-thue");
    redirect("/dang-nhap");
  }
  const { db } = serverContext();
  const userId = session.user.id;
  const [purposes, history, dsar, hasPassword] = await Promise.all([
    consentOverview(db, userId),
    consentHistory(db, userId),
    dsarOverview(db, userId),
    accountHasPassword(db, userId),
  ]);
  const now = new Date();
  const days = DSAR_DAYS[DSAR_DEFAULT_REGION];
  const latestAccess = dsar.requests.find((r) => r.type === "access");
  const accessText = accessStatus(latestAccess, now);
  const accessReady =
    latestAccess?.status === "completed" && latestAccess.resultExpiresAt && latestAccess.resultExpiresAt > now
      ? latestAccess
      : undefined;
  const openDelete = dsar.requests.find((r) => r.type === "delete" && isOpen(r));
  const dm = messagesFor("data_requests.");
  const deleteM = messagesFor("data_requests.", "tenant_login_form.", "auth_form.");
  const channel: ConsentChannel = fromPortal ? "portal" : "settings";
  const titleOf = (id: string) => purposes.find((p) => p.id === id)?.title ?? id;
  const m = messagesFor("consent_toggle.");

  return (
    <main id="main" className="page">
      <h1>{t("privacy_page.page.title")}</h1>
      <p>{t("privacy_page.intro")}</p>
      <ul className="card-list">
        {purposes.map((p) => (
          <li key={p.id} className="card" data-testid={`purpose-${p.id}`}>
            <h2>{p.title}</h2>
            <p>{p.description}</p>
            <dl className="privacy-facts">
              <dt>{t("privacy_page.fact.data")}</dt>
              <dd>{p.data}</dd>
              <dt>{t("privacy_page.fact.recipients")}</dt>
              <dd>{p.recipients}</dd>
              <dt>{t("privacy_page.fact.basis")}</dt>
              <dd>{p.basis}</dd>
              <dt>{t("privacy_page.fact.version")}</dt>
              <dd>{p.version}</dd>
            </dl>
            <p data-testid={`purpose-status-${p.id}`}>{statusText(p)}</p>
            {p.requiresConsent && p.checkbox ? (
              <ConsentToggle
                purpose={p.id}
                version={p.version}
                label={p.checkbox}
                granted={p.granted === true}
                channel={channel}
                m={m}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <h2>{t("privacy_page.history.title")}</h2>
      {history.length === 0 ? (
        <EmptyState
          title={t("privacy_page.history.empty_title")}
          text={t("privacy_page.history.empty_text")}
        />
      ) : (
        <ol className="privacy-history" data-testid="consent-history">
          {history.map((h) => (
            <li key={h.id}>
              {t("privacy_page.history.item", {
                action: ACTION[h.action](),
                purpose: titleOf(h.purpose),
                when: when(h.recordedAt),
                channel: CHANNEL[h.channel](),
              })}
            </li>
          ))}
        </ol>
      )}
      <p>
        <a className="btn btn--secondary" href="/api/v1/me/consents?download=1" download>
          {t("privacy_page.history.download")}
        </a>
      </p>

      <section aria-labelledby="dsar-title" data-testid="dsar">
        <h2 id="dsar-title">{t("privacy_page.dsar.title")}</h2>
        <p>
          {t("privacy_page.dsar.intro", {
            access: days.access,
            delete: days.delete,
            restrict: days.restrict,
          })}
        </p>
        <ul className="card-list">
          <li className="card" data-testid="dsar-access-card">
            <h3>{t("privacy_page.dsar.access.title")}</h3>
            <p>{t("privacy_page.dsar.access.text", { hours: DSAR_ACCESS_TTL_HOURS })}</p>
            {accessText ? <p data-testid="dsar-access-status">{accessText}</p> : null}
            {accessReady ? (
              <p>
                <a className="btn" href={`/api/v1/me/data-requests/${accessReady.id}/download`}>
                  {t("privacy_page.dsar.access.download")}
                </a>
              </p>
            ) : null}
            {latestAccess && isOpen(latestAccess) ? null : (
              <DataRequestButton type="access" label={t("privacy_page.dsar.access.request")} m={dm} />
            )}
          </li>
          <li className="card" data-testid="dsar-restrict-card">
            <h3>{t("privacy_page.dsar.restrict.title")}</h3>
            <p>{t("privacy_page.dsar.restrict.text")}</p>
            {dsar.restrictedAt ? (
              <p data-testid="dsar-restrict-status">
                {t("privacy_page.dsar.restrict.active", { since: when(dsar.restrictedAt) })}
              </p>
            ) : (
              <DataRequestButton type="restrict" label={t("privacy_page.dsar.restrict.request")} m={dm} />
            )}
          </li>
          <li className="card" data-testid="dsar-delete-card">
            <h3>{t("privacy_page.dsar.delete.title")}</h3>
            <p>{t("privacy_page.dsar.delete.text")}</p>
            <h4>{t("privacy_page.dsar.delete.removed_title")}</h4>
            <ul>
              <li>{t("privacy_page.dsar.delete.removed.account")}</li>
              <li>{t("privacy_page.dsar.delete.removed.sessions")}</li>
              <li>{t("privacy_page.dsar.delete.removed.memberships")}</li>
              <li>{t("privacy_page.dsar.delete.removed.analytics")}</li>
              <li>{t("privacy_page.dsar.delete.removed.files")}</li>
            </ul>
            <h4>{t("privacy_page.dsar.delete.kept_title")}</h4>
            <ul>
              <li>{t("privacy_page.dsar.delete.kept.accounting")}</li>
              <li>{t("privacy_page.dsar.delete.kept.audit")}</li>
              <li>{t("privacy_page.dsar.delete.kept.persons")}</li>
              <li>{t("privacy_page.dsar.delete.kept.evidence")}</li>
            </ul>
            {openDelete ? (
              <p data-testid="dsar-delete-status" role="status">
                {t("privacy_page.dsar.delete.pending", { due: when(openDelete.dueAt) })}
              </p>
            ) : (
              <DeleteAccount hasPassword={hasPassword} m={deleteM} />
            )}
          </li>
        </ul>
        <h3>{t("privacy_page.dsar.history.title")}</h3>
        {dsar.requests.length === 0 ? (
          <p>{t("privacy_page.dsar.history.empty")}</p>
        ) : (
          <ol className="privacy-history" data-testid="dsar-history">
            {dsar.requests.map((r) => (
              <li key={r.id}>
                {t("privacy_page.dsar.history.item", {
                  type: DSAR_TYPE[r.type](),
                  status: DSAR_STATUS[r.status](),
                  requested: when(r.requestedAt),
                  due: when(r.dueAt),
                })}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
