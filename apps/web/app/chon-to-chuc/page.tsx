import { listMyOrganizations, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "../../components/ui/state.tsx";
import { messagesFor, t } from "../../lib/i18n.ts";
import { ORG_PICKER_ROLE_LABEL } from "../../lib/roles.ts";
import { currentSession } from "../../lib/session.ts";
import { CreateOrganization } from "./create-organization.tsx";
import { OrgChoice } from "./org-choice.tsx";

export const metadata: Metadata = { title: t("org_picker.metadata.title") };

// SPEC-access-and-property S-020: chọn ngữ cảnh trong số tổ chức có membership.
export default async function ChooseOrganizationPage() {
  const session = await currentSession();
  if (!session) redirect("/dang-nhap");
  const orgs = await listMyOrganizations(serverContext().db, session.user.id);
  return (
    <main id="main" className="page">
      <h1>{t("org_picker.page.title")}</h1>
      {orgs.length === 0 ? (
        <>
          <EmptyState title={t("org_picker.empty.title")} text={t("org_picker.empty.text")} />
          <h2>{t("org_picker.create.heading")}</h2>
          <CreateOrganization m={messagesFor("org_create.")} />
        </>
      ) : (
        <ul className="choice-list">
          {orgs.map((o) => (
            <li key={o.organizationId}>
              <OrgChoice
                organizationId={o.organizationId}
                label={o.organizationName}
                meta={ORG_PICKER_ROLE_LABEL[o.role] ?? o.role}
                m={messagesFor("org_choice.")}
                home={o.role === "tenant" ? "/portal" : "/phong"}
              />
            </li>
          ))}
        </ul>
      )}
      {orgs.length > 0 && orgs.some((o) => o.role !== "tenant") ? (
        <details className="details-box">
          <summary>{t("org_picker.create.heading")}</summary>
          <CreateOrganization m={messagesFor("org_create.")} />
        </details>
      ) : null}
    </main>
  );
}
