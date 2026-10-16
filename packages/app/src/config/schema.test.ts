import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, ENV_KEYS, loadConfig, redactConfig, SECRET_KEYS } from "./schema.ts";

const valid = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:sieu-bi-mat@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "hotel-dev",
  S3_ACCESS_KEY_ID: "AKIA-TEST",
  S3_SECRET_ACCESS_KEY: "khoa-s3-bi-mat",
};

describe("loadConfig (BASE-CFG-002)", () => {
  it("env hợp lệ → config đông cứng, có mặc định", () => {
    const c = loadConfig(valid);
    expect(c.NODE_ENV).toBe("development");
    expect(c.SMTP_URL).toBe("fake://local");
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("env trống → ConfigError liệt kê TÊN biến thiếu, không lộ giá trị", () => {
    const err = (() => {
      try {
        loadConfig({});
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    const keys = (err as ConfigError).issues.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["APP_BASE_URL", "DATABASE_URL", "BETTER_AUTH_SECRET"]));
  });

  it("giá trị sai → thông báo nêu tên biến nhưng không chứa giá trị", () => {
    const bad = { ...valid, BETTER_AUTH_SECRET: "ngan-qua-bi-mat" };
    expect(() => loadConfig(bad)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig(bad)).not.toThrow(/ngan-qua-bi-mat/);
  });
});

describe("che bí mật khi in (BASE-CFG-005)", () => {
  const c = loadConfig(valid);
  it.each([
    ["JSON.stringify", () => JSON.stringify(c)],
    ["String()", () => String(c)],
    ["util.inspect", () => inspect(c)],
    ["redactConfig", () => JSON.stringify(redactConfig(c))],
  ])("%s không chứa giá trị bí mật", (_name, dump) => {
    const out = dump();
    for (const secret of ["sieu-bi-mat", "x".repeat(40), "khoa-s3-bi-mat", "AKIA-TEST"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("***");
  });
});

describe("khoá mã hoá số giấy tờ (D-004, T-202)", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const issuesOf = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [];
    } catch (e) {
      return (e as ConfigError).issues.map((i) => i.key);
    }
  };

  it("production thiếu khoá PII → lỗi khởi động nêu đủ tên biến", () => {
    expect(issuesOf({ ...valid, NODE_ENV: "production" })).toEqual(
      expect.arrayContaining(["HM_PII_KEYS", "HM_PII_KEY_ID", "HM_PII_INDEX_KEY"]),
    );
  });

  it("production đủ khoá hợp lệ → chạy; dev để trống → dùng khoá dev", () => {
    expect(
      issuesOf({
        ...valid,
        NODE_ENV: "production",
        CLAMD_HOST: "clamav",
        HM_PII_KEYS: `1:${key}`,
        HM_PII_KEY_ID: "1",
        HM_PII_INDEX_KEY: key,
      }),
    ).toEqual([]);
    expect(issuesOf({ ...valid, HM_PII_KEYS: "", HM_PII_KEY_ID: "", HM_PII_INDEX_KEY: "" })).toEqual([]);
  });

  it("đặt thiếu một biến, sai định dạng, khoá ghi không có → lỗi; thông điệp không chứa khoá", () => {
    expect(issuesOf({ ...valid, HM_PII_KEYS: `1:${key}` })).toContain("HM_PII_KEYS");
    expect(
      issuesOf({ ...valid, HM_PII_KEYS: "1:ngan", HM_PII_KEY_ID: "1", HM_PII_INDEX_KEY: key }),
    ).toContain("HM_PII_KEYS");
    let msg = "";
    try {
      loadConfig({ ...valid, HM_PII_KEYS: `1:${key}`, HM_PII_KEY_ID: "2", HM_PII_INDEX_KEY: key });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("HM_PII_KEY_ID");
    expect(msg).not.toContain(key);
  });

  it("production thiếu CLAMD_HOST → lỗi khởi động (D-003: không có máy quét thì không nhận file)", () => {
    expect(issuesOf({ ...valid, NODE_ENV: "production" })).toContain("CLAMD_HOST");
    expect(loadConfig(valid).CLAMD_PORT).toBe(3310);
  });

  it("khoá PII là bí mật: bị che khi in", () => {
    const c = loadConfig({ ...valid, HM_PII_KEYS: `1:${key}`, HM_PII_KEY_ID: "1", HM_PII_INDEX_KEY: key });
    expect(JSON.stringify(c)).not.toContain(key);
    expect(inspect(c)).not.toContain(key);
  });
});

describe(".env.example khớp schema (BASE-CFG-003)", () => {
  const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
  const keys = example
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => l.split("=")[0]);

  it("tập khoá trùng khớp", () => {
    expect([...keys].sort()).toEqual([...ENV_KEYS].sort());
  });

  it("không biến bí mật nào mang tiền tố NEXT_PUBLIC_ (TM-10)", () => {
    for (const k of [...ENV_KEYS, ...SECRET_KEYS]) expect(k.startsWith("NEXT_PUBLIC_")).toBe(false);
  });

  it(".env.example parse được bằng schema", () => {
    const env = Object.fromEntries(
      example
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
    expect(() => loadConfig(env)).not.toThrow();
  });
});
