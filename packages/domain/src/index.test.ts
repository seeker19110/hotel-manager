import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE } from "./index.ts";

describe("@hm/domain", () => {
  it("export được tên gói", () => {
    expect(DOMAIN_PACKAGE).toBe("@hm/domain");
  });
});
