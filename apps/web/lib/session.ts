// Phiên + ngữ cảnh tổ chức cho Server Component / Route Handler. Quyền luôn tra lại membership (resolveActor).
import { AccessError, type Actor, orgCookieName, resolveActor, serverContext } from "@hm/app";
import { cookies, headers } from "next/headers";

export async function currentSession() {
  const { auth } = serverContext();
  return auth.api.getSession({ headers: await headers() });
}

export type ActorResult =
  | { kind: "ok"; actor: Actor }
  | { kind: "login" }
  | { kind: "choose-org" }
  | { kind: "mfa-required" }
  | { kind: "org-pending-deletion" };

/** Actor của request trang: chưa đăng nhập → login; chưa chọn/không còn thuộc tổ chức → chọn lại. */
export async function currentActor(opts: { allowPendingDeletion?: boolean } = {}): Promise<ActorResult> {
  const session = await currentSession();
  if (!session) return { kind: "login" };
  const secure = serverContext().config.APP_BASE_URL.startsWith("https://");
  const orgId = (await cookies()).get(orgCookieName(secure))?.value;
  if (!orgId) return { kind: "choose-org" };
  try {
    const actor = await resolveActor(serverContext().db, {
      authUserId: session.user.id,
      orgId,
      twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
      authenticatedAt: new Date(session.session.createdAt),
      ...(opts.allowPendingDeletion ? { allowPendingDeletion: true } : {}),
    });
    return { kind: "ok", actor };
  } catch (e) {
    if (e instanceof AccessError) {
      if (e.code === "MFA_REQUIRED") return { kind: "mfa-required" };
      if (e.code === "UNAUTHENTICATED") return { kind: "login" };
      // Tổ chức chờ xoá (T-2312, D-125): mọi trang khác chuyển về trang Tổ chức (biểu ngữ + huỷ + xuất).
      if (e.code === "ORG_PENDING_DELETION") return { kind: "org-pending-deletion" };
      return { kind: "choose-org" };
    }
    throw e;
  }
}
