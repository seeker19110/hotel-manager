// @vitest-environment happy-dom
// D-101: chữ `common.` của hạ tầng client cấp qua `MessagesProvider` (app/layout.tsx). Thiếu provider ⇒ `useMessages()` ném lỗi
// rõ ràng (không lặng lẽ hiện khoá/chuỗi rỗng); có provider ⇒ chữ hiển thị đúng từng ký tự như trước khi chuyển sang catalog.
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { CommandStatus, ResultUnknown } from "../command/command-status.tsx";
import { RouteError, RouteLoading } from "../ui/route-state.tsx";
import { commonMessages, WithMessages } from "./with-messages.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => {};

describe("useMessages / MessagesProvider (D-101)", () => {
  it("thiếu provider: hook và component dùng hook đều ném lỗi nêu rõ MessagesProvider", () => {
    vi.spyOn(console, "error").mockImplementation(noop); // React ghi lỗi render ra console
    expect(() => renderHook(() => useMessages())).toThrow(/missing <MessagesProvider>/);
    expect(() => render(<RouteLoading title="Phòng" />)).toThrow(/missing <MessagesProvider>/);
  });

  it("có provider: trả đúng object `common.` được cấp (cùng tham chiếu), chỉ khoá `common.`", () => {
    const { result } = renderHook(() => useMessages(), { wrapper: WithMessages });
    expect(result.current).toBe(commonMessages);
    expect(Object.keys(result.current).every((k) => k.startsWith("common."))).toBe(true);
    expect(tm(result.current, "common.retry")).toBe("Thử lại");
  });

  it("RouteLoading/RouteError: chữ giữ nguyên; mã tra cứu chỉ nhận ký tự an toàn", () => {
    const { unmount } = render(<RouteLoading title="Danh sách phòng" />, { wrapper: WithMessages });
    expect(screen.getByText("Đang tải danh sách phòng…")).toBeTruthy();
    unmount();
    const text =
      "Hệ thống đang gặp lỗi, màn hình này chưa tải được. Hãy thử lại; nếu vẫn lỗi, báo kèm mã tra cứu bên dưới.";
    const { unmount: u2 } = render(
      <RouteError title="Phòng" error={Object.assign(new Error("SQL"), { digest: "ab-12" })} reset={noop} />,
      { wrapper: WithMessages },
    );
    expect(screen.getByText("Không tải được màn hình")).toBeTruthy();
    expect(screen.getByText(`${text} Mã tra cứu: ab-12.`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
    expect(screen.queryByText(/SQL/)).toBeNull();
    u2();
    render(
      <RouteError title="Phòng" error={Object.assign(new Error("x"), { digest: "<script>" })} reset={noop} />,
      { wrapper: WithMessages },
    );
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("CommandStatus/ResultUnknown: chữ trạng thái giữ nguyên (gồm mã rút gọn, mã thao tác đầy đủ)", () => {
    const id = "0123456789abcdef";
    const base = { problem: null, general: null, successText: "Đã lưu.", onResend: noop, onRecheck: noop };
    const { unmount } = render(<CommandStatus {...base} phase="checking" commandId={id} />, {
      wrapper: WithMessages,
    });
    expect(screen.getByRole("status").textContent).toBe("Đang kiểm tra kết quả… (mã 01234567)");
    unmount();
    render(
      <CommandStatus
        {...base}
        phase="unknown"
        problem={{ code: "INTERNAL", status: 500, correlation_id: "ref-1" }}
      />,
      { wrapper: WithMessages },
    );
    expect(
      screen.getByText(
        'Chưa rõ máy chủ đã nhận thao tác này chưa. Bấm "Gửi lại" để gửi đúng thao tác này một lần nữa (không bị ghi hai lần).',
      ),
    ).toBeTruthy();
    expect(screen.getByText("Mã tra cứu: ref-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi lại" })).toBeTruthy();
    cleanup();
    render(<ResultUnknown commandId={id} onRecheck={noop} />, { wrapper: WithMessages });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "Chưa xác định được kết quả. Đừng thao tác lại; kiểm tra lịch sử hoặc liên hệ quản lý.",
    );
    expect(alert.textContent).toContain(`Mã thao tác: ${id}`);
    expect(screen.getByRole("button", { name: "Kiểm tra lại" })).toBeTruthy();
  });
});
