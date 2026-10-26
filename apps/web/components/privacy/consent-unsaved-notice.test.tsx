// @vitest-environment happy-dom
// T-2310: tick ô đồng ý ở form đăng ký mà ghi lựa chọn thất bại ⇒ KHÔNG im lặng: vẫn đi tiếp (không chặn) nhưng trang sau nhận cờ để
// hiện thông báo chọn lại ở Quyền riêng tư; ghi được/không tick ⇒ đi tiếp như thường. Mạng và điều hướng được giả.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@serwist/turbopack/react", () => ({
  SerwistProvider: ({ children }: { children: unknown }) => children,
  useSerwist: () => ({ serwist: null }),
}));

import { RegisterForm } from "../../app/dang-ky/register-form.tsx";
import { messagesFor, t } from "../../lib/i18n.ts";
import { CONSENT_UNSAVED_PARAM, type ConsentOffer } from "./consent-offer.ts";
import { ConsentUnsavedNotice } from "./consent-unsaved-notice.tsx";

const m = messagesFor("register_form.", "auth_form.");
const consent: ConsentOffer = {
  purpose: "analytics",
  version: "2026-10-25",
  label: "Cho phép thống kê sử dụng",
  hint: "Không bắt buộc",
  unsaved: { text: t("consent_offer.unsaved"), link: t("consent_offer.open_privacy") },
};

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

async function submit(tick: boolean) {
  render(<RegisterForm m={m} consent={consent} />);
  await userEvent.type(screen.getByLabelText("Họ và tên"), "Nguyễn Văn A");
  await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhau-du-dai");
  if (tick) await userEvent.click(screen.getByLabelText(consent.label));
  await userEvent.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  return assign.mock.calls[0]?.[0] as string;
}

describe("RegisterForm — ô đồng ý", () => {
  it("tick mà ghi đồng ý lỗi (500) ⇒ vẫn sang chọn tổ chức nhưng kèm cờ hiện thông báo", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200)) // sign-up
      .mockResolvedValueOnce(json(200)) // sign-in
      .mockResolvedValueOnce(json(500)); // consents
    expect(await submit(true)).toBe(`/chon-to-chuc?${CONSENT_UNSAVED_PARAM}=1`);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("/api/v1/me/consents");
  });

  it("tick mà mạng hỏng khi ghi ⇒ cũng kèm cờ (không nuốt im lặng)", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200))
      .mockResolvedValueOnce(json(200))
      .mockRejectedValueOnce(new TypeError("network"));
    expect(await submit(true)).toBe(`/chon-to-chuc?${CONSENT_UNSAVED_PARAM}=1`);
  });

  it("tick và ghi được ⇒ đi tiếp như thường; không tick ⇒ không gọi API đồng ý", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200))
      .mockResolvedValueOnce(json(200))
      .mockResolvedValueOnce(json(200, { data: { status: "recorded" } }));
    expect(await submit(true)).toBe("/chon-to-chuc");
    cleanup();
    assign.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(200)).mockResolvedValueOnce(json(200));
    expect(await submit(false)).toBe("/chon-to-chuc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ConsentUnsavedNotice", () => {
  it("banner role=status (không chặn), chữ i18n và liên kết tới Quyền riêng tư", () => {
    render(<ConsentUnsavedNotice {...consent.unsaved} />);
    const s = screen.getByRole("status");
    expect(s.textContent).toContain(t("consent_offer.unsaved"));
    expect(screen.getByRole("link", { name: t("consent_offer.open_privacy") }).getAttribute("href")).toBe(
      "/quyen-rieng-tu",
    );
  });
});
