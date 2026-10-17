// Điểm công khai của module `maintenance` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  assignWorkOrder,
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  listMyWorkOrders,
  listWorkOrders,
  proposeWorkOrderBlock,
  type Severity,
  startWorkOrder,
  verifyWorkOrder,
} from "./work-orders.ts";
