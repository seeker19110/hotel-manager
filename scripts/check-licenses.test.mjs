import { describe, expect, it } from "vitest";
import { isAllowed } from "./check-licenses.mjs";

describe("isAllowed (SPDX)", () => {
  it.each([
    ["MIT", true],
    ["MIT OR Apache-2.0", true],
    ["(MIT OR GPL-3.0)", true],
    ["AGPL-3.0-only", false],
    ["GPL-3.0-or-later", false],
    ["MIT AND GPL-2.0", false],
    ["BUSL-1.1", false],
    ["UNKNOWN", false],
  ])("%s → %s", (expr, ok) => {
    expect(isAllowed(expr)).toBe(ok);
  });
});
