// Điểm công khai của module `inventory` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  approveBlock,
  confirmHold,
  createHold,
  endBlock,
  getUnitStatus,
  type Interval,
  proposeBlock,
} from "./inventory.ts";
export { createUnit } from "./units.ts";
