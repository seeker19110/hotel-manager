// Cấu hình gói (IND-SAAS-008, D-123): nhất quán, đủ rộng cho gói mặc định, khớp hằng của pipeline.
import { describe, expect, it } from "vitest";
import { COMMAND_QUOTA_PER_MINUTE } from "../pipeline/index.ts";
import { DEFAULT_PLAN_ID, jobGroupConcurrency, PLANS, planFor } from "./plans.ts";

describe("PLANS", () => {
  it("mọi hạn mức là số nguyên dương", () => {
    for (const p of Object.values(PLANS)) {
      for (const k of ["properties", "rooms", "members", "commandsPerMinute", "jobConcurrency"] as const) {
        expect(Number.isInteger(p[k]) && p[k] > 0, `${p.id}.${k}`).toBe(true);
      }
    }
  });
  it("id khớp khoá; gói free chặt hơn standard ở mọi chiều", () => {
    for (const [k, p] of Object.entries(PLANS)) expect(p.id).toBe(k);
    for (const k of ["properties", "rooms", "members", "commandsPerMinute", "jobConcurrency"] as const) {
      expect(PLANS.free[k]).toBeLessThanOrEqual(PLANS.standard[k]);
    }
  });
  it("planFor: mọi tổ chức (kể cả id rỗng/lạ) dùng gói mặc định standard", () => {
    expect(DEFAULT_PLAN_ID).toBe("standard");
    expect(planFor("00000000-0000-0000-0000-000000000000")).toBe(PLANS.standard);
    expect(planFor("")).toBe(PLANS.standard);
  });
  it("hằng lệnh/phút của pipeline khớp gói mặc định", () => {
    expect(COMMAND_QUOTA_PER_MINUTE).toBe(PLANS.standard.commandsPerMinute);
  });
  it("jobGroupConcurrency: mặc định = gói mặc định, mỗi bậc = gói tương ứng", () => {
    const c = jobGroupConcurrency();
    expect(c.default).toBe(PLANS.standard.jobConcurrency);
    expect(c.tiers).toEqual({ free: PLANS.free.jobConcurrency, standard: PLANS.standard.jobConcurrency });
  });
});
