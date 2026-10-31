// Request-origin/CSP config without importing the Node server schema or any credentials.
import { z } from "zod";
import { ConfigError } from "./error.ts";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url().optional(),
});

export function loadProxyConfig(
  fallbackOrigin: string,
  env: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    APP_BASE_URL: process.env.APP_BASE_URL,
  },
) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((i) => ({ key: String(i.path[0]), reason: "invalid configuration" })),
    );
  if (parsed.data.NODE_ENV === "production" && !parsed.data.APP_BASE_URL)
    throw new ConfigError([{ key: "APP_BASE_URL", reason: "required in production" }]);
  return Object.freeze({
    appBaseUrl: parsed.data.APP_BASE_URL ?? z.url().parse(fallbackOrigin),
    dev: parsed.data.NODE_ENV !== "production",
  });
}
