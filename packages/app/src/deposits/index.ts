// Điểm công khai của module `deposits` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  receiveDeposit,
  refundDepositAtCheckout,
  requestCreditRefund,
  requestDeduction,
  requestDepositRefund,
} from "./deposits.ts";
