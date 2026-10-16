// T-301 (không cần CSDL): lịch định kỳ có AbortSignal, xử lý tín hiệu SIGTERM/SIGINT, thiếu biến → exit ≠ 0 nêu tên biến.
import { EventEmitter } from "node:events";
import { createLogger } from "@hm/app";
import { describe, expect, it, vi } from "vitest";
import { installShutdown, type ProcessLike, runMain } from "./runtime.ts";
import { abortableSleep, startScheduler } from "./scheduler.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level: "debug", sink: { write: (l) => void lines.push(JSON.parse(l)) } });
  return { lines, log };
}

describe("scheduler", () => {
  it("chạy ngay, lặp theo chu kỳ, dừng khi abort và resolve sau khi lượt đang chạy xong", async () => {
    const { log } = capture();
    const ac = new AbortController();
    let runs = 0;
    let inflightDone = false;
    const s = startScheduler(
      [
        {
          name: "t",
          everyMs: 5,
          run: async () => {
            runs += 1;
            if (runs === 3) {
              ac.abort(); // abort giữa lượt: lượt này vẫn phải xong
              await new Promise((r) => setTimeout(r, 30));
              inflightDone = true;
            }
          },
        },
      ],
      { signal: ac.signal, log },
    );
    await s.stopped;
    expect(runs).toBe(3);
    expect(inflightDone).toBe(true);
  });

  it("một lượt lỗi chỉ ghi log, job vẫn chạy lượt sau; job khác không bị ảnh hưởng", async () => {
    const { log, lines } = capture();
    const ac = new AbortController();
    let bad = 0;
    let good = 0;
    const s = startScheduler(
      [
        {
          name: "bad",
          everyMs: 2,
          run: async () => {
            bad += 1;
            throw new Error("hỏng");
          },
        },
        {
          name: "good",
          everyMs: 2,
          run: async () => {
            good += 1;
            if (good >= 3) ac.abort();
          },
        },
      ],
      { signal: ac.signal, log },
    );
    await s.stopped;
    expect(bad).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.msg === "job.failed" && l.job === "bad")).toBe(true);
  });

  it("job không chồng lượt với chính nó", async () => {
    const { log } = capture();
    const ac = new AbortController();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const s = startScheduler(
      [
        {
          name: "slow",
          everyMs: 1,
          run: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 10));
            active -= 1;
            if (++runs >= 3) ac.abort();
          },
        },
      ],
      { signal: ac.signal, log },
    );
    await s.stopped;
    expect(maxActive).toBe(1);
  });

  it("abort trước khi bắt đầu → không chạy lượt nào; initialDelay bị abort cắt ngay", async () => {
    const { log } = capture();
    const ac = new AbortController();
    ac.abort();
    const run = vi.fn(async () => {});
    await startScheduler([{ name: "x", everyMs: 10, run }], { signal: ac.signal, log }).stopped;
    expect(run).not.toHaveBeenCalled();

    const ac2 = new AbortController();
    const t0 = Date.now();
    const s = startScheduler([{ name: "y", everyMs: 10, initialDelayMs: 60_000, run }], {
      signal: ac2.signal,
      log,
    });
    setTimeout(() => ac2.abort(), 10);
    await s.stopped;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("abortableSleep(0) và đã abort đều resolve", async () => {
    const ac = new AbortController();
    await abortableSleep(0, ac.signal);
    ac.abort();
    await abortableSleep(60_000, ac.signal);
  });
});

function fakeProcess(env: Record<string, string | undefined> = {}) {
  const ee = new EventEmitter();
  const stderr: string[] = [];
  const exit = vi.fn();
  const proc: ProcessLike = {
    env,
    on: (event, listener) => ee.on(event, listener as (...a: unknown[]) => void),
    exit: (code) => exit(code),
    stderr: { write: (s) => stderr.push(s) },
  };
  return { proc, ee, exit, stderr };
}

describe("installShutdown", () => {
  it("SIGTERM → shutdown một lần rồi exit(0); tín hiệu hai lần cũng chỉ shutdown một lần", async () => {
    const { log } = capture();
    const f = fakeProcess();
    let release: () => void = () => {};
    const shutdown = vi.fn(() => new Promise<void>((r) => (release = r)));
    installShutdown(f.proc, shutdown, log);
    f.ee.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(f.exit).not.toHaveBeenCalled(); // chưa xong thì chưa thoát
    release();
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
  });

  it("tín hiệu lần hai trong lúc đang dừng → exit(1) ngay, không chờ shutdown", () => {
    const { log, lines } = capture();
    const f = fakeProcess();
    installShutdown(f.proc, () => new Promise<void>(() => {}), log);
    f.ee.emit("SIGINT");
    expect(f.exit).not.toHaveBeenCalled();
    f.ee.emit("SIGINT");
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines.some((l) => l.msg === "worker.force_exit")).toBe(true);
  });

  it("shutdown lỗi → exit(1)", async () => {
    const { log } = capture();
    const f = fakeProcess();
    installShutdown(f.proc, async () => Promise.reject(new Error("đóng pool lỗi")), log);
    f.ee.emit("SIGTERM");
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(1));
  });
});

describe("runMain — cấu hình sai", () => {
  it("thiếu biến → exit(1), stderr nêu TÊN biến, không in giá trị bí mật", async () => {
    const f = fakeProcess({
      DATABASE_URL: "postgres://u:mat-khau-sieu-bi-mat@127.0.0.1:1/db",
      BETTER_AUTH_SECRET: "ngan", // quá ngắn
      // thiếu APP_BASE_URL, S3_*, WORKER_DATABASE_URL
    });
    await runMain(f.proc);
    expect(f.exit).toHaveBeenCalledWith(1);
    const out = f.stderr.join("");
    for (const name of ["APP_BASE_URL", "S3_ENDPOINT", "BETTER_AUTH_SECRET", "WORKER_DATABASE_URL"]) {
      expect(out).toContain(name);
    }
    expect(out).not.toContain("mat-khau-sieu-bi-mat");
    expect(out).not.toContain('ngan"');
  });

  it("chỉ thiếu WORKER_DATABASE_URL → báo đúng biến đó", async () => {
    const f = fakeProcess({
      APP_BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
      BETTER_AUTH_SECRET: "x".repeat(40),
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_BUCKET: "bucket-test",
      S3_ACCESS_KEY_ID: "a",
      S3_SECRET_ACCESS_KEY: "khoa-bi-mat-s3",
    });
    await runMain(f.proc);
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(f.stderr.join("")).toContain("WORKER_DATABASE_URL");
    expect(f.stderr.join("")).not.toContain("APP_BASE_URL");
  });
});
