import type { Metadata } from "next";
import { InstallApp } from "../../components/pwa/install-app.tsx";
import { LogoutButton } from "../../components/pwa/logout-button.tsx";
import { MoreLinks } from "../../components/rental/app-nav.tsx";
import { moreLinks } from "../../components/rental/nav-items.ts";
import { EmptyState } from "../../components/ui/state.tsx";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Thêm — Hotel Manager" };

// Điểm vào thứ 5 của thanh điều hướng (SPEC-pwa S-014): các màn còn lại, cài ứng dụng (S-002/S-003), đăng xuất (S-007).
export default async function MorePage() {
  return withActor("Thêm", "/them", async (actor, { kinds }) => (
    <>
      <section aria-labelledby="man-khac" className="panel">
        <h2 id="man-khac">Màn khác</h2>
        {moreLinks(actor.role, kinds).length === 0 ? (
          <EmptyState title="Không có màn nào khác cho vai trò của bạn" />
        ) : (
          <MoreLinks role={actor.role} kinds={kinds} />
        )}
      </section>
      <InstallApp />
      <section aria-labelledby="tai-khoan" className="panel">
        <h2 id="tai-khoan">Tài khoản</h2>
        <LogoutButton />
      </section>
    </>
  ));
}
