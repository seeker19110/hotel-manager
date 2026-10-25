// Điểm công khai của module `tenancy` (ARC-MOD-005): vòng đời xoá tổ chức (T-2312, D-121).
export {
  cancelOrgDeletion,
  myOrgDeletionCertificates,
  ORG_DELETION_GRACE_DAYS,
  ORG_DELETION_REAUTH_MAX_AGE_SECONDS,
  ORG_PURGE_BATCH,
  type OrgDeletionCertificate,
  type OrgDeletionStatus,
  type OrgObjectStore,
  type OrgPurgeResult,
  orgDeletionStatus,
  processOrgPurges,
  purgeOrganization,
  requestOrgDeletion,
} from "./org-deletion.ts";
