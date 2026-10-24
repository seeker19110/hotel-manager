import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSignInOtpSender, fakeOutboxPath, otpMessage } from "./otp-mail.ts";

describe("OTP đăng nhập người thuê — chữ thư", () => {
  it("chủ đề và nội dung giữ nguyên từng ký tự (XC-I18N-001)", () => {
    expect(otpMessage("123456")).toEqual({
      subject: "Mã đăng nhập Hotel Manager",
      text: "Mã đăng nhập của bạn là 123456. Mã có hiệu lực 5 phút. Không chia sẻ mã này cho bất kỳ ai.",
    });
  });
});

describe("OTP đăng nhập người thuê — hộp thư giả", () => {
  it("fake://file?path=<tuyệt đối> ghi mỗi mã một dòng JSON; mặc định fake://local bỏ mã", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-otp-"));
    try {
      const file = join(dir, "outbox.jsonl");
      const send = createSignInOtpSender(`fake://file?path=${encodeURIComponent(file)}`);
      await send?.("an@example.test", "123456");
      await send?.("binh@example.test", "654321");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] as string)).toMatchObject({ to: "an@example.test" });
      expect(lines[0]).toContain("123456");
      // Mặc định không giữ mã ở đâu cả.
      await expect(
        createSignInOtpSender("fake://local")?.("an@example.test", "111111"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("đường dẫn tương đối/thiếu/URL hỏng → không ghi file; smtp:// chưa có adapter → undefined", () => {
    expect(fakeOutboxPath("fake://file?path=outbox.jsonl")).toBeNull();
    expect(fakeOutboxPath("fake://file")).toBeNull();
    expect(fakeOutboxPath("fake://local")).toBeNull();
    expect(createSignInOtpSender("smtp://mail.example.test:587")).toBeUndefined();
  });

  it("nội dung email nêu mã và hạn, không kèm dữ liệu khác", () => {
    const m = otpMessage("123456");
    expect(m.text).toContain("123456");
    expect(m.text).toContain("5 phút");
  });
});
