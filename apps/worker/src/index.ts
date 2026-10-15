// Worker nền: outbox relay + consumer pg-boss (ARCHITECTURE container apps/worker).
export { DEAD_LETTER_QUEUE, ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

export function main(): void {
  process.stdout.write(
    "hotel-manager worker: dùng relayOutbox/startConsumers (T-008); khởi chạy thật ở G5 staging\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
