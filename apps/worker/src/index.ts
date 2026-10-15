// Worker nền (pg-boss consumer, outbox relay) — dựng thật ở T-008.
export function main(): void {
  process.stdout.write("hotel-manager worker: chưa có job (T-008)\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
