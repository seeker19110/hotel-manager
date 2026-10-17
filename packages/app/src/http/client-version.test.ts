// SPEC-pwa S-009 (phần thuần): so phiên bản client với mức tối thiểu — ca biên null/rỗng/sai định dạng/số lớn.
import { describe, expect, it } from "vitest";
import { compareVersions, isClientOutdated, parseVersion } from "./client-version.ts";

describe("parseVersion", () => {
  it("nhận semver (bỏ tiền phát hành/build), từ chối phần còn lại", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" 0.1.0 ")).toEqual([0, 1, 0]);
    expect(parseVersion("2.0.0-rc.1+build.7")).toEqual([2, 0, 0]);
    for (const bad of [
      "",
      "1",
      "1.2",
      "v1.2.3",
      "1.2.3.4",
      "a.b.c",
      "1.2.x",
      "-1.0.0",
      "1.2.3 4",
      "１.２.３",
    ])
      expect(parseVersion(bad), bad).toBeNull();
  });
  it("số quá dài bị từ chối (không tràn số)", () => {
    expect(parseVersion("1234567890.0.0")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("so theo major rồi minor rồi patch, không so chuỗi (1.10.0 > 1.9.0)", () => {
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0);
  });
});

describe("isClientOutdated", () => {
  it("thấp hơn mức tối thiểu ⇒ quá cũ; bằng hoặc cao hơn ⇒ không", () => {
    expect(isClientOutdated("0.9.9", "1.0.0")).toBe(true);
    expect(isClientOutdated("1.0.0", "1.0.0")).toBe(false);
    expect(isClientOutdated("1.0.1", "1.0.0")).toBe(false);
    expect(isClientOutdated("1.9.0", "1.10.0")).toBe(true);
  });
  it("không gửi header (null/undefined) ⇒ không kiểm", () => {
    expect(isClientOutdated(null, "1.0.0")).toBe(false);
    expect(isClientOutdated(undefined, "1.0.0")).toBe(false);
  });
  it("có header nhưng sai định dạng hoặc rỗng ⇒ coi là quá cũ", () => {
    expect(isClientOutdated("", "1.0.0")).toBe(true);
    expect(isClientOutdated("latest", "1.0.0")).toBe(true);
  });
  it("mức tối thiểu thiếu/sai ⇒ không khoá ai", () => {
    expect(isClientOutdated("0.0.1", undefined)).toBe(false);
    expect(isClientOutdated("0.0.1", "")).toBe(false);
    expect(isClientOutdated("0.0.1", "không-phải-semver")).toBe(false);
  });
});
