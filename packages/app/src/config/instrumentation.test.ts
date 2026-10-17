// T-301: web validate env lúc khởi động qua `apps/web/instrumentation.ts` — chỉ ở runtime Node.js.
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../../../apps/web/instrumentation.ts";
import { ConfigError } from "./schema.ts";

const VALID = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:bi-mat-db@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "hotel-dev",
  S3_ACCESS_KEY_ID: "AKIA-TEST",
  S3_SECRET_ACCESS_KEY: "khoa-s3-bi-mat",
};
const KEYS = [...Object.keys(VALID), "NEXT_RUNTIME", "NODE_ENV", "CLAMD_HOST"];

function setEnv(env: Record<string, string>): void {
  for (const k of KEYS) vi.stubEnv(k, undefined as unknown as string);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("instrumentation register()", () => {
  it("runtime nodejs + env thiếu → ConfigError nêu tên biến, không lộ giá trị", async () => {
    setEnv({ NEXT_RUNTIME: "nodejs", DATABASE_URL: VALID.DATABASE_URL });
    const err = await register().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("APP_BASE_URL");
    expect((err as Error).message).toContain("S3_BUCKET");
    expect((err as Error).message).not.toContain("bi-mat-db");
  });

  it("runtime nodejs + env hợp lệ → không lỗi", async () => {
    setEnv({ NEXT_RUNTIME: "nodejs", ...VALID });
    await expect(register()).resolves.toBeUndefined();
  });

  it("runtime edge (hoặc không đặt) → bỏ qua, không đọc/validate env", async () => {
    setEnv({ NEXT_RUNTIME: "edge" });
    await expect(register()).resolves.toBeUndefined();
    setEnv({});
    await expect(register()).resolves.toBeUndefined();
  });
});
