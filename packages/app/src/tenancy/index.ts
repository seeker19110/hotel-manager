// Điểm công khai của module vòng đời tổ chức (ARC-MOD-005; PLAN T-2312, D-125): yêu cầu/huỷ xoá, trạng thái, purge, chứng nhận.
export {
  cancelOrgDeletion,
  listOrgDeletionCertificates,
  ORG_DELETION_GRACE_DAYS,
  type OrgDeletionCertificate,
  OrgDeletionError,
  type OrgDeletionErrorCode,
  type OrgDeletionStatus,
  type OrgPurgeDeps,
  type OrgPurgeResult,
  orgDeletionStatus,
  orgPurgeEnabled,
  purgeDueOrganizations,
  type RequestOrgDeletionInput,
  type RequestOrgDeletionResult,
  requestOrgDeletion,
} from "./org-deletion.ts";
