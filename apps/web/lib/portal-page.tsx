// Khung trang portal người thuê (SPEC-portal S-005, S-012, S-015): chỉ vai trò `tenant`; tiêu đề luôn hiện "Tổ chức · Người thuê".
// Quyền thật ở server (hàm portal.* chỉ cho tenant + RLS) — khung này chỉ điều hướng.

import { type Actor, listMyOrganizations, serverContext } from "@hm/app";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ORG_CONTEXT_META } from "../components/command/org-context.ts";
import { PortalNav } from "../components/portal/portal-nav.tsx";
import { ErrorState } from "../components/ui/state.tsx";
import { t } from "./i18n.ts";
import { currentActor, currentSession } from "./session.ts";

export const PORTAL_LOGIN = "/dang-nhap/nguoi-thue";

export async function withPortal(
  title: string,
  current: string,
  render: (ctx: { actor: Actor; orgName: string }) => Promise<ReactNode>,
): Promise<ReactNode> {
  const r = await currentActor();
  if (r.kind === "login") redirect(PORTAL_LOGIN);
  if (r.kind === "mfa-required") redirect("/phong");
  // Tổ chức chờ xoá (T-2312): người thuê cũng bị khoá — trang Tổ chức nêu trạng thái.
  if (r.kind === "org-pending-deletion") redirect("/to-chuc");
  if (r.kind === "choose-org") {
    const session = await currentSession();
    const orgs = session ? await listMyOrganizations(serverContext().db, session.user.id) : [];
    if (orgs.length > 0) redirect("/chon-to-chuc");
    // S-015: quyền đã bị thu hồi/hết hạn xem lại — không hiển thị dữ liệu nào.
    return (
      <main id="main" className="page">
        <h1>{t("portal.revoked.heading")}</h1>
        <ErrorState
          title={t("portal.revoked.title")}
          text={t("portal.revoked.text")}
          action={
            <a className="btn" href={PORTAL_LOGIN}>
              {t("portal.revoked.login")}
            </a>
          }
        />
      </main>
    );
  }
  const { actor } = r;
  if (actor.role !== "tenant") redirect("/phong");
  const orgs = await listMyOrganizations(serverContext().db, actor.authUserId);
  const orgName = orgs.find((o) => o.organizationId === actor.orgId)?.organizationName ?? "";
  return (
    <>
      <meta name={ORG_CONTEXT_META} content={actor.orgId} />
      <PortalNav current={current} />
      <main id="main" className="page">
        <p className="portal-context" data-testid="portal-context">
          {t("portal.context", { org: orgName })}
        </p>
        <h1>{title}</h1>
        {await render({ actor, orgName })}
        {/* T-2310: lựa chọn đồng ý của người thuê — liên kết kín đáo cuối trang, không chặn luồng portal. */}
        <p className="portal-privacy">
          <a className="btn btn--secondary" href="/quyen-rieng-tu?kenh=portal">
            {t("privacy_page.link")}
          </a>
        </p>
      </main>
    </>
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
