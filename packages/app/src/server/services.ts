// Dịch vụ ngoài CSDL mà command/query cần (khoá PII, …) — dựng một lần từ cấu hình đã validate, tiêm qua HttpDeps.
import { invitationKey } from "../access/index.ts";
import type { AppConfig } from "../config/index.ts";
import { createPiiCipher, devKeyring, type PiiCipher, parseKeyring } from "../crypto/index.ts";
import { clamdScanner, eicarOnlyScanner, type MalwareScanner, ObjectStorage } from "../files/index.ts";

export interface AppServices {
  invitationKey: Buffer;
  pii: PiiCipher;
  scanner: MalwareScanner;
  storage: ObjectStorage;
}

export function createServices(config: AppConfig): AppServices {
  const ring =
    config.HM_PII_KEYS && config.HM_PII_KEY_ID && config.HM_PII_INDEX_KEY
      ? parseKeyring(config.HM_PII_KEYS, config.HM_PII_KEY_ID, config.HM_PII_INDEX_KEY)
      : devKeyring();
  return {
    invitationKey: invitationKey(config.BETTER_AUTH_SECRET),
    pii: createPiiCipher(ring),
    // Schema env đã bắt CLAMD_HOST ở production; bản giả chỉ cho dev/test.
    scanner: config.CLAMD_HOST
      ? clamdScanner({ host: config.CLAMD_HOST, port: config.CLAMD_PORT })
      : eicarOnlyScanner,
    storage: new ObjectStorage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    }),
  };
}

/** Dịch vụ cho test/dev: khoá dẫn xuất công khai; storage truyền vào (S3 test của testkit) hoặc trỏ địa chỉ không dùng. */
export function testServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    invitationKey: invitationKey("khoa-thu-nghiem-khong-dung-o-production-0123456789"),
    pii: createPiiCipher(devKeyring()),
    scanner: eicarOnlyScanner,
    storage: new ObjectStorage({
      endpoint: "http://127.0.0.1:9",
      region: "test",
      bucket: "unused",
      accessKeyId: "unused",
      secretAccessKey: "unused-unused",
    }),
    ...overrides,
  };
}
