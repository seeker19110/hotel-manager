import { listMyOrganizations, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "../../components/ui/state.tsx";
import { ORG_PICKER_ROLE_LABEL } from "../../lib/roles.ts";
import { currentSession } from "../../lib/session.ts";
import { CreateOrganization } from "./create-organization.tsx";
import { OrgChoice } from "./org-choice.tsx";

export const metadata: Metadata = { title: "Chọn tổ chức — Hotel Manager" };

// SPEC-access-and-property S-020: chọn ngữ cảnh trong số tổ chức có membership.
export default async function ChooseOrganizationPage() {
  const session = await currentSession();
  if (!session) redirect("/dang-nhap");
  const orgs = await listMyOrganizations(serverContext().db, session.user.id);
  return (
    <main id="main" className="page">
      <h1>Chọn tổ chức</h1>
      {orgs.length === 0 ? (
        <>
          <EmptyState
            title="Bạn chưa thuộc tổ chức nào"
            text="Tạo tổ chức của bạn bên dưới, hoặc nhờ chủ cơ sở gửi lời mời vào tổ chức của họ."
          />
          <h2>Tạo tổ chức mới</h2>
          <CreateOrganization />
        </>
      ) : (
        <ul className="choice-list">
          {orgs.map((o) => (
            <li key={o.organizationId}>
              <OrgChoice
                organizationId={o.organizationId}
                label={o.organizationName}
                meta={ORG_PICKER_ROLE_LABEL[o.role] ?? o.role}
                home={o.role === "tenant" ? "/portal" : "/phong"}
              />
            </li>
          ))}
        </ul>
      )}
      {orgs.length > 0 && orgs.some((o) => o.role !== "tenant") ? (
        <details className="details-box">
          <summary>Tạo tổ chức mới</summary>
          <CreateOrganization />
        </details>
      ) : null}
    </main>
  );
}
