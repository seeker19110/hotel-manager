import { describe, expect, it } from "vitest";
import { blankToNull, firstNonBlank, keepIfUndefined } from "./optional.ts";

describe("blankToNull — thiếu / rỗng / 0 (BASE-DATA-003)", () => {
  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["   ", null],
    ["\t\n", null],
  ])("%j → null", (raw, want) => {
    expect(blankToNull(raw)).toBe(want);
  });

  it('giữ "0" và "false" (chuỗi có nội dung, không phải rỗng)', () => {
    expect(blankToNull("0")).toBe("0");
    expect(blankToNull(" false ")).toBe("false");
  });

  it("trim hai đầu, giữ nguyên Unicode tiếng Việt (không đổi dạng NFC/NFD)", () => {
    const nfd = "Nguyễn";
    expect(blankToNull(`  ${nfd} `)).toBe(nfd);
    expect(blankToNull(" Đặng Văn A ")).toBe("Đặng Văn A");
  });
});

describe("firstNonBlank", () => {
  it("bỏ qua thiếu/rỗng, lấy giá trị có nội dung đầu tiên", () => {
    expect(firstNonBlank(undefined, null, "", "  ", " b ", "c")).toBe("b");
  });
  it("không có giá trị dùng được (kể cả không đối số) → null", () => {
    expect(firstNonBlank()).toBeNull();
    expect(firstNonBlank("", " ", null)).toBeNull();
  });
  it('"0" là giá trị thật', () => {
    expect(firstNonBlank("", "0", "x")).toBe("0");
  });
});

describe('keepIfUndefined — undefined giữ, null/0/""/false là giá trị gửi', () => {
  it("undefined → giữ giá trị hiện có", () => {
    expect(keepIfUndefined(undefined, "14:00")).toBe("14:00");
    expect(keepIfUndefined(undefined, null)).toBeNull();
  });
  it("null → xoá (không rơi về giá trị hiện có)", () => {
    expect(keepIfUndefined<string | null>(null, "14:00")).toBeNull();
  });
  it("0, chuỗi rỗng, false được dùng nguyên", () => {
    expect(keepIfUndefined(0, 5)).toBe(0);
    expect(keepIfUndefined("", "x")).toBe("");
    expect(keepIfUndefined(false, true)).toBe(false);
  });
});
