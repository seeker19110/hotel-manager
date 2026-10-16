// Worker nền: outbox relay + consumer pg-boss (ARCHITECTURE container apps/worker).
export { detectOverstay, generatePeriods, remindExpiring } from "@hm/app";
export {
  bankTransactionReceivedHandler,
  expireHolds,
  NOTIFY_SEND_CRON,
  NOTIFY_SEND_QUEUE,
  notificationEventHandlers,
  RETENTION_CRON,
  RETENTION_QUEUE,
  scheduleNotificationSend,
  scheduleRetention,
  startNotificationSendWorker,
  startRetentionWorker,
} from "./jobs.ts";
export { DEAD_LETTER_QUEUE, ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

export function main(): void {
  process.stdout.write(
    "hotel-manager worker: dùng relayOutbox/startConsumers (T-008); khởi chạy thật ở G5 staging\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
