// Helper retry chung (ARC-RES-002, DB-TX-002): số lần, trần, jitter trong khoảng, không thử lại lỗi vĩnh viễn.
// RNG, đồng hồ và hàm chờ đều tiêm vào nên mọi khẳng định đều xác định (không ngủ thật).
import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  isTransientTxError,
  REQUEST_TX_RETRY,
  type RetryPolicy,
  retryAsync,
  spreadDelayMs,
  sqlState,
  WORKER_TX_RETRY,
} from "./retry.ts";

const POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 60_000 };
const pg = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

/** Đồng hồ giả: `sleep` đẩy đồng hồ tiến, ghi lại từng lần chờ. */
function fakeTime(start = 1_000) {
  let t = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

/** RNG tất định (LCG) ∈ [0, 1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("backoffDelayMs — lùi mũ + full jitter", () => {
  it("trần của lần chờ n là base·2^(n-1), bị cắt ở maxDelayMs; random=0 → 0, random→1 → sát trần", () => {
    const caps = [100, 200, 400, 800, 1_000, 1_000];
    caps.forEach((cap, i) => {
      expect(backoffDelayMs(i + 1, POLICY, () => 0)).toBe(0);
      expect(backoffDelayMs(i + 1, POLICY, () => 0.5)).toBe(cap / 2);
      expect(backoffDelayMs(i + 1, POLICY, () => 0.999999)).toBeLessThan(cap);
      expect(backoffDelayMs(i + 1, POLICY, () => 0.999999)).toBeGreaterThan(cap * 0.99);
    });
  });

  it("mọi giá trị ngẫu nhiên đều nằm trong [0, trần]; không có hai lần chờ giống hệt nhau cho mọi random (có phân tán)", () => {
    const rnd = lcg(42);
    const seen = new Set<number>();
    for (let n = 1; n <= 8; n++) {
      const cap = Math.min(POLICY.maxDelayMs, POLICY.baseDelayMs * 2 ** (n - 1));
      for (let i = 0; i < 500; i++) {
        const d = backoffDelayMs(n, POLICY, rnd);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(cap);
        seen.add(d);
      }
    }
    expect(seen.size).toBeGreaterThan(1_000);
  });

  it("minJitterRatio giữ phần tối thiểu: 0,5 → ∈ [0,5·trần, trần]; 1 → luôn đúng trần", () => {
    const half = { ...POLICY, minJitterRatio: 0.5 };
    expect(backoffDelayMs(2, half, () => 0)).toBe(100);
    expect(backoffDelayMs(2, half, () => 1)).toBe(200);
    expect(backoffDelayMs(2, { ...POLICY, minJitterRatio: 1 }, () => 0.3)).toBe(200);
  });

  it("random ngoài [0,1] bị kẹp (RNG lỗi không đẩy chờ ra ngoài trần)", () => {
    expect(backoffDelayMs(1, POLICY, () => 7)).toBe(100);
    expect(backoffDelayMs(1, POLICY, () => -3)).toBe(0);
  });

  it("base 0 → luôn 0; lần thử rất lớn không tràn (2^n vô hạn vẫn bị kẹp)", () => {
    expect(backoffDelayMs(3, { baseDelayMs: 0, maxDelayMs: 500 }, () => 0.9)).toBe(0);
    expect(backoffDelayMs(5_000, POLICY, () => 1)).toBe(1_000);
  });
});

describe("spreadDelayMs — jitter cộng lên, không sớm hơn mốc", () => {
  it("∈ [base, base·(1+ratio)]; random=0 → đúng mốc", () => {
    expect(spreadDelayMs(60_000, 0.2, () => 0)).toBe(60_000);
    expect(spreadDelayMs(60_000, 0.2, () => 0.5)).toBe(66_000);
    expect(spreadDelayMs(60_000, 0.2, () => 1)).toBe(72_000);
    const rnd = lcg(7);
    for (let i = 0; i < 500; i++) {
      const d = spreadDelayMs(300_000, 0.2, rnd);
      expect(d).toBeGreaterThanOrEqual(300_000);
      expect(d).toBeLessThanOrEqual(360_000);
    }
  });

  it("base 0 → 0; tham số sai → RangeError", () => {
    expect(spreadDelayMs(0, 0.5, () => 0.9)).toBe(0);
    expect(() => spreadDelayMs(-1, 0.2)).toThrow(RangeError);
    expect(() => spreadDelayMs(Number.NaN, 0.2)).toThrow(RangeError);
    expect(() => spreadDelayMs(1, -0.1)).toThrow(RangeError);
  });
});

describe("retryAsync — số lần và trần", () => {
  it("thành công ngay → đúng 1 lần chạy, không chờ", async () => {
    const tm = fakeTime();
    let calls = 0;
    const r = await retryAsync(
      async () => {
        calls++;
        return "ok";
      },
      { policy: POLICY, classify: () => true, sleep: tm.sleep, now: tm.now },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(1);
    expect(tm.waits).toEqual([]);
  });

  it("lỗi tạm 2 lần rồi thành công → 3 lần chạy, 2 lần chờ đúng công thức (random cố định)", async () => {
    const tm = fakeTime();
    const seen: number[] = [];
    const r = await retryAsync(
      async ({ attempt }) => {
        seen.push(attempt);
        if (attempt < 3) throw pg("40001");
        return attempt;
      },
      { policy: POLICY, classify: isTransientTxError, random: () => 0.5, sleep: tm.sleep, now: tm.now },
    );
    expect(r).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(tm.waits).toEqual([50, 100]); // 0,5·100 và 0,5·200
  });

  it("lỗi tạm mãi → đúng maxAttempts lần chạy rồi ném NGUYÊN lỗi cuối (không bọc)", async () => {
    const tm = fakeTime();
    let calls = 0;
    const last = pg("40P01");
    const err = await retryAsync(
      async () => {
        calls++;
        throw calls === POLICY.maxAttempts ? last : pg("40001");
      },
      { policy: POLICY, classify: isTransientTxError, random: () => 1, sleep: tm.sleep, now: tm.now },
    ).catch((e: unknown) => e);
    expect(err).toBe(last);
    expect(calls).toBe(4);
    expect(tm.waits).toHaveLength(3); // không chờ sau lần cuối
  });

  it("lỗi vĩnh viễn → KHÔNG thử lại, không chờ, ném ngay (cả khi còn nhiều lượt)", async () => {
    const tm = fakeTime();
    let calls = 0;
    const perm = Object.assign(new Error("duplicate key"), { code: "23505" });
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw perm;
        },
        { policy: POLICY, classify: isTransientTxError, sleep: tm.sleep, now: tm.now },
      ),
    ).rejects.toBe(perm);
    expect(calls).toBe(1);
    expect(tm.waits).toEqual([]);
  });

  it("không có classify → mặc định an toàn: không lỗi nào được thử lại", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw pg("40001");
        },
        { policy: POLICY },
      ),
    ).rejects.toThrow("pg 40001");
    expect(calls).toBe(1);
  });

  it("lần chạy đầu lỗi tạm nhưng lần sau lỗi vĩnh viễn → dừng ở lỗi vĩnh viễn", async () => {
    const tm = fakeTime();
    let calls = 0;
    const perm = new Error("422");
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw calls === 1 ? pg("40001") : perm;
        },
        { policy: POLICY, classify: isTransientTxError, sleep: tm.sleep, now: tm.now },
      ),
    ).rejects.toBe(perm);
    expect(calls).toBe(2);
    expect(tm.waits).toHaveLength(1);
  });

  it("maxAttempts = 1 → không thử lại dù lỗi tạm", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw pg("40001");
        },
        { policy: { ...POLICY, maxAttempts: 1 }, classify: isTransientTxError },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("giá trị ném không phải Error (chuỗi/null) vẫn đi qua đúng nguyên dạng", async () => {
    await expect(
      retryAsync(async () => Promise.reject("lỗi chuỗi"), { policy: POLICY, classify: () => false }),
    ).rejects.toBe("lỗi chuỗi");
    const tm = fakeTime();
    let n = 0;
    await expect(
      retryAsync(
        async () => {
          n++;
          return Promise.reject(null);
        },
        { policy: { ...POLICY, maxAttempts: 2 }, classify: () => true, sleep: tm.sleep, now: tm.now },
      ),
    ).rejects.toBeNull();
    expect(n).toBe(2);
  });
});

describe("retryAsync — trần thời gian", () => {
  it("chờ xong không còn đủ thời gian trong maxElapsedMs → bỏ cuộc sớm, không ngủ vô ích", async () => {
    const tm = fakeTime();
    let calls = 0;
    const err = await retryAsync(
      async () => {
        calls++;
        tm.advance(300); // mỗi lần chạy tốn 300 ms
        throw pg("40001");
      },
      {
        policy: { ...POLICY, maxElapsedMs: 1_000, baseDelayMs: 400, maxDelayMs: 400 },
        classify: isTransientTxError,
        random: () => 1, // chờ đúng 400 ms
        sleep: tm.sleep,
        now: tm.now,
      },
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("pg 40001");
    // lần 1: t=300, còn 700 > 400 → chờ; lần 2: t=1000 (300+400+300) còn 0 ≤ 400 → dừng.
    expect(calls).toBe(2);
    expect(tm.waits).toEqual([400]);
  });

  it("maxElapsedMs = 0 → chạy đúng một lần rồi bỏ cuộc (không thử lại)", async () => {
    const tm = fakeTime();
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw pg("40001");
        },
        {
          policy: { ...POLICY, maxElapsedMs: 0 },
          classify: isTransientTxError,
          random: () => 0.5,
          sleep: tm.sleep,
          now: tm.now,
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(tm.waits).toEqual([]);
  });

  it("remainingMs giảm dần theo đồng hồ để người gọi cắt timeout từng lần", async () => {
    const tm = fakeTime();
    const remaining: number[] = [];
    await retryAsync(
      async ({ attempt, remainingMs }) => {
        remaining.push(remainingMs);
        if (attempt < 3) throw pg("40001");
      },
      {
        policy: { ...POLICY, maxElapsedMs: 5_000 },
        classify: isTransientTxError,
        random: () => 1,
        sleep: tm.sleep,
        now: tm.now,
      },
    );
    expect(remaining).toEqual([5_000, 4_900, 4_700]); // sau chờ 100 rồi 200
  });

  it("giveUp đổi lỗi cuối theo lý do: hết lượt vs hết thời gian", async () => {
    const tm = fakeTime();
    const why: string[] = [];
    const opts = {
      classify: isTransientTxError,
      random: () => 1,
      sleep: tm.sleep,
      now: tm.now,
      giveUp: (e: unknown, reason: "attempts" | "budget") => {
        why.push(reason);
        return new Error(`${reason}:${(e as Error).message}`);
      },
    };
    await expect(
      retryAsync(() => Promise.reject(pg("40001")), { ...opts, policy: { ...POLICY, maxAttempts: 2 } }),
    ).rejects.toThrow("attempts:pg 40001");
    await expect(
      retryAsync(() => Promise.reject(pg("40001")), { ...opts, policy: { ...POLICY, maxElapsedMs: 50 } }),
    ).rejects.toThrow("budget:pg 40001");
    expect(why).toEqual(["attempts", "budget"]);
  });
});

describe("retryAsync — Retry-After và onRetry", () => {
  it("gợi ý retryAfterMs đẩy chờ lên (nhưng bị cắt ở maxDelayMs); nhỏ hơn jitter thì giữ jitter", async () => {
    const tm = fakeTime();
    const hints = [5_000, 10, 0];
    let i = 0;
    await retryAsync(
      async ({ attempt }) => {
        if (attempt <= 3) {
          const retryAfterMs = hints[i++] as number;
          throw Object.assign(new Error("429"), { retryAfterMs });
        }
      },
      {
        policy: POLICY,
        classify: (e) => ({ retryAfterMs: (e as { retryAfterMs: number }).retryAfterMs }),
        random: () => 0.5,
        sleep: tm.sleep,
        now: tm.now,
      },
    );
    // lần 1: max(50, 5000) cắt 1000 · lần 2: max(100, 10) = 100 · lần 3: max(200, 0) = 200
    expect(tm.waits).toEqual([1_000, 100, 200]);
  });

  it("onRetry nhận số lần, thời gian chờ và lỗi; không gọi khi thành công/lỗi vĩnh viễn", async () => {
    const tm = fakeTime();
    const infos: { attempt: number; delayMs: number; error: unknown }[] = [];
    const e1 = pg("40001");
    await retryAsync(
      async ({ attempt }) => {
        if (attempt === 1) throw e1;
      },
      {
        policy: POLICY,
        classify: isTransientTxError,
        random: () => 0.25,
        sleep: tm.sleep,
        now: tm.now,
        onRetry: (i) => infos.push(i),
      },
    );
    expect(infos).toEqual([{ attempt: 1, delayMs: 25, error: e1 }]);
    infos.length = 0;
    await retryAsync(async () => 1, { policy: POLICY, onRetry: (i) => infos.push(i) });
    await retryAsync(() => Promise.reject(new Error("x")), {
      policy: POLICY,
      onRetry: (i) => infos.push(i),
    }).catch(() => {});
    expect(infos).toEqual([]);
  });
});

describe("retryAsync — chính sách không hợp lệ bị từ chối ngay", () => {
  it.each([
    ["maxAttempts = 0", { maxAttempts: 0 }],
    ["maxAttempts không nguyên", { maxAttempts: 2.5 }],
    ["maxAttempts âm", { maxAttempts: -1 }],
    ["baseDelayMs NaN", { baseDelayMs: Number.NaN }],
    ["maxDelayMs âm", { maxDelayMs: -1 }],
    ["maxElapsedMs vô hạn", { maxElapsedMs: Number.POSITIVE_INFINITY }],
    ["minJitterRatio > 1", { minJitterRatio: 1.5 }],
    ["minJitterRatio âm", { minJitterRatio: -0.1 }],
  ])("%s → RangeError, không chạy fn", async (_n, bad) => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
        },
        { policy: { ...POLICY, ...bad } },
      ),
    ).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });
});

describe("phân loại lỗi transaction (SQLSTATE)", () => {
  it("40001 và 40P01 là tạm thời; mã khác, thiếu mã, giá trị lạ là vĩnh viễn", () => {
    expect(isTransientTxError(pg("40001"))).toBe(true);
    expect(isTransientTxError(pg("40P01"))).toBe(true);
    for (const code of ["23505", "23503", "42P01", "57014", "08006", "55P03", "40002", "40p01", ""])
      expect(isTransientTxError(pg(code))).toBe(false);
    expect(isTransientTxError(new Error("không có code"))).toBe(false);
    expect(isTransientTxError(undefined)).toBe(false);
    expect(isTransientTxError(null)).toBe(false);
    expect(isTransientTxError("40001")).toBe(false);
    expect(isTransientTxError({ code: 40001 })).toBe(false);
  });

  it("đọc mã ở `cause` (lỗi bọc), có giới hạn độ sâu (vòng tham chiếu không treo)", () => {
    expect(sqlState(new Error("bọc", { cause: pg("40001") }))).toBe("40001");
    expect(isTransientTxError(new Error("bọc", { cause: pg("40P01") }))).toBe(true);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(sqlState(loop)).toBeUndefined();
  });
});

describe("chính sách mặc định có trần rõ ràng", () => {
  it.each([
    ["REQUEST_TX_RETRY", REQUEST_TX_RETRY],
    ["WORKER_TX_RETRY", WORKER_TX_RETRY],
  ])("%s: hữu hạn, hợp lệ, tổng thời gian chờ tối đa ≤ maxElapsedMs", async (_n, p) => {
    const tm = fakeTime();
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw pg("40001");
        },
        { policy: p, classify: isTransientTxError, random: () => 1, sleep: tm.sleep, now: tm.now },
      ),
    ).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(p.maxAttempts);
    expect(tm.waits.reduce((a, b) => a + b, 0)).toBeLessThan(p.maxElapsedMs);
    expect(Math.max(...tm.waits)).toBeLessThanOrEqual(p.maxDelayMs);
  });
});
