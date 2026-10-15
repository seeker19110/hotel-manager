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
  ACCOUNTS,
  type Account,
  assertBalanced,
  assertVnd,
  DEFAULT_ROUNDING,
  lineAmount,
  MoneyError,
  type PostingLine,
  parseDecimal,
  ROUNDING_RULES,
  type RoundingRule,
  roundVnd,
  sumVnd,
} from "./money/money.ts";
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
