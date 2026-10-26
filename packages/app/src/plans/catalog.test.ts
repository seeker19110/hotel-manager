// T-2314 (D-130) — danh mục gói hợp lệ và là NGUỒN của hạn mức tần suất (pipeline lệnh, tải file, nhập liệu).
import { describe, expect, it } from "vitest";
import {
  FILE_UPLOAD_PER_MEMBER_PER_MINUTE,
  FILE_UPLOAD_PER_ORG_PER_MINUTE,
  IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE,
  IMPORT_UPLOAD_PER_ORG_PER_MINUTE,
} from "../http/rate-limit.ts";
import { COMMAND_MEMBER_QUOTA_PER_MINUTE, COMMAND_QUOTA_PER_MINUTE } from "../pipeline/index.ts";
import { DEFAULT_PLAN, isPlanId, PLAN_IDS, PLANS, planLimits } from "./index.ts";

describe("danh mục gói", () => {
  it("mỗi id có đúng một mục, gói mặc định nằm trong danh mục, id hợp lệ cho CHECK CSDL", () => {
    expect(new Set(PLAN_IDS).size).toBe(PLAN_IDS.length);
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_IDS].sort());
    expect(PLAN_IDS).toContain(DEFAULT_PLAN);
    for (const id of PLAN_IDS) expect(id).toMatch(/^[a-z][a-z0-9_]{1,30}$/);
  });

  it("mọi hạn mức là số nguyên dương an toàn; thành viên ≤ tổ chức", () => {
    for (const id of PLAN_IDS) {
      const p = PLANS[id];
      for (const v of [p.maxProperties, p.maxUnits, p.maxActiveMembers, p.maxStorageBytes]) {
        expect(Number.isSafeInteger(v), `${id}`).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      for (const r of [p.commandsPerMinute, p.fileUploadsPerMinute, p.importUploadsPerMinute]) {
        expect(Number.isSafeInteger(r.org) && Number.isSafeInteger(r.member)).toBe(true);
        expect(r.member).toBeGreaterThan(0);
        expect(r.member).toBeLessThanOrEqual(r.org);
      }
    }
  });

  it("pilot rộng hơn nhu cầu pilot thật (PROJECT.md: 1–5 cơ sở/chủ, ≥ 6 cơ sở pilot, bộ tải 5.000 phòng)", () => {
    const p = PLANS.pilot;
    expect(p.maxProperties).toBeGreaterThanOrEqual(6);
    expect(p.maxUnits).toBeGreaterThanOrEqual(5_000);
    expect(p.maxActiveMembers).toBeGreaterThanOrEqual(50);
    expect(p.maxStorageBytes).toBeGreaterThanOrEqual(10 * 1024 ** 3);
  });

  it("planLimits: gói biết ⇒ đúng mục; thiếu/lạ/null ⇒ gói mặc định", () => {
    expect(planLimits("pilot")).toBe(PLANS.pilot);
    for (const v of [undefined, null, "", "PILOT", "enterprise"])
      expect(planLimits(v)).toBe(PLANS[DEFAULT_PLAN]);
    expect(isPlanId("pilot")).toBe(true);
    expect(isPlanId(1)).toBe(false);
  });
});

describe("hạn mức tần suất đọc từ gói (giữ nguyên giá trị trước T-2314)", () => {
  it("hằng của pipeline lệnh và route tải file/nhập liệu = gói mặc định", () => {
    const p = PLANS[DEFAULT_PLAN];
    expect(COMMAND_QUOTA_PER_MINUTE).toBe(p.commandsPerMinute.org);
    expect(COMMAND_MEMBER_QUOTA_PER_MINUTE).toBe(p.commandsPerMinute.member);
    expect(FILE_UPLOAD_PER_ORG_PER_MINUTE).toBe(p.fileUploadsPerMinute.org);
    expect(FILE_UPLOAD_PER_MEMBER_PER_MINUTE).toBe(p.fileUploadsPerMinute.member);
    expect(IMPORT_UPLOAD_PER_ORG_PER_MINUTE).toBe(p.importUploadsPerMinute.org);
    expect(IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE).toBe(p.importUploadsPerMinute.member);
    // Giá trị trước khi chuyển sang gói — không đổi hành vi.
    expect([p.commandsPerMinute.org, p.commandsPerMinute.member]).toEqual([600, 200]);
    expect([p.fileUploadsPerMinute.org, p.fileUploadsPerMinute.member]).toEqual([120, 30]);
    expect([p.importUploadsPerMinute.org, p.importUploadsPerMinute.member]).toEqual([30, 10]);
  });
});
