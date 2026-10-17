// Cửa nhẹ cho logging (`@hm/app/logging`): không kéo theo CSDL/Better Auth — `instrumentation.ts` import lúc khởi động.
export { createLogger, type Logger, redact } from "./logger.ts";
export { appLogger, setAppLogger } from "./runtime.ts";
export {
  type ActorRef,
  auditSource,
  type CommandSecurityInput,
  emitSecurity,
  requestClient,
  type SecurityClient,
  type SecurityEventInput,
  type SecurityEventName,
  type SecurityOutcome,
  securityEventForProblem,
} from "./security-events.ts";
export { reportBackendTlsError, tlsFailureCode } from "./tls-errors.ts";
export {
  currentTrace,
  currentTraceparent,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  runJobWithTrace,
  runWithTrace,
  TRACEPARENT_HEADER,
  type TraceContext,
  traceForJob,
  withRequestTrace,
} from "./trace.ts";
export { reportRequestError, reportUnexpectedError } from "./unexpected.ts";
