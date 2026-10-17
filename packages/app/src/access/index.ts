// Điểm công khai của module `access` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { AccessError, type Actor, listMyOrganizations, resolveActor } from "./actor.ts";
export { resetMemberMfa } from "./mfa-recovery.ts";
export {
  ORG_CONTEXT_HEADER,
  ORG_HEADER,
  orgCookieName,
  requestedOrgId,
  switchOrganization,
} from "./org-context.ts";
export { assertPersonInOrg, assertPropertyInOrg } from "./scope.ts";
