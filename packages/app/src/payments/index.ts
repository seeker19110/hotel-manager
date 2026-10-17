// Điểm công khai của module `payments` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  type AllocationInput,
  allocatePayment,
  collectCash,
  confirmPayment,
  customerCredit,
  lockPerson,
  type ManualBankTxn,
  type PaymentRow,
  recordPayment,
  reversePayment,
} from "./payments.ts";
