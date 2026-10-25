import { consentHistory, consentOverview, type PurposeStatus, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConsentToggle } from "../../components/privacy/consent-toggle.tsx";
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
  const [purposes, history] = await Promise.all([consentOverview(db, userId), consentHistory(db, userId)]);
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
    </main>
  );
}
