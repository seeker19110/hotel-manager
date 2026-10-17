import { describe, expect, it } from "vitest";
import { vndInWords } from "./vnd-words.ts";

describe("vndInWords", () => {
  it.each([
    [0, "không đồng"],
    [1, "một đồng"],
    [5, "năm đồng"],
    [10, "mười đồng"],
    [15, "mười lăm đồng"],
    [21, "hai mươi mốt đồng"],
    [24, "hai mươi tư đồng"],
    [25, "hai mươi lăm đồng"],
    [105, "một trăm lẻ năm đồng"],
    [110, "một trăm mười đồng"],
    [1_000, "một nghìn đồng"],
    [1_580_000, "một triệu năm trăm tám mươi nghìn đồng"],
    [3_580_000, "ba triệu năm trăm tám mươi nghìn đồng"],
    [3_000_000, "ba triệu đồng"],
    [2_000_000, "hai triệu đồng"],
    [1_005_000, "một triệu không trăm lẻ năm nghìn đồng"],
    [1_000_001, "một triệu không trăm lẻ một đồng"],
    [100_000, "một trăm nghìn đồng"],
    [2_500_000_000, "hai tỷ năm trăm triệu đồng"],
  ])("%d → %s", (n, words) => {
    expect(vndInWords(n)).toBe(words);
  });

  it("âm / không nguyên / NaN → RangeError", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => vndInWords(bad)).toThrow(RangeError);
  });
});
