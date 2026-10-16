// Dịch vụ ngoài CSDL mà command/query cần (khoá PII, …) — dựng một lần từ cấu hình đã validate, tiêm qua HttpDeps.
import type { AppConfig } from "../config/schema.ts";
import { createPiiCipher, devKeyring, type PiiCipher, parseKeyring } from "../crypto/pii.ts";

export interface AppServices {
  pii: PiiCipher;
}

export function createServices(config: AppConfig): AppServices {
  const ring =
    config.HM_PII_KEYS && config.HM_PII_KEY_ID && config.HM_PII_INDEX_KEY
      ? parseKeyring(config.HM_PII_KEYS, config.HM_PII_KEY_ID, config.HM_PII_INDEX_KEY)
      : devKeyring();
  return { pii: createPiiCipher(ring) };
}

/** Dịch vụ cho test/dev: khoá dẫn xuất công khai. */
export function testServices(overrides: Partial<AppServices> = {}): AppServices {
  return { pii: createPiiCipher(devKeyring()), ...overrides };
}
