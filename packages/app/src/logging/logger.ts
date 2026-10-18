// Logger JSON có cấu trúc (BASE-ERR-005/006/007/008/009, SEC-LOG-001/002, SEC-SECRET-007, TM-06/TM-10).
// Một dòng JSON mỗi sự kiện; `correlation_id` xuyên request/job; che bí mật và dữ liệu cá nhân trước khi ghi.
// Mỗi bản ghi có `service`/`version`/`env` và `severity_number` theo OpenTelemetry Logs; lỗi theo `exception.*`.
// Trong request/job: thêm `trace_id`/`span_id` (W3C Trace Context, trace.ts). Hình dạng bản ghi: `log-record.schema.json`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { traceLogFields } from "./trace.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** SeverityNumber của OTel Logs Data Model (DEBUG=5, INFO=9, WARN=13, ERROR=17). */
const SEVERITY_NUMBER: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 };
/** Khoá do logger đặt — trường do mã gọi truyền vào không được ghi đè (chống giả mạo bản ghi). */
const RESERVED = new Set([
  "ts",
  "level",
  "severity_number",
  "service",
  "version",
  "env",
  "category",
  "msg",
  "trace_id",
  "span_id",
]);

export const DEFAULT_SERVICE = "hotel-manager";

/**
 * Phiên bản sản phẩm: `APP_VERSION` (biến build/triển khai) nếu có, không thì trường `version` của `package.json` gốc
 * (đi ngược từ thư mục chạy), không có nữa thì `0.0.0`. Không hard-code — đổi version ở một chỗ là đủ.
 */
export function resolveAppVersion(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const fromEnv = env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    try {
      // nosemgrep: hm-path-traversal-dynamic -- `dir` đi ngược từ process.cwd(), tên tệp cố định `package.json`, không từ đầu vào ngoài.
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "hotel-manager") return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
      // Không có/không đọc được package.json ở tầng này — đi lên tiếp.
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "0.0.0";
}

let cachedVersion: string | undefined;
const defaultVersion = () => {
  cachedVersion ??= resolveAppVersion();
  return cachedVersion;
};

/** Khoá có tên thế này luôn bị thay bằng `***`, ở mọi độ sâu. */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[_-]?key|session|otp|cccd|cmnd|passport|id[_-]?number|document[_-]?number|identity/i;

/**
 * Khoá "chung" tên `key` (BASE-ERR-007): `key`, `api_key`, `S3_ACCESS_KEY_ID`, `accessKeyId`, `privateKey`, `signing-key`…
 * Chỉ khớp khi `key` là một TỪ (ngăn bằng `_ . - khoảng trắng` hoặc đổi chữ hoa trong camelCase), nên `keyword`/`monkey` không bị che.
 */
const KEY_WORD = /(?:^|[_.\s-])keys?(?:$|[_.\s-])/i;
const KEY_CAMEL = /[a-z0-9]Keys?(?![a-z])/;
export const isSensitiveKey = (k: string): boolean =>
  SENSITIVE_KEY.test(k) || KEY_WORD.test(k) || KEY_CAMEL.test(k);

/** Giá trị chuỗi: che số giấy tờ (9 hoặc 12 chữ số), số điện thoại VN, email; giữ vài ký tự cuối để tra cứu. */
// Ranh giới: không dính chữ/số/gạch nối hai bên — không che nhầm đoạn số bên trong UUID, mã băm, mã tham chiếu.
const VN_PHONE = /(?<![\w-])(?:\+?84|0)(\d{2})\d{4}(\d{3})(?![\w-])/g;
// Chỉ đúng độ dài CMND (9) / CCCD (12) để không che nhầm số tiền 10–11 chữ số.
const ID_NUMBER = /(?<![\w-])(?:\d{5}|\d{8})(\d{4})(?![\w-])/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// Bí mật nằm trong giá trị chuỗi (SEC-SECRET-007): token Bearer/Basic, mật khẩu trong URL kết nối, `password=…`.
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;
const KEY_VALUE_SECRET = /\b([\w-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key))=[^\s&;,]+/gi;

export function maskString(value: string): string {
  return value
    .replace(AUTH_SCHEME, "$1 ***")
    .replace(URL_CREDENTIALS, "$1:***@")
    .replace(KEY_VALUE_SECRET, "$1=***")
    .replace(EMAIL, "$1***@$2")
    .replace(VN_PHONE, "0$1****$2")
    .replace(ID_NUMBER, "****$1");
}

const MAX_STACK = 8000;
const MAX_CAUSE_DEPTH = 5;

/** Lỗi → thuộc tính OTel `exception.*` (stack đã che; `cause` đệ quy, tối đa 5 tầng). */
export function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const type = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  const out: Record<string, unknown> = {
    "exception.type": type,
    "exception.message": maskString(err.message),
  };
  if (err.stack) out["exception.stacktrace"] = maskString(err.stack).slice(0, MAX_STACK);
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined)
    out["exception.cause"] =
      cause instanceof Error && depth < MAX_CAUSE_DEPTH
        ? serializeError(cause, depth + 1)
        : cause instanceof Error
          ? "[depth]"
          : redact(cause, 1);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return serializeError(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? "***" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Sự kiện bảo mật (SEC-LOG-001): đăng nhập thất bại, từ chối quyền, đổi quyền, xuất dữ liệu… */
  security(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Trường chứa `Error` thì "nâng" `exception.*` lên cấp bản ghi, đúng quy ước OTel. */
const ERROR_FIELDS = ["err", "error", "exception"] as const;

export function createLogger(opts: {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  now?: () => Date;
  /** Tên dịch vụ (mặc định `hotel-manager`), phiên bản (mặc định xem `resolveAppVersion`), môi trường (NODE_ENV). */
  service?: string;
  version?: string;
  env?: string;
}): Logger {
  const level = opts.level ?? "info";
  const sink = opts.sink ?? { write: (l) => process.stdout.write(`${l}\n`) };
  const bindings = opts.bindings ?? {};
  const now = opts.now ?? (() => new Date());
  const service = opts.service ?? DEFAULT_SERVICE;
  const version = opts.version ?? defaultVersion();
  const env = opts.env ?? process.env.NODE_ENV ?? "development";

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>, category?: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const extras: Record<string, unknown> = {
      ...(redact(bindings) as Record<string, unknown>),
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    for (const k of ERROR_FIELDS) {
      const raw = fields?.[k];
      if (raw instanceof Error) {
        delete extras[k];
        Object.assign(extras, serializeError(raw));
        break;
      }
    }
    for (const k of RESERVED) delete extras[k];
    const record = {
      ts: now().toISOString(),
      level: lvl,
      severity_number: SEVERITY_NUMBER[lvl],
      service,
      version,
      env,
      ...(category ? { category } : {}),
      // `trace_id`/`span_id` của request/job đang chạy (W3C traceparent, xem trace.ts); ngoài request/job thì không có.
      ...traceLogFields(),
      // JSON.stringify escape CR/LF/ký tự điều khiển ⇒ chuỗi người dùng không tách được thành "dòng log giả".
      msg: maskString(msg),
      ...extras,
    };
    sink.write(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    security: (e, f) => emit("warn", e, { ...f, event: e }, "security"),
    child: (b) => createLogger({ level, sink, now, service, version, env, bindings: { ...bindings, ...b } }),
  };
}
