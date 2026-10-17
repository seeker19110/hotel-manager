// Điểm công khai của module `identity` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { type DocType, getIdentityDocument, recordIdentityDocument, revealDocNumber } from "./identity.ts";
