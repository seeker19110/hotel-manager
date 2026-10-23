// @vitest-environment happy-dom
// FE-TEST-001: form yêu cầu sửa chữa của người thuê — kiểm theo nhãn/vai trò; mạng và router được giả.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@serwist/turbopack/react", () => ({
  SerwistProvider: ({ children }: { children: unknown }) => children,
  useSerwist: () => ({ serwist: null }),
}));

import { messagesFor } from "../../lib/i18n.ts";
import { RequestForm } from "./request-form.tsx";

const m = messagesFor("request_form.");

const UNITS = [
  {
    unitId: "2f1b1f0e-6b1e-4a0e-8d54-0d3a1c8a9e11",
    propertyId: "7a0c3a52-1d1f-4c61-9d63-2a6a9e8b5c10",
    unitCode: "P101",
  },
  {
    unitId: "3c2c2f1f-7c2f-4b1f-8e65-1e4b2d9b6d21",
    propertyId: "7a0c3a52-1d1f-4c61-9d63-2a6a9e8b5c10",
    unitCode: "P102",
  },
];
const fetchMock = vi.fn<typeof fetch>();
/** Tham số `init` của lần gọi `fetch` thứ i (lần gọi không tồn tại → ném lỗi, test đỏ rõ ràng). */
function initOf(i: number): RequestInit {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`fetch chưa được gọi lần thứ ${i + 1}`);
  return call[1] ?? {};
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RequestForm", () => {
  it("để trống tiêu đề và mô tả: hai lỗi theo ô, không gửi gì", async () => {
    render(<RequestForm units={UNITS.slice(0, 1)} m={m} />);
    await userEvent.click(screen.getByRole("button", { name: "Gửi yêu cầu" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["Bắt buộc nhập", "Bắt buộc nhập"]);
    expect(screen.getByLabelText("Việc cần sửa").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Mô tả").getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("một phòng: không hiện ô chọn phòng; nhiều phòng: có ô chọn và gửi đúng phòng đã chọn", async () => {
    const { unmount } = render(<RequestForm units={UNITS.slice(0, 1)} m={m} />);
    expect(screen.queryByRole("combobox", { name: "Phòng" })).toBeNull();
    unmount();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { request_id: "r1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<RequestForm units={UNITS} m={m} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Phòng" }), "Phòng P102");
    await userEvent.type(screen.getByLabelText("Việc cần sửa"), "Vòi nước rỉ");
    await userEvent.type(screen.getByLabelText("Mô tả"), "Vòi bồn rửa mặt rỉ nước suốt đêm");
    await userEvent.click(screen.getByRole("button", { name: "Gửi yêu cầu" }));

    expect((await screen.findByRole("status")).textContent).toContain("Đã gửi yêu cầu");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(initOf(0).body))).toEqual({
      unit_id: UNITS[1]?.unitId,
      title: "Vòi nước rỉ",
      description: "Vòi bồn rửa mặt rỉ nước suốt đêm",
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Việc cần sửa") as HTMLInputElement).value).toBe("");
  });

  it("tiêu đề 201 ký tự bị chặn ở máy khách (quá trần 200)", async () => {
    render(<RequestForm units={UNITS.slice(0, 1)} m={m} />);
    const title = screen.getByLabelText("Việc cần sửa") as HTMLInputElement;
    // `maxLength` của ô chặn gõ quá 200; đặt thẳng giá trị để kiểm nhánh kiểm tra của form.
    title.removeAttribute("maxlength");
    await userEvent.type(screen.getByLabelText("Mô tả"), "ok");
    await userEvent.click(title);
    await userEvent.paste("a".repeat(201));
    await userEvent.click(screen.getByRole("button", { name: "Gửi yêu cầu" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Tối đa 200 ký tự");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
