// Logger JSON có cấu trúc (BASE-ERR-005/006/007, SEC-LOG-001, TM-06/TM-10).
// Một dòng JSON mỗi sự kiện; `correlation_id` xuyên request/job; che bí mật và dữ liệu cá nhân trước khi ghi.

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Khoá có tên thế này luôn bị thay bằng `***`, ở mọi độ sâu. */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[_-]?key|session|otp|cccd|cmnd|passport|id[_-]?number|document[_-]?number|identity/i;

/** Giá trị chuỗi: che số giấy tờ (9 hoặc 12 chữ số), số điện thoại VN, email; giữ vài ký tự cuối để tra cứu. */
// Ranh giới: không dính chữ/số/gạch nối hai bên — không che nhầm đoạn số bên trong UUID, mã băm, mã tham chiếu.
const VN_PHONE = /(?<![\w-])(?:\+?84|0)(\d{2})\d{4}(\d{3})(?![\w-])/g;
// Chỉ đúng độ dài CMND (9) / CCCD (12) để không che nhầm số tiền 10–11 chữ số.
const ID_NUMBER = /(?<![\w-])(?:\d{5}|\d{8})(\d{4})(?![\w-])/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function maskString(value: string): string {
  return value.replace(EMAIL, "$1***@$2").replace(VN_PHONE, "0$1****$2").replace(ID_NUMBER, "****$1");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: maskString(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : redact(v, depth + 1);
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

export function createLogger(opts: {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  now?: () => Date;
}): Logger {
  const level = opts.level ?? "info";
  const sink = opts.sink ?? { write: (l) => process.stdout.write(`${l}\n`) };
  const bindings = opts.bindings ?? {};
  const now = opts.now ?? (() => new Date());

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>, category?: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = {
      ts: now().toISOString(),
      level: lvl,
      ...(category ? { category } : {}),
      msg: maskString(msg),
      ...(redact(bindings) as Record<string, unknown>),
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    sink.write(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    security: (e, f) => emit("warn", e, f, "security"),
    child: (b) => createLogger({ level, sink, now, bindings: { ...bindings, ...b } }),
  };
}
