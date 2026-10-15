import { listMyOrganizations, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "../../components/ui/state.tsx";
import { currentSession } from "../../lib/session.ts";
import { OrgChoice } from "./org-choice.tsx";

export const metadata: Metadata = { title: "Chọn tổ chức — Hotel Manager" };

const ROLE_LABEL: Record<string, string> = {
  owner: "Chủ",
  manager: "Quản lý",
  front_desk: "Lễ tân",
  accountant: "Kế toán",
  housekeeping: "Buồng phòng",
  maintenance: "Kỹ thuật",
  tenant: "Người thuê",
};

// SPEC-access-and-property S-020: chọn ngữ cảnh trong số tổ chức có membership.
export default async function ChooseOrganizationPage() {
  const session = await currentSession();
  if (!session) redirect("/dang-nhap");
  const orgs = await listMyOrganizations(serverContext().db, session.user.id);
  return (
    <main id="main" className="page">
      <h1>Chọn tổ chức</h1>
      {orgs.length === 0 ? (
        <EmptyState title="Bạn chưa thuộc tổ chức nào" text="Liên hệ chủ cơ sở để được mời vào tổ chức." />
      ) : (
        <ul className="choice-list">
          {orgs.map((o) => (
            <li key={o.organizationId}>
              <OrgChoice
                organizationId={o.organizationId}
                label={o.organizationName}
                meta={ROLE_LABEL[o.role] ?? o.role}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
