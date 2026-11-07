// SPEC-runtime S-002/S-003: edge/build/client separation and schema-controlled environment reads.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";
import { loadBuildConfig } from "./build.ts";
import { loadProxyConfig } from "./edge.ts";
import { ConfigError } from "./error.ts";
import { loadRuntimeConfig } from "./runtime.ts";

afterEach(() => vi.unstubAllEnvs());

describe("T-2620 (AUD-CFG-003): APP_VERSION rỗng = chưa đặt", () => {
  it("chuỗi rỗng/chỉ khoảng trắng không làm loadRuntimeConfig ném; giá trị thật vẫn được trim; quá dài vẫn bị từ chối", () => {
    expect(loadRuntimeConfig({ APP_VERSION: "" }).APP_VERSION).toBeUndefined();
    expect(loadRuntimeConfig({ APP_VERSION: "   " }).APP_VERSION).toBeUndefined();
    expect(loadRuntimeConfig({ APP_VERSION: " 1.2.3 " }).APP_VERSION).toBe("1.2.3");
    expect(() => loadRuntimeConfig({ APP_VERSION: "x".repeat(101) })).toThrow(ConfigError);
  });
});

describe("runtime env configuration boundaries", () => {
  it("validates bootstrap flags without requiring DB/auth/storage credentials", () => {
    expect(loadRuntimeConfig({})).toMatchObject({ NODE_ENV: "development", telemetryRequested: false });
    expect(
      loadRuntimeConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        NEXT_RUNTIME: "nodejs",
        APP_VERSION: " 1.2.3 ",
      }),
    ).toMatchObject({ NODE_ENV: "test", LOG_LEVEL: "warn", NEXT_RUNTIME: "nodejs", APP_VERSION: "1.2.3" });
    for (const truth of ["1", "TRUE", "yes", "on"])
      expect(loadRuntimeConfig({ BETTER_AUTH_TELEMETRY: truth }).telemetryRequested).toBe(true);
    expect(loadRuntimeConfig({ BETTER_AUTH_TELEMETRY: "false" }).telemetryRequested).toBe(false);
  });

  it.each(["NODE_ENV", "LOG_LEVEL", "NEXT_RUNTIME"])(
    "invalid %s reports the name without its value",
    (key) => {
      try {
        loadRuntimeConfig({ [key]: "private-invalid-value" });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(key);
        expect((err as Error).message).not.toContain("private-invalid-value");
      }
    },
  );

  it("proxy uses the configured canonical origin; only development can fall back to request origin", () => {
    expect(loadProxyConfig("http://localhost", {})).toEqual({ appBaseUrl: "http://localhost", dev: true });
    expect(
      loadProxyConfig("https://untrusted.test", {
        NODE_ENV: "production",
        APP_BASE_URL: "https://hotel.test",
      }),
    ).toEqual({ appBaseUrl: "https://hotel.test", dev: false });
    expect(() => loadProxyConfig("https://untrusted.test", { NODE_ENV: "production" })).toThrow(
      "APP_BASE_URL",
    );
    expect(() => loadProxyConfig("http://localhost", { APP_BASE_URL: "private-invalid-value" })).toThrow(
      "APP_BASE_URL",
    );
    vi.stubEnv("APP_BASE_URL", "https://from-env.test");
    expect(loadProxyConfig("https://untrusted.test").appBaseUrl).toBe("https://from-env.test");
  });

  it("build has no dependency on runtime secrets and validates the optional offline revision", () => {
    expect(loadBuildConfig({})).toEqual({});
    expect(loadBuildConfig({ HM_BUILD_ID: "release-123", DATABASE_URL: "not-read" })).toEqual({
      HM_BUILD_ID: "release-123",
    });
    expect(() => loadBuildConfig({ HM_BUILD_ID: "" })).toThrow("HM_BUILD_ID");
    vi.stubEnv("HM_BUILD_ID", "from-env");
    expect(loadBuildConfig()).toEqual({ HM_BUILD_ID: "from-env" });
  });

  it("the client config is only the public production flag, without server imports or secret names", () => {
    const text = readFileSync(`${REPO_ROOT}packages/app/src/config/client.ts`, "utf8");
    expect(text).toContain('process.env.NODE_ENV === "production"');
    expect(text).not.toMatch(
      /^\s*import\b|DATABASE_URL|BETTER_AUTH_SECRET|S3_SECRET|process\.env(?!\.NODE_ENV)/m,
    );
  });

  it("application environment reads stay inside config; tools/tests and framework build config have separate entry points", () => {
    const files = sourceFiles(
      ["packages/app/src", "apps/web/app", "apps/web/components", "apps/web/lib"],
      /\.(ts|tsx)$/,
    );
    const entryPoints = ["apps/web/proxy.ts", "apps/web/instrumentation.ts"].map((path) => ({
      path,
      text: readFileSync(`${REPO_ROOT}${path}`, "utf8"),
    }));
    const hits = [...files, ...entryPoints]
      .filter(
        (f) =>
          !f.path.startsWith("packages/app/src/config/") &&
          /\bprocess\s*(?:\.\s*env|\[\s*["']env["']\s*\])/.test(f.text),
      )
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
