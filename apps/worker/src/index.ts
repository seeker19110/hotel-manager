// Worker nền: outbox relay + consumer pg-boss + job định kỳ (ARCHITECTURE container apps/worker). Chạy thật: runtime.ts.
export {
  detectOverstay,
  expireHeldReservations,
  FakeEmailSender,
  generatePeriods,
  remindExpiring,
  runReminders,
  sendDueEmails,
} from "@hm/app";
export {
  bankTransactionReceivedHandler,
  expireExportsJob,
  expireHolds,
  exportHandlers,
  notifyHandlers,
  workerHeartbeat,
} from "./jobs.ts";
export { DEAD_LETTER_QUEUE, ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";
export {
  bootWorker,
  installShutdown,
  type RunningWorker,
  runMain,
  startWorker,
  type WorkerDeps,
} from "./runtime.ts";

import { runMain } from "./runtime.ts";

/** Khởi chạy worker thật từ `process` (env, tín hiệu, mã thoát). */
export function main(): Promise<void> {
  return runMain(process);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
