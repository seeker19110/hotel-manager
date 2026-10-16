// Khung trang cần đăng nhập + tổ chức: chuyển hướng khi chưa đủ điều kiện; vai trò bắt buộc MFA chưa bật ⇒ thông báo.
import type { Actor } from "@hm/app";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppNav } from "../components/rental/app-nav.tsx";
import { ErrorState } from "../components/ui/state.tsx";
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
        />
      </main>
    );
  }
  return (
    <>
      <AppNav current={current} />
      <main id="main" className="page">
        <h1>{title}</h1>
        {await render(r.actor)}
      </main>
    </>
  );
}
