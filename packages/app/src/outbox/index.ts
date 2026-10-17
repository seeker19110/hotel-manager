// Điểm công khai của module `outbox` (ARC-MOD-005): module khác và `@hm/app` chỉ import qua tệp này.
export {
  InvalidJobPayloadError,
  OUTBOX_PAYLOAD_SCHEMAS,
  parseOutboxPayload,
} from "./payloads.ts";
