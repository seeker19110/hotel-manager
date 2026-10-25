// Khung trang cần đăng nhập + tổ chức: chuyển hướng khi chưa đủ điều kiện; vai trò bắt buộc MFA chưa bật ⇒ thông báo.
import {
  type Actor,
  listMyNotifications,
  opsProperties,
  orgDeletionStatus,
  requestClient,
  serverContext,
  supportPageAccess,
} from "@hm/app";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CommandForm } from "../components/command/command-form.tsx";
import { ORG_CONTEXT_META } from "../components/command/org-context.ts";
import { AppNav, type NavKinds } from "../components/rental/app-nav.tsx";
import { ErrorState } from "../components/ui/state.tsx";
import { DEFAULT_TIME_ZONE, dateInZone } from "./format.ts";
import { t } from "./i18n.ts";
import { safe } from "./safe.ts";
import { currentActor } from "./session.ts";

export async function withActor(
  title: string,
  current: string,
  render: (actor: Actor, ctx: { kinds: NavKinds }) => Promise<ReactNode>,
): Promise<ReactNode> {
  const r = await currentActor();
  if (r.kind === "login") redirect("/dang-nhap");
  if (r.kind === "choose-org") redirect("/chon-to-chuc");
  if (r.kind === "mfa-required") {
    return (
      <main id="main" className="page">
        <h1>{title}</h1>
        <ErrorState
          title={t("page_shell.mfa_required.title")}
          text={t("page_shell.mfa_required.text")}
          action={
            <a className="btn" href="/bao-mat">
              {t("page_shell.mfa_required.action")}
            </a>
          }
        />
      </main>
    );
  }
  // Người thuê chỉ có portal (SPEC-portal S-005); quyền thật vẫn kiểm ở server mỗi lần gọi.
  if (r.actor.role === "tenant") redirect("/portal");
  // Hỗ trợ nền tảng (D-122/D-126, TM-12): trang SSR đọc bằng hàm đọc thẳng (không qua runQuery) ⇒ chặn ở khung — chỉ trang trong
  // SUPPORT_PAGES, mỗi lần render ghi `support.accessed` TRƯỚC khi đọc; lỗi ghi ⇒ không render dữ liệu (fail-closed).
  if (r.actor.role === "platform_support") {
    const h = await headers();
    let gate: "not_support" | "forbidden" | "allowed" | "audit_failed";
    try {
      gate = await supportPageAccess(serverContext().db, r.actor, {
        page: current,
        client: requestClient(h),
        correlationId: h.get("x-request-id") ?? undefined,
      });
    } catch {
      gate = "audit_failed";
    }
    if (gate !== "allowed")
      return (
        <main id="main" className="page" data-testid="support-forbidden">
          <h1>{title}</h1>
          <ErrorState
            title={t("page_shell.support_forbidden.title")}
            text={
              gate === "audit_failed"
                ? t("page_shell.support_audit_failed.text")
                : t("page_shell.support_forbidden.text")
            }
            action={
              <a className="btn" href="/lich-phong">
                {t("page_shell.support_forbidden.action")}
              </a>
            }
          />
        </main>
      );
  }
  // Thanh điều hướng theo loại cơ sở trong phạm vi + chuông thông báo (số chưa đọc). Lỗi đọc → mặc định hiện đủ, chuông 0.
  const db = serverContext().db;
  const [props, inbox, deletion] = await Promise.all([
    safe(opsProperties(db, r.actor)),
    safe(listMyNotifications(db, r.actor, { limit: 1 })),
    safe(orgDeletionStatus(db, r.actor)),
  ]);
  const templates = props.ok ? props.data.map((p) => p.template) : [];
  const kinds =
    templates.length > 0
      ? {
          hotel: templates.some((x) => x === "hotel" || x === "mixed"),
          rental: templates.some((x) => x === "rental" || x === "mixed"),
        }
      : { hotel: true, rental: true };
  return (
    <>
      <meta name={ORG_CONTEXT_META} content={r.actor.orgId} />
      <AppNav
        current={current}
        role={r.actor.role}
        kinds={kinds}
        unread={inbox.ok ? inbox.data.unreadCount : 0}
        propertyNames={props.ok ? props.data.map((p) => p.name) : []}
      />
      <main id="main" className="page">
        {deletion.ok && deletion.data.state === "pending" && deletion.data.dueAt ? (
          <OrgDeletionBanner dueAt={deletion.data.dueAt} owner={r.actor.role === "owner"} />
        ) : null}
        <h1>{title}</h1>
        {await render(r.actor, { kinds })}
      </main>
    </>
  );
}

/**
 * Banner chờ xoá trên MỌI trang của tổ chức (T-2312, D-121; UX-CONTENT-005): ngày purge + nút huỷ MỘT bước cho owner (không hộp xác
 * nhận, không gõ lại gì). Vai trò khác chỉ thấy thông báo và ai huỷ được.
 */
function OrgDeletionBanner({ dueAt, owner }: { dueAt: Date; owner: boolean }) {
  const date = dateInZone(new Date(dueAt), DEFAULT_TIME_ZONE);
  return (
    <section aria-labelledby="org-deletion-banner" className="panel" data-testid="org-deletion-banner">
      <h2 id="org-deletion-banner">{t("org_banner.heading")}</h2>
      <p>{t("org_banner.text", { date })}</p>
      {owner ? (
        <CommandForm
          path="org/cancelDeletion"
          submitLabel={t("org_banner.cancel")}
          successText={t("org_banner.cancelled")}
          testId="org-deletion-cancel"
        />
      ) : (
        <p>{t("org_banner.owner_hint")}</p>
      )}
    </section>
  );
}
