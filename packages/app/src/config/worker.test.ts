// T-301: cấu hình worker = schema web + WORKER_DATABASE_URL (vai trò app_worker).
import { describe, expect, it } from "vitest";
import { ConfigError } from "./schema.ts";
import { loadWorkerConfig } from "./worker.ts";

const valid = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://rt:bi-mat-rt@localhost:5432/db",
  WORKER_DATABASE_URL: "postgres://wk:bi-mat-wk@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "hotel-dev",
  S3_ACCESS_KEY_ID: "AKIA-TEST",
  S3_SECRET_ACCESS_KEY: "khoa-s3-bi-mat",
};

function issues(env: Record<string, string | undefined>): { key: string; reason: string }[] {
  try {
    loadWorkerConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return [...e.issues];
    throw e;
  }
  return [];
}

describe("loadWorkerConfig", () => {
  it("env hợp lệ → trả cấu hình app + URL worker", () => {
    const c = loadWorkerConfig(valid);
    expect(c.workerDatabaseUrl).toBe(valid.WORKER_DATABASE_URL);
    expect(c.app.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it("thiếu / rỗng WORKER_DATABASE_URL → nêu tên biến", () => {
    for (const v of [undefined, ""]) {
      expect(issues({ ...valid, WORKER_DATABASE_URL: v }).map((i) => i.key)).toEqual(["WORKER_DATABASE_URL"]);
    }
  });

  it("URL worker sai dạng → lỗi nêu tên biến, không chứa giá trị", () => {
    try {
      loadWorkerConfig({ ...valid, WORKER_DATABASE_URL: "mysql://u:mat-khau-rieng@h/db" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("WORKER_DATABASE_URL");
      expect((e as Error).message).not.toContain("mat-khau-rieng");
    }
  });

  it("gộp lỗi của cả schema web và biến worker", () => {
    const keys = issues({ ...valid, WORKER_DATABASE_URL: undefined, S3_BUCKET: undefined }).map((i) => i.key);
    expect(keys.sort()).toEqual(["S3_BUCKET", "WORKER_DATABASE_URL"]);
  });

  it("env trống → mọi biến bắt buộc được liệt kê", () => {
    const keys = issues({}).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["APP_BASE_URL", "DATABASE_URL", "WORKER_DATABASE_URL"]));
  });

  describe("DB-SEC-003 — production: WORKER_DATABASE_URL tới máy khác cần sslmode=verify-full", () => {
    const prod = {
      ...valid,
      NODE_ENV: "production",
      SMTP_URL: "smtps://relay.example.test:465",
      CLAMD_HOST: "clamd",
      HM_PII_KEYS: `1:${Buffer.alloc(32, 7).toString("base64")}`,
      HM_PII_KEY_ID: "1",
      HM_PII_INDEX_KEY: Buffer.alloc(32, 9).toString("base64"),
      APP_BASE_URL: "https://hm.example.test",
      S3_ENDPOINT: "https://files.example.test",
    };

    it.each([
      "postgres://wk:bi-mat-wk@postgres:5432/db",
      "postgres://wk:bi-mat-wk@postgres:5432/db?sslmode=require",
      "postgres://wk:bi-mat-wk@postgres:5432/db?sslmode=verify-full&sslmode=no-verify",
      "postgres://wk:bi-mat-wk@localhost:5432/db?host=db.remote.example",
      "postgres:///db?host=10.0.0.5",
    ])("%s → lỗi nêu tên biến, không lộ mật khẩu", (url) => {
      const found = issues({ ...prod, WORKER_DATABASE_URL: url });
      expect(found.map((i) => i.key)).toEqual(["WORKER_DATABASE_URL"]);
      expect(JSON.stringify(found)).not.toContain("bi-mat-wk");
    });

    it("verify-full hoặc loopback → qua; ngoài production không bị siết", () => {
      expect(
        issues({ ...prod, WORKER_DATABASE_URL: "postgres://wk:x@postgres/db?sslmode=verify-full" }),
      ).toEqual([]);
      expect(issues(prod)).toEqual([]); // loopback (localhost) trong `valid`
      expect(issues({ ...valid, WORKER_DATABASE_URL: "postgres://wk:x@postgres/db" })).toEqual([]);
    });
  });
});
