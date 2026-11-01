import { z } from "zod";
import { ConfigError } from "./error.ts";

const schema = z.object({ HM_BUILD_ID: z.string().min(1).max(200).optional() });
export function loadBuildConfig(
  env: Record<string, string | undefined> = {
    HM_BUILD_ID: process.env.HM_BUILD_ID,
  },
) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new ConfigError([{ key: "HM_BUILD_ID", reason: "invalid configuration" }]);
  return Object.freeze(parsed.data);
}
