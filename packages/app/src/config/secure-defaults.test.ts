// T-403 (đợt 5) — mặc định an toàn: bảng `docs/design/SECURE-DEFAULTS.md` khớp cấu hình hiệu lực (BASE-CFG-007), production
// bắt TLS (BASE-SEC-004), bind 127.0.0.1 (BASE-SEC-010), không biến công khai mang bí mật (BASE-CFG-008).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError, register } from "../../../../apps/web/instrumentation.ts";
import { createLogger, type LogSink } from "../logging/logger.ts";
import { setAppLogger } from "../logging/runtime.ts";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";
import {
  ConfigError,
  ENV_KEYS,
  envSchema,
  isDbUrlWithoutVerifiedTls,
  isInsecureRemoteUrl,
  loadConfig,
  PUBLIC_ENV_PREFIXES,
  publicSecretNames,
  redactConfig,
  SECRET_KEYS,
} from "./schema.ts";
import { WORKER_ENV_KEYS } from "./worker.ts";

const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

/** Env tối thiểu (chỉ biến bắt buộc, không đặt biến tuỳ chọn nào). */
const MINIMAL = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:sieu-bi-mat@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "hotel-dev",
  S3_ACCESS_KEY_ID: "AKIA-TEST",
  S3_SECRET_ACCESS_KEY: "khoa-s3-bi-mat",
};

/** Hàng bảng markdown dạng `| `khoá` | giá trị | … |` → { khoá: giá trị }. */
function tableRows(md: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = /^`([^`]+)`$/.exec(cells[1] ?? "")?.[1];
    if (key) rows.set(key, (cells[2] ?? "").replace(/^`|`$/g, ""));
  }
  return rows;
}

const DOC = read("docs/design/SECURE-DEFAULTS.md");
/** Mục 1: biến env tuỳ chọn. Mục 2: tuỳ chọn mạng/bảo mật không phải env (bind, DEBUG, TLS verify, CORS…). */
const TABLE = tableRows(DOC.slice(DOC.indexOf("## 1."), DOC.indexOf("## 2.")));
const OTHER = tableRows(DOC.slice(DOC.indexOf("## 2.")));
const OPTIONAL_UNSET = /^không đặt/;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppLogger(undefined);
});

describe("BASE-CFG-007 — bảng mặc định an toàn khớp cấu hình hiệu lực", () => {
  const config = loadConfig(MINIMAL);
  const effective = redactConfig(config);
  const required = new Set(
    ENV_KEYS.filter((k) => !envSchema.shape[k].safeParse(undefined).success && k in MINIMAL),
  );

  it("mọi khoá env tuỳ chọn có hàng trong bảng; không có hàng thừa cho khoá env không tồn tại", () => {
    const optional = ENV_KEYS.filter((k) => !(k in MINIMAL));
    expect(optional.filter((k) => !TABLE.has(k))).toEqual([]);
    const envLike = [...TABLE.keys()].filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k));
    expect(envLike.filter((k) => !(ENV_KEYS as string[]).includes(k))).toEqual([]);
    expect(required.size).toBeGreaterThan(0);
  });

  it.each(ENV_KEYS.filter((k) => !(k in MINIMAL)))(
    "%s: giá trị hiệu lực khi không đặt = giá trị trong bảng",
    (k) => {
      const doc = TABLE.get(k) ?? "";
      // Đọc giá trị thật (chưa che): bảng ghi giá trị hiệu lực; việc che bí mật khi IN được kiểm ở test dưới.
      const actual = (config as Record<string, unknown>)[k];
      if (OPTIONAL_UNSET.test(doc)) expect(actual, `${k} phải không đặt`).toBeUndefined();
      else expect(String(actual)).toBe(doc);
    },
  );

  it("không đặt biến tuỳ chọn nào: không có giá trị mặc định cho bất kỳ bí mật BẮT BUỘC nào", () => {
    // Bí mật bắt buộc thiếu ⇒ ConfigError nêu tên (không "chạy với khoá mặc định").
    for (const k of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const) {
      const { [k]: _omit, ...rest } = MINIMAL;
      const err = (() => {
        try {
          loadConfig(rest);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.map((i) => i.key)).toContain(k);
    }
    // Bí mật tuỳ chọn (kể cả khoá mã hoá PII) không có mặc định ở production.
    for (const k of ["PGBACKREST_REPO_CIPHER_PASS", "SIM_WEBHOOK_SECRET", "HM_PII_KEYS", "HM_PII_INDEX_KEY"])
      expect((effective as Record<string, unknown>)[k]).toBeUndefined();
  });

  it("cấu hình hiệu lực in lúc khởi động (instrumentation.register) khớp bảng và che mọi bí mật", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    for (const [k, v] of Object.entries({ ...MINIMAL, NEXT_RUNTIME: "nodejs" })) vi.stubEnv(k, v);
    for (const k of ENV_KEYS.filter((k) => !(k in MINIMAL))) vi.stubEnv(k, undefined as unknown as string);
    vi.stubEnv("LOG_LEVEL", "info");
    await register();
    const record = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.msg === "config.effective");
    expect(record, "register() phải in config.effective").toBeDefined();
    const printed = record?.config as Record<string, unknown>;
    for (const [k, doc] of TABLE) {
      if (!(ENV_KEYS as string[]).includes(k) || k in MINIMAL) continue;
      if (OPTIONAL_UNSET.test(doc)) expect(printed[k], k).toBeUndefined();
      else if ((SECRET_KEYS as readonly string[]).includes(k)) expect(printed[k], k).toBe("***");
      else expect(String(printed[k]), k).toBe(doc);
    }
    // Bí mật đã đặt (hoặc có mặc định, như SMTP_URL) phải in `***`; bí mật tuỳ chọn không đặt thì không in.
    for (const k of SECRET_KEYS) if (printed[k] !== undefined || k in MINIMAL) expect(printed[k]).toBe("***");
    expect(printed.SMTP_URL).toBe("***");
    const raw = lines.join("");
    for (const secret of ["sieu-bi-mat", "x".repeat(40), "khoa-s3-bi-mat", "AKIA-TEST"])
      expect(raw).not.toContain(secret);
  });

  it("mặc định không phải env có đủ hàng trong bảng và khớp mã: DEBUG tắt, CORS đóng, không khoá mặc định", () => {
    for (const k of [
      "bind",
      "DEBUG",
      "TLS verify",
      "CORS",
      "khoá mặc định",
      "biến công khai",
      "cookie phiên",
    ])
      expect(OTHER.has(k), `thiếu hàng ${k}`).toBe(true);
    expect(OTHER.get("DEBUG")).toBe("tắt");
    expect(OTHER.get("CORS")).toBe("đóng");
    const code = sourceFiles(["apps", "packages"], /\.(ts|tsx|mjs)$/).filter(
      (f) => !f.path.startsWith("packages/testkit/") && !f.path.includes("/e2e/"),
    );
    // DEBUG tắt: không đọc cờ debug từ env, không bật chế độ debug cứng.
    expect(
      code.filter((f) => /process\.env\.DEBUG\b|\bdebug\s*:\s*true\b/.test(f.text)).map((f) => f.path),
    ).toEqual([]);
    // CORS đóng: không đâu đặt `Access-Control-Allow-*` (cùng origin; ghi khác origin bị proxy.ts chặn 403).
    expect(code.filter((f) => /access-control-allow/i.test(f.text)).map((f) => f.path)).toEqual([]);
    // Không khoá mặc định: bí mật bắt buộc không có `.default(`.
    const secretsWithDefault = SECRET_KEYS.filter((k) =>
      /_default|"default"/.test(JSON.stringify(envSchema.shape[k].def)),
    );
    expect(secretsWithDefault).toEqual(["SMTP_URL"]); // `fake://local`: chế độ KHÔNG gửi thư, không phải bí mật thật
  });

  it("NODE_ENV mặc định development (chỉ production mới siết) — đúng như bảng", () => {
    expect(TABLE.get("NODE_ENV")).toBe("development");
    expect(config.NODE_ENV).toBe("development");
  });
});

describe("BASE-SEC-004 — production bắt TLS cho mọi kênh mạng", () => {
  const prod = {
    ...MINIMAL,
    NODE_ENV: "production",
    CLAMD_HOST: "clamd",
    HM_PII_KEYS: `1:${Buffer.alloc(32, 7).toString("base64")}`,
    HM_PII_KEY_ID: "1",
    HM_PII_INDEX_KEY: Buffer.alloc(32, 9).toString("base64"),
    APP_BASE_URL: "https://hm.example.test",
    S3_ENDPOINT: "https://files.example.test",
  };
  const issuesOf = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [] as string[];
    } catch (e) {
      return (e as ConfigError).issues.map((i) => i.key);
    }
  };

  it("production đủ https → chạy", () => {
    expect(issuesOf(prod)).toEqual([]);
  });

  it.each([
    ["APP_BASE_URL", "http://hm.example.test"],
    ["S3_ENDPOINT", "http://files.example.test"],
    ["SMTP_URL", "smtp://relay.example.test:25"],
  ])("production + %s=%s → ConfigError nêu tên, không lộ giá trị", (key, value) => {
    expect(issuesOf({ ...prod, [key]: value })).toContain(key);
    expect(() => loadConfig({ ...prod, [key]: value })).not.toThrow(
      /relay\.example|files\.example|hm\.example/,
    );
  });

  it("loopback (localhost/127.0.0.1/::1) được miễn — E2E/CI chạy `next start` trên máy; dev/test không bị siết", () => {
    expect(
      issuesOf({ ...prod, APP_BASE_URL: "http://127.0.0.1:3100", S3_ENDPOINT: "http://localhost:8333" }),
    ).toEqual([]);
    expect(issuesOf({ ...prod, S3_ENDPOINT: "http://[::1]:8333" })).toEqual([]);
    expect(issuesOf({ ...MINIMAL, APP_BASE_URL: "http://app.example.test" })).toEqual([]);
  });

  it("SMTP production: smtps://, smtp://…?requireTLS=true, fake:// được; smtp:// trần thì không", () => {
    expect(issuesOf({ ...prod, SMTP_URL: "smtps://u:p@example.test:465" })).toEqual([]);
    expect(issuesOf({ ...prod, SMTP_URL: "smtp://relay.example.test:587?requireTLS=true" })).toEqual([]);
    expect(issuesOf({ ...prod, SMTP_URL: "fake://local" })).toEqual([]);
    expect(issuesOf({ ...prod, SMTP_URL: "smtp://relay.example.test:587?requireTLS=false" })).toContain(
      "SMTP_URL",
    );
  });

  it("isInsecureRemoteUrl: http tới máy khác = true; https/loopback/không phải URL = false", () => {
    expect(isInsecureRemoteUrl("http://example.test")).toBe(true);
    expect(isInsecureRemoteUrl("HTTP://EXAMPLE.TEST/x")).toBe(true);
    expect(isInsecureRemoteUrl("https://example.test")).toBe(false);
    expect(isInsecureRemoteUrl("http://127.0.0.1:1")).toBe(false);
    expect(isInsecureRemoteUrl("khong-phai-url")).toBe(false);
  });

  it("mã nguồn không tắt xác minh chứng chỉ (NODE_TLS_REJECT_UNAUTHORIZED=0, rejectUnauthorized:false, verify=False…)", () => {
    const re =
      /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0|rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify|strictSSL\s*:\s*false|sslmode=(?:disable|allow|prefer)/;
    const hits = sourceFiles(["apps", "packages", "scripts", "deploy"], /\.(ts|tsx|mjs|js|py|ya?ml|sh|conf)$/)
      .filter((f) => re.test(f.text))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe("DB-SEC-003 — production: CSDL ở máy khác chỉ qua TLS xác minh chứng chỉ (sslmode=verify-full)", () => {
  const prod = {
    ...MINIMAL,
    NODE_ENV: "production",
    CLAMD_HOST: "clamd",
    HM_PII_KEYS: `1:${Buffer.alloc(32, 7).toString("base64")}`,
    HM_PII_KEY_ID: "1",
    HM_PII_INDEX_KEY: Buffer.alloc(32, 9).toString("base64"),
    APP_BASE_URL: "https://hm.example.test",
    S3_ENDPOINT: "https://files.example.test",
  };
  const dbIssues = (url: string) => {
    try {
      loadConfig({ ...prod, DATABASE_URL: url });
      return [] as string[];
    } catch (e) {
      return (e as ConfigError).issues.map((i) => i.key);
    }
  };

  it.each([
    ["postgres://u:p@postgres:5432/hm"],
    ["postgres://u:p@postgres:5432/hm?sslmode=require"],
    ["postgres://u:p@postgres:5432/hm?sslmode=verify-ca"],
    ["postgres://u:p@postgres:5432/hm?sslmode=prefer"],
    ["postgres://u:p@pg-primary/hm?sslmode=VERIFY-FULL"],
    ["postgres://u:p@pg-primary/hm?x=sslmode%3Dverify-full"],
    // Qua mặt cổng bằng tham số lặp / host ghi đè (driver lấy giá trị CUỐI; `?host=` thắng hostname).
    ["postgres://u:p@postgres:5432/hm?sslmode=verify-full&sslmode=no-verify"],
    ["postgres://u:p@postgres:5432/hm?sslmode=verify-full&sslmode=disable"],
    ["postgres://u:p@postgres:5432/hm?sslmode=no-verify&sslmode=verify-full"],
    ["postgres://u:p@localhost:5432/hm?host=db.remote.example"],
    ["postgres://u:p@localhost:5432/hm?host=/var/run/postgresql"],
    ["postgres:///hm?host=10.0.0.5"],
    ["postgres:///hm?host=/var/run/postgresql&host=10.0.0.5"],
    ["postgres://u:p@pg-primary/hm?sslmode=verify-full&host=db.remote.example"],
    ["postgres://u:p@pg-primary/hm?sslmode=verify-full&hostaddr=10.0.0.5"],
    ["postgres://u:p@localhost/hm?hostaddr=10.0.0.5"],
    ["postgres:///hm"],
  ])("production + %s → từ chối, nêu tên DATABASE_URL, không lộ mật khẩu", (url) => {
    expect(dbIssues(url)).toEqual(["DATABASE_URL"]);
    expect(() => loadConfig({ ...prod, DATABASE_URL: url })).not.toThrow(/:p@/);
  });

  it.each([
    ["postgres://u:p@postgres:5432/hm?sslmode=verify-full&sslrootcert=/run/secrets/pg-ca.crt"],
    ["postgresql://u:p@pg-primary/hm?sslmode=verify-full"],
    ["postgres://u:p@localhost:5432/hm"],
    ["postgres://u:p@127.0.0.1:5432/hm"],
    ["postgres://u:p@[::1]:5432/hm"],
    ["postgres:///hm?host=/var/run/postgresql"],
    ["postgres://%2Fvar%2Frun%2Fpostgresql/hm"],
  ])("production + %s → chấp nhận (verify-full, loopback hoặc socket Unix)", (url) => {
    expect(dbIssues(url)).toEqual([]);
  });

  it("dev/test không bị siết: máy khác, không sslmode vẫn qua", () => {
    expect(() => loadConfig({ ...MINIMAL, DATABASE_URL: "postgres://u:p@postgres:5432/hm" })).not.toThrow();
    expect(() =>
      loadConfig({ ...MINIMAL, NODE_ENV: "test", DATABASE_URL: "postgres://u:p@postgres:5432/hm" }),
    ).not.toThrow();
  });

  it("isDbUrlWithoutVerifiedTls: URL không đọc được → coi là không an toàn (đóng khi lỗi)", () => {
    expect(isDbUrlWithoutVerifiedTls("khong-phai-url")).toBe(true);
    expect(isDbUrlWithoutVerifiedTls("")).toBe(true);
    expect(isDbUrlWithoutVerifiedTls("mysql://u:p@localhost/hm")).toBe(true);
  });
});

describe("BASE-SEC-010 — bind 127.0.0.1 mặc định, không mở cổng CSDL/cache ra ngoài", () => {
  const scripts = (JSON.parse(read("apps/web/package.json")) as { scripts: Record<string, string> }).scripts;

  // biome-ignore lint/suspicious/noTemplateCurlyInString: chủ ý: tên test mô tả cú pháp shell `${HOST:-…}` của script, không phải template literal
  it.each(["dev", "start"])("script `%s` của web bind ${HOST:-127.0.0.1} (không phải 0.0.0.0)", (name) => {
    expect(scripts[name]).toMatch(/-H \$\{HOST:-127\.0\.0\.1\}/);
    expect(scripts[name]).not.toContain("0.0.0.0");
  });

  it("bảng ghi bind 127.0.0.1", () => {
    expect(OTHER.get("bind")).toBe("127.0.0.1");
  });

  it("compose không publish cổng Postgres/SeaweedFS ra host: chỉ Caddy có `ports`", () => {
    const compose = read("deploy/compose.yaml");
    const services = compose.split(/^services:\n/m)[1] ?? "";
    const blocks = services.split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).filter(Boolean);
    const withPorts = blocks.filter((b) => /^ {4}ports:/m.test(b)).map((b) => /^([\w-]+):/.exec(b)?.[1]);
    expect(withPorts).toEqual(["caddy"]);
  });
});

describe("BASE-CFG-008 — phân loại env: không biến công khai, không bí mật mang tiền tố công khai", () => {
  it("không khoá env nào của web/worker có tiền tố công khai (mọi biến là server-only)", () => {
    const keys = [...ENV_KEYS, ...WORKER_ENV_KEYS];
    expect(keys.filter((k) => PUBLIC_ENV_PREFIXES.some((p) => k.startsWith(p)))).toEqual([]);
    expect(publicSecretNames(keys)).toEqual([]);
  });

  it("lint tên: tiền tố công khai + SECRET|KEY|TOKEN|PASSWORD → vi phạm (trừ allowlist)", () => {
    expect(
      publicSecretNames([
        "NEXT_PUBLIC_API_KEY",
        "VITE_AUTH_TOKEN",
        "PUBLIC_DB_PASSWORD",
        "EXPO_PUBLIC_CLIENT_SECRET",
        "NEXT_PUBLIC_APP_NAME",
        "S3_SECRET_ACCESS_KEY",
      ]),
    ).toEqual(["NEXT_PUBLIC_API_KEY", "VITE_AUTH_TOKEN", "PUBLIC_DB_PASSWORD", "EXPO_PUBLIC_CLIENT_SECRET"]);
  });

  it("repo không đọc/khai biến công khai nào: grep NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_ trong mã, next.config, .env mẫu, compose", () => {
    const files = [
      // schema.ts nêu các tiền tố để CẤM chúng — là nguồn của rào này, không phải nơi dùng.
      ...sourceFiles(["apps", "packages", "deploy"], /\.(ts|tsx|mjs|js|ya?ml|json|example)$/).filter(
        (f) => f.path !== "packages/app/src/config/schema.ts",
      ),
      ...["next.config.ts"].map((p) => ({ path: p, text: read(`apps/web/${p}`) })),
    ];
    const re = /\b(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_)[A-Z0-9_]*/;
    expect(files.filter((f) => re.test(f.text)).map((f) => f.path)).toEqual([]);
    // `.env.example` ở gốc và deploy/ cũng không khai biến công khai nào.
    for (const p of [".env.example", "deploy/.env.example"]) expect(read(p)).not.toMatch(re);
  });

  it("next.config không nhúng env vào bundle (`env:`/`publicRuntimeConfig`)", () => {
    expect(read("apps/web/next.config.ts")).not.toMatch(/\benv\s*:|publicRuntimeConfig/);
  });
});

describe("BASE-ERR-002 — onRequestError ghi lỗi render/route chưa bắt", () => {
  function capture() {
    const lines: string[] = [];
    const sink: LogSink = { write: (l) => lines.push(l) };
    setAppLogger(createLogger({ sink, level: "info", service: "hm-web", env: "test" }));
    return () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const req = {
    path: "/hop-dong/0b0e5e6c-6a3f-4f7e-9a58-2f6d3b0b9a11?token=abc123",
    method: "GET",
    headers: {
      cookie: "session=bi-mat-phien",
      authorization: "Bearer bi-mat-bearer-12345",
      "x-correlation-id": "corr-12345",
    },
  };

  it("runtime nodejs: log ERROR kèm stack, cause, mẫu route, correlation id; không cookie/token/đường dẫn thật", async () => {
    const out = capture();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const err = new Error("hỏng khi kết nối postgres://app:mat-khau-db@db:5432/hm", {
      cause: new TypeError("gốc"),
    });
    (err as { digest?: string }).digest = "d123";
    await onRequestError(err, req, {
      routerKind: "App Router",
      routePath: "/hop-dong/[id]",
      routeType: "render",
    });
    const [rec] = out();
    expect(rec).toMatchObject({
      level: "error",
      route: "/hop-dong/[id]",
      route_type: "render",
      method: "GET",
      correlation_id: "corr-12345",
      digest: "d123",
      "exception.type": "Error",
    });
    expect(String(rec?.["exception.stacktrace"])).toContain("Error:");
    expect(rec?.["exception.cause"]).toMatchObject({ "exception.type": "TypeError" });
    const raw = JSON.stringify(rec);
    for (const leak of ["bi-mat-phien", "bi-mat-bearer", "mat-khau-db", "abc123", "0b0e5e6c"])
      expect(raw).not.toContain(leak);
  });

  it("giá trị bị ném không phải Error vẫn được ghi (không mất lỗi); runtime edge → bỏ qua", async () => {
    const out = capture();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await onRequestError("chuỗi bị ném", { ...req, headers: {} }, {});
    expect(out()[0]).toMatchObject({ level: "error", route: "(không rõ)" });
    expect(String(out()[0]?.["exception.message"])).toContain("chuỗi bị ném");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const before = out().length;
    await onRequestError(new Error("x"), req, {});
    expect(out().length).toBe(before);
  });
});
