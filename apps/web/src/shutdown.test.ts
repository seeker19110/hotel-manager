// T-402 — mức handler của dừng êm (lib/shutdown.ts) với `process` giả: cờ draining, bọc handler của Next, đổi mã 143 → 0, hạn chót.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAIN_NOTICE_MS,
  installShutdownHandler,
  isDraining,
  type ProcessLike,
  resetShutdownForTest,
  SHUTDOWN_DEADLINE_MS,
  STOP_GRACE_PERIOD_SECONDS,
} from "../lib/shutdown.ts";

type L = (s: NodeJS.Signals) => void;

function fakeProc(inherited: L[] = []) {
  const sigterm: L[] = [...inherited];
  const exits: (number | undefined)[] = [];
  let onExit: (() => void) | undefined;
  const proc: ProcessLike = {
    listeners: () => [...sigterm],
    off: (_e, l) => void sigterm.splice(sigterm.indexOf(l), 1),
    on: (_e, l) => void sigterm.push(l),
    once: (_e, l) => {
      onExit = l;
    },
    exit: (code?: number) => {
      exits.push(code);
    },
    exitCode: undefined,
  };
  return {
    proc,
    sigterm,
    exits,
    fire: () => {
      for (const l of [...sigterm]) l("SIGTERM");
    },
    runExitHooks: () => onExit?.(),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

afterEach(() => resetShutdownForTest());

describe("hằng số", () => {
  it("thời gian báo + chờ nằm dưới stop_grace_period với biên ≥ 10 s", () => {
    expect(DRAIN_NOTICE_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS + 10_000).toBeLessThanOrEqual(STOP_GRACE_PERIOD_SECONDS * 1000);
  });

  it("MỘT giá trị stop_grace_period: Dockerfile web + RUNBOOK + shutdown.ts khớp STOP_GRACE_PERIOD_SECONDS (review đợt 5, mục 3)", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    const grace = (text: string, anchor: RegExp) => {
      const lines = text.split("\n").filter((l) => anchor.test(l));
      return lines.flatMap((l) => [...l.matchAll(/≥\s*(\d+)\s*giây/g)].map((m) => Number(m[1])));
    };
    const docker = grace(read("../../../deploy/web.Dockerfile"), /stop_grace_period/);
    const runbook = grace(read("../../../docs/RUNBOOK.md"), /Web dừng êm/);
    const source = grace(read("../lib/shutdown.ts"), /stop_grace_period/);
    expect(docker).toEqual([STOP_GRACE_PERIOD_SECONDS]);
    expect(runbook).toEqual([STOP_GRACE_PERIOD_SECONDS]);
    expect(source).toEqual([STOP_GRACE_PERIOD_SECONDS]);
  });
});

describe("installShutdownHandler", () => {
  it("SIGTERM: cờ draining bật NGAY; handler gốc của Next chưa chạy trong thời gian báo, rồi chạy đúng một lần", async () => {
    const calls: string[] = [];
    const f = fakeProc([(s) => void calls.push(s)]);
    installShutdownHandler(f.proc, { noticeMs: 60, deadlineMs: 5_000, log: quiet });
    expect(isDraining()).toBe(false);
    expect(f.sigterm).toHaveLength(1); // handler gốc đã được thay bằng handler mới
    f.fire();
    expect(isDraining()).toBe(true);
    await wait(20);
    expect(calls).toEqual([]);
    await wait(80);
    expect(calls).toEqual(["SIGTERM"]);
    f.fire(); // lần hai ⇒ thoát ngay mã 1, không gọi handler gốc lần nữa
    expect(f.exits).toEqual([1]);
    expect(calls).toEqual(["SIGTERM"]);
  });

  it("Next thoát 143 ⇒ đổi thành 0; mã khác giữ nguyên", () => {
    const f = fakeProc([() => {}]);
    installShutdownHandler(f.proc, { noticeMs: 10_000, deadlineMs: 20_000, log: quiet });
    f.fire();
    f.proc.exitCode = 143;
    f.runExitHooks();
    expect(f.proc.exitCode).toBe(0);
    f.proc.exitCode = 1;
    f.runExitHooks();
    expect(f.proc.exitCode).toBe(1);
  });

  it("request kẹt quá hạn chót ⇒ log web.shutdown_timeout rồi thoát 0", async () => {
    const events: string[] = [];
    const f = fakeProc([() => {}]);
    installShutdownHandler(f.proc, { noticeMs: 10, deadlineMs: 80, log: (e) => void events.push(e) });
    f.fire();
    await wait(30);
    expect(f.exits).toEqual([]);
    await wait(100);
    expect(f.exits).toEqual([0]);
    expect(events).toEqual(["web.shutdown_started", "web.shutdown_timeout"]);
  });

  it("không có handler gốc (NEXT_MANUAL_SIG_HANDLE) ⇒ hết thời gian báo thì thoát 0", async () => {
    const events: string[] = [];
    const f = fakeProc([]);
    installShutdownHandler(f.proc, { noticeMs: 20, deadlineMs: 5_000, log: (e) => void events.push(e) });
    f.fire();
    await wait(60);
    expect(f.exits).toEqual([0]);
    expect(events).toContain("web.shutdown_no_server_handler");
  });

  it("cài hai lần chỉ có một handler (idempotent)", () => {
    const f = fakeProc([() => {}]);
    installShutdownHandler(f.proc, { log: quiet });
    installShutdownHandler(f.proc, { log: quiet });
    expect(f.sigterm).toHaveLength(1);
  });
});
