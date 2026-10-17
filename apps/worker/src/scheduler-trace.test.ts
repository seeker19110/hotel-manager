// BASE-ERR-006 — mỗi lượt job định kỳ có trace riêng: log của job mang trace_id/span_id; hai lượt có trace_id khác nhau.
import { createLogger } from "@hm/app";
import { assertLogRecords } from "@hm/app/testing/log-schema";
import { describe, expect, it } from "vitest";
import { startScheduler } from "./scheduler.ts";

describe("scheduler — trace theo lượt (trace)", () => {
  it("log trong job, log job.done và job.failed đều có trace; mỗi lượt một trace_id mới; ngoài job không có", async () => {
    const lines: string[] = [];
    const log = createLogger({
      sink: { write: (l) => lines.push(l) },
      level: "debug",
      service: "hm-test",
      version: "0",
      env: "test",
    });
    const ac = new AbortController();
    let runs = 0;
    const s = startScheduler(
      [
        {
          name: "demo",
          everyMs: 1,
          run: async () => {
            runs += 1;
            log.info("trong job", { lan: runs });
            await new Promise((r) => setTimeout(r, 2));
            if (runs === 2) throw new Error("lượt hai lỗi");
            if (runs >= 3) ac.abort();
          },
        },
      ],
      { signal: ac.signal, log },
    );
    await s.stopped;
    log.info("sau scheduler");
    const recs = assertLogRecords(lines, 7);
    const inJob = recs.filter((r) => r.msg === "trong job");
    expect(inJob).toHaveLength(3);
    expect(new Set(inJob.map((r) => r.trace_id)).size).toBe(3);
    // job.done/job.failed cùng trace với log trong lượt của nó.
    const done = recs.filter((r) => r.msg === "job.done" || r.msg === "job.failed");
    expect(done.map((r) => r.trace_id)).toEqual(inJob.map((r) => r.trace_id));
    expect(done.map((r) => r.span_id)).toEqual(inJob.map((r) => r.span_id));
    expect(recs.find((r) => r.msg === "job.failed")).toBeDefined();
    expect(recs.at(-1)).not.toHaveProperty("trace_id");
  });
});
