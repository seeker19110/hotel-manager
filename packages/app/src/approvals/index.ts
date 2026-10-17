// Điểm công khai của module `approvals` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  APPROVAL_KINDS,
  type ApprovalRow,
  approvalRequired,
  cancelApproval,
  decideApproval,
  registerApprovalExecutor,
  requestApproval,
} from "./approvals.ts";
