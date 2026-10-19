// Chép stdout/stderr của tiến trình con ra terminal và tệp log (bộ quét PII đọc sau lượt E2E — CMP-PRIV-008).
// `closed` chỉ xong khi tiến trình con đã đóng stdio VÀ tệp log đã ghi hết: dừng server mà không chờ thì mất các dòng cuối.
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

export function teeChildLog(child: ChildProcess, file: string): { closed: Promise<void> } {
  const log = createWriteStream(file, { flags: "w" });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => log.end(resolve));
  });
  return { closed };
}

/** Chờ mọi tiến trình con đóng, tối đa `ms` (tiến trình treo không giữ server E2E mãi). true = đóng kịp. */
export async function waitClosed(closed: Promise<void>[], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.all(closed).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
