// @vitest-environment happy-dom
// FE-TEST-001: truy vấn theo vai trò/nhãn (Testing Library), không `getByTestId`.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.tsx";

afterEach(cleanup);

describe("Button", () => {
  it("mặc định là type=button (không vô tình submit form) và gọi onClick đúng một lần mỗi lần bấm", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Lưu</Button>);
    const btn = screen.getByRole("button", { name: "Lưu" });
    expect(btn.getAttribute("type")).toBe("button");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("đang gửi: khoá nút, aria-busy, spinner ẩn khỏi trình đọc màn hình, bấm không gọi onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Đang lưu
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Đang lưu" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".spinner")?.getAttribute("aria-hidden")).toBe("true");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("không ở trạng thái gửi: không có aria-busy và không có spinner", () => {
    render(<Button>Xong</Button>);
    const btn = screen.getByRole("button", { name: "Xong" });
    expect(btn.hasAttribute("aria-busy")).toBe(false);
    expect(btn.querySelector(".spinner")).toBeNull();
  });

  it("disabled khoá nút kể cả khi loading=false; biến thể secondary và lớp thêm được gộp, không dư khoảng trắng", () => {
    render(
      <Button disabled variant="secondary" className="btn--large">
        Quay lại
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Quay lại" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toBe("btn btn--secondary btn--large");
  });

  it("nhãn Unicode tiếng Việt có dấu được tìm theo tên truy cập", () => {
    render(<Button>Thu 930.000 đ — Hợp đồng HĐ-000001</Button>);
    expect(screen.getByRole("button", { name: /Hợp đồng HĐ-000001/ })).toBeTruthy();
  });
});
