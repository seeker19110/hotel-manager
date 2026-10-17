// Rào cho lỗi lặp (E2E đỏ vì 429 của Better Auth ở /sign-in, 3 lần trong đợt 7): spec E2E bấm "Đăng nhập" phải qua
// `signInClick` (e2e/sign-in.ts — đợi hết cửa sổ giới hạn rồi bấm lại), không bấm nút trực tiếp.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const E2E = join(import.meta.dirname, "..", "e2e");

describe("E2E đăng nhập qua giao diện chịu được 429", () => {
  it("không file nào trong e2e/ (trừ sign-in.ts) bấm thẳng nút 'Đăng nhập'", () => {
    const direct = /getByRole\("button", \{ name: "Đăng nhập" \}\)\.click\(/;
    const bad = readdirSync(E2E)
      .filter((f) => f.endsWith(".ts") && f !== "sign-in.ts")
      .filter((f) => direct.test(readFileSync(join(E2E, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
