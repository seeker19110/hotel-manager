// Cửa nhẹ cho logging (`@hm/app/logging`): không kéo theo CSDL/Better Auth — `instrumentation.ts` import lúc khởi động.
export { createLogger, type Logger } from "./logger.ts";
export { appLogger, setAppLogger } from "./runtime.ts";
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
