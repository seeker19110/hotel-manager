// Điểm công khai của module `config` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { type AppConfig, loadConfig } from "./schema.ts";
export {
  parseWebhookSecrets,
  WEBHOOK_SECRET_MAX_COUNT,
  WEBHOOK_SECRET_MIN_LENGTH,
} from "./webhook-secrets.ts";
