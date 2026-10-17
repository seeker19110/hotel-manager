// Điểm công khai của module `access` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.

export { type AcceptedInvitation, acceptInvitation } from "./accept-invitation.ts";
export { AccessError, type Actor, listMyOrganizations, resolveActor } from "./actor.ts";
export {
  buildInvitationMail,
  INVITATION_TTL_DAYS,
  type InvitationMail,
  invitationKey,
  invitationToken,
  inviteMember,
} from "./invitations.ts";
export { updateMemberRole, updateMemberScope } from "./members.ts";
export { resetMemberMfa } from "./mfa-recovery.ts";
export { ORG_CONTEXT_HEADER, ORG_HEADER, orgCookieName, requestedOrgId } from "./org-context.ts";
export { createOrganization } from "./organization.ts";
export { createProperty, updateProperty } from "./property.ts";
export type { UserCommandRequest } from "./provision.ts";
export { assertPersonInOrg, assertPropertyInOrg } from "./scope.ts";
