// Khung trang cần đăng nhập + tổ chức: chuyển hướng khi chưa đủ điều kiện; vai trò bắt buộc MFA chưa bật ⇒ thông báo.
import { type Actor, listMyNotifications, opsProperties, serverContext } from "@hm/app";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ORG_CONTEXT_META } from "../components/command/org-context.ts";
import { AppNav } from "../components/rental/app-nav.tsx";
import { ErrorState } from "../components/ui/state.tsx";
import { safe } from "./safe.ts";
import { currentActor } from "./session.ts";

export async function withActor(
  title: string,
  current: string,
  render: (actor: Actor) => Promise<ReactNode>,
): Promise<ReactNode> {
  const r = await currentActor();
  if (r.kind === "login") redirect("/dang-nhap");
  if (r.kind === "choose-org") redirect("/chon-to-chuc");
  if (r.kind === "mfa-required") {
    return (
      <main id="main" className="page">
        <h1>{title}</h1>
        <ErrorState
          title="Cần bật xác thực hai lớp"
          text="Vai trò của bạn có quyền về tiền hoặc quản trị. Hãy bật xác thực hai lớp trước khi thao tác."
          action={
            <a className="btn" href="/bao-mat">
              Bật xác thực hai lớp
            </a>
          }
        />
      </main>
    );
  }
  // Người thuê chỉ có portal (SPEC-portal S-005); quyền thật vẫn kiểm ở server mỗi lần gọi.
  if (r.actor.role === "tenant") redirect("/portal");
  // Thanh điều hướng theo loại cơ sở trong phạm vi + chuông thông báo (số chưa đọc). Lỗi đọc → mặc định hiện đủ, chuông 0.
  const db = serverContext().db;
  const [props, inbox] = await Promise.all([
    safe(opsProperties(db, r.actor)),
    safe(listMyNotifications(db, r.actor, { limit: 1 })),
  ]);
  const templates = props.ok ? props.data.map((p) => p.template) : [];
  const kinds =
    templates.length > 0
      ? {
          hotel: templates.some((t) => t === "hotel" || t === "mixed"),
          rental: templates.some((t) => t === "rental" || t === "mixed"),
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
      />
      <main id="main" className="page">
        <h1>{title}</h1>
        {await render(r.actor)}
      </main>
    </>
  );
}
