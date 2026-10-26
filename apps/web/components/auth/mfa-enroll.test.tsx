// @vitest-environment happy-dom
// AUD-A11Y-001: giới hạn tần suất phải được giải thích đúng ở cả hai bước đăng ký MFA; lỗi nhập sai và lỗi mạng vẫn phân biệt.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaEnroll } from "../../app/bao-mat/mfa-enroll.tsx";
import { messagesFor, t } from "../../lib/i18n.ts";

const m = messagesFor("mfa_enroll.", "auth_form.");
const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["password", "verify"] as const)("MfaEnroll — %s", (phase) => {
  async function submit(response: Response | Error) {
    fetchMock.mockResolvedValueOnce(json(200, { user: { twoFactorEnabled: false } }));
    if (phase === "verify")
      fetchMock.mockResolvedValueOnce(
        json(200, {
          totpURI: "otpauth://totp/Hotel%20Manager:test?secret=TESTSECRET&issuer=Hotel%20Manager",
          backupCodes: ["backup-code"],
        }),
      );
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);

    render(<MfaEnroll m={m} />);
    await userEvent.type(await screen.findByLabelText(t("mfa_enroll.password.label")), "valid-password");
    await userEvent.click(screen.getByRole("button", { name: t("mfa_enroll.password.submit") }));
    if (phase === "verify") {
      await userEvent.type(await screen.findByLabelText(t("auth_form.totp.label")), "123456");
      await userEvent.click(screen.getByRole("button", { name: t("mfa_enroll.verify.submit") }));
    }
    return screen.findByRole("alert");
  }

  it("429 giải thích giới hạn tần suất, giữ bước hiện tại và cho thử lại", async () => {
    expect((await submit(json(429))).textContent).toBe(t("auth_form.error.too_many"));
    expect(assign).not.toHaveBeenCalled();
    const field = screen.getByLabelText(
      t(phase === "password" ? "mfa_enroll.password.label" : "auth_form.totp.label"),
    );
    expect(field.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen
        .getByRole("button", {
          name: t(phase === "password" ? "mfa_enroll.password.submit" : "mfa_enroll.verify.submit"),
        })
        .hasAttribute("disabled"),
    ).toBe(false);
    if (phase === "verify") expect(screen.getByText("TESTSECRET").textContent).toBe("TESTSECRET");
  });

  it("phản hồi nhập sai vẫn báo lỗi mật khẩu hoặc mã xác thực", async () => {
    expect((await submit(json(400))).textContent).toBe(
      t(phase === "password" ? "mfa_enroll.error.password" : "auth_form.totp.invalid"),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("lỗi mạng vẫn báo chưa nhận được phản hồi", async () => {
    expect((await submit(new TypeError("network"))).textContent).toBe(t("auth_form.no_response"));
    expect(assign).not.toHaveBeenCalled();
  });
});
