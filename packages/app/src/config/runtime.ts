// A small schema for process/bootstrap helpers that run before the full server config exists.
// No server credentials are imported here; the browser has a separate constant-only entry point.
import { z } from "zod";
import { ConfigError } from "./error.ts";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),
  APP_VERSION: z.string().trim().min(1).max(100).optional(),
  BETTER_AUTH_TELEMETRY: z.string().optional(),
});

/** Only bootstrap code passes this to the full schema; all application reads use parsed config. */
export const runtimeEnvironment = (): Record<string, string | undefined> => process.env;

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = {
    // Next defines NEXT_RUNTIME/NODE_ENV at compile time. Keep literal property reads so its compiler can replace them;
    // reading the raw environment object loses that define in standalone builds and silently skips instrumentation.
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NEXT_RUNTIME: process.env.NEXT_RUNTIME,
    APP_VERSION: process.env.APP_VERSION,
    BETTER_AUTH_TELEMETRY: process.env.BETTER_AUTH_TELEMETRY,
  },
) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((i) => ({ key: String(i.path[0]), reason: "invalid configuration" })),
    );
  return Object.freeze({
    ...parsed.data,
    telemetryRequested: /^(1|true|yes|on)$/i.test(parsed.data.BETTER_AUTH_TELEMETRY ?? ""),
  });
}
