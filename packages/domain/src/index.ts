// Quy tắc nghiệp vụ thuần (không I/O) — ADR-0001.
export const DOMAIN_PACKAGE = "@hm/domain";
export {
  type AuthzActor,
  type AuthzCode,
  type AuthzContext,
  AuthzError,
  type AuthzResult,
  authorize,
  authorizeRequest,
  effectiveLimit,
  isMatrixRole,
} from "./access/authorize.ts";
export {
  type Action,
  DEFAULT_LIMITS,
  type Grant,
  grantFor,
  LIMIT_KIND,
  MATRIX,
  type MatrixRole,
  ROLES,
} from "./access/matrix.ts";
export {
  type BillingLine,
  type BillingVersion,
  computeLeaseInvoice,
  daysInMonth,
  type FixedServiceInput,
  FORMULA_VERSION,
  type LeaseBillingInput,
  type MeteredInput,
  meteredLine,
  type ProrataMode,
  type RevenueAccount,
  rentLines,
} from "./billing/engine.ts";
export {
  type Cell,
  csvCell,
  type Parsed,
  parseImportDate,
  parseImportDecimal,
  parseImportInt,
  parseImportText,
  parseImportVnd,
  toCsv,
  type ValueCode,
} from "./import/values.ts";
export {
  ACCOUNTS,
  type Account,
  assertBalanced,
  assertVnd,
  DEFAULT_ROUNDING,
  decimalSub,
  hasMaxDecimals,
  lineAmount,
  MoneyError,
  type PostingLine,
  parseDecimal,
  prorate,
  ROUNDING_RULES,
  type RoundingRule,
  roundVnd,
  sumVnd,
} from "./money/money.ts";
export { QR_MAX_BYTES, qrMatrix } from "./payments/qr.ts";
export {
  BREAK_REASONS,
  type BreakReason,
  type CandidateInvoice,
  classifyBankTxn,
  generateMemoRef,
  type MatchSuggestion,
  MEMO_ALPHABET,
  MEMO_PREFIX,
  memoCandidates,
  normalizeMemo,
} from "./payments/reconcile.ts";
export {
  type ColumnRef,
  mapStatement,
  parseCsv,
  parseStatementDate,
  parseVndAmount,
  STATEMENT_MAX_BYTES,
  STATEMENT_MAX_ROWS,
  type StatementMapping,
  type StatementRow,
} from "./payments/statement-csv.ts";
export { BANK_BINS, bankBin, buildVietQr, crc16CcittFalse, type VietQrInput } from "./payments/vietqr.ts";
export { vndInWords } from "./payments/vnd-words.ts";
export {
  billingPeriodMachine,
  bookingMachine,
  defineMachine,
  leaseMachine,
  MACHINES,
  type Machine,
  paymentMachine,
  stayMachine,
  TransitionError,
  taskMachine,
} from "./state/machine.ts";
export { parseStayNoticeDeadline, type StayNoticeDeadline, stayNoticeDueLocal } from "./stay/notice.ts";
export {
  addDays,
  DEFAULT_MAX_NIGHTS,
  DEFAULT_WEEKEND_NIGHTS,
  isoWeekday,
  maxNightsSetting,
  type NightPrice,
  nightsOf,
  priceNights,
  type QuoteError,
  QuoteRuleError,
  type RateVersion,
  repriceForDates,
  sumNights,
  weekendNightsSetting,
} from "./stay/pricing.ts";
