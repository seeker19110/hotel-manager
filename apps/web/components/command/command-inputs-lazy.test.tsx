// Nạp trễ bộ schema lệnh (LCP `/thong-bao`): kết quả như gọi thẳng `checkCommandInput`; không tải được ⇒ bỏ kiểm client lần đó
// (server vẫn validate) và lần sau thử tải lại.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@hm/app/command-inputs");
  vi.resetModules();
});

describe("command-inputs-lazy", () => {
  it("kiểm như schema của registry; lệnh không có schema client → null", async () => {
    const { checkCommandInputLazy } = await import("./command-inputs-lazy.ts");
    const { checkCommandInput } = await import("@hm/app/command-inputs");
    const bad = { unit_id: "không-phải-uuid" };
    expect(await checkCommandInputLazy("maintenance/create", bad)).toEqual(
      checkCommandInput("maintenance/create", bad),
    );
    expect(await checkCommandInputLazy("khong/co", {})).toBeNull();
  });

  it("không tải được chunk: trả null, lần sau tải lại", async () => {
    let calls = 0;
    vi.doMock("@hm/app/command-inputs", () => {
      calls += 1;
      if (calls === 1) throw new Error("chunk lỗi");
      return { checkCommandInput: () => [{ field: "x", message: "sai" }] };
    });
    const lazy = await import("./command-inputs-lazy.ts");
    expect(await lazy.checkCommandInputLazy("a/b", {})).toBeNull();
    lazy.prefetchCommandInputs();
    expect(await lazy.checkCommandInputLazy("a/b", {})).toEqual([{ field: "x", message: "sai" }]);
  });
});
