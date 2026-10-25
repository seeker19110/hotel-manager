// @vitest-environment happy-dom
// FE-TEST-001: ô nhập có nhãn, gợi ý và lỗi gắn đúng ô (aria-describedby + role=alert) — truy vấn theo nhãn/vai trò.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CheckboxField, SelectField, TextField } from "./field.tsx";

afterEach(cleanup);

const describedBy = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

describe("TextField", () => {
  it("nhãn gắn với ô nhập (getByLabelText) và gõ được Unicode", async () => {
    render(<TextField label="Họ và tên" />);
    const input = screen.getByLabelText("Họ và tên") as HTMLInputElement;
    await userEvent.type(input, "Nguyễn Thị Hương");
    expect(input.value).toBe("Nguyễn Thị Hương");
  });

  it("không có gợi ý/lỗi: không aria-describedby, không aria-invalid, không alert", () => {
    render(<TextField label="Số điện thoại" />);
    const input = screen.getByLabelText("Số điện thoại");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("có lỗi: aria-invalid, alert hiện đúng chữ và được aria-describedby trỏ tới", () => {
    render(<TextField label="Số tiền" error="Nhập số nguyên đồng" />);
    const input = screen.getByLabelText("Số tiền");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Nhập số nguyên đồng");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(input)).toEqual([alert.id]);
  });

  it("có cả gợi ý và lỗi: aria-describedby liệt kê cả hai, gợi ý trước", () => {
    render(<TextField label="Ngày" hint="Định dạng ngày-tháng-năm" error="Bắt buộc nhập" />);
    const input = screen.getByLabelText("Ngày");
    const ids = describedBy(input);
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0] as string)?.textContent).toBe("Định dạng ngày-tháng-năm");
    expect(document.getElementById(ids[1] as string)?.textContent).toBe("Bắt buộc nhập");
  });

  it("chuỗi lỗi rỗng coi như không có lỗi (không alert rỗng)", () => {
    render(<TextField label="Ghi chú" error="" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Ghi chú").hasAttribute("aria-invalid")).toBe(false);
  });

  it("hai ô cùng trang có id riêng, nhãn không bị nhầm ô", () => {
    render(
      <>
        <TextField label="Tên" />
        <TextField label="Tên đệm" />
      </>,
    );
    expect(screen.getByLabelText("Tên", { exact: true }).id).not.toBe(screen.getByLabelText("Tên đệm").id);
  });
});

describe("SelectField", () => {
  const options = [
    { value: "cleaning", label: "Dọn phòng" },
    { value: "inspection", label: "Kiểm tra phòng" },
  ];

  it("chọn một lựa chọn theo nhãn hiển thị, giá trị là `value`", async () => {
    render(<SelectField label="Loại việc" options={options} />);
    const select = screen.getByRole("combobox", { name: "Loại việc" }) as HTMLSelectElement;
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await userEvent.selectOptions(select, "Kiểm tra phòng");
    expect(select.value).toBe("inspection");
  });

  it("danh sách rỗng vẫn dựng được ô chọn, không có lựa chọn nào", () => {
    render(<SelectField label="Phòng" options={[]} />);
    expect(screen.getByRole("combobox", { name: "Phòng" })).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("có lỗi: alert + aria-invalid như TextField", () => {
    render(<SelectField label="Mức ưu tiên" options={options} error="Chọn một mức" />);
    expect(screen.getByRole("alert").textContent).toBe("Chọn một mức");
    expect(screen.getByRole("combobox", { name: "Mức ưu tiên" }).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("CheckboxField (ô đồng ý — T-2310)", () => {
  it("mặc định KHÔNG tick; nhãn bấm được đổi trạng thái; gợi ý gắn qua aria-describedby", async () => {
    render(<CheckboxField label="Tôi đồng ý đo lường" hint="Không bắt buộc" name="c" />);
    const box = screen.getByLabelText("Tôi đồng ý đo lường") as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(false);
    const [hintId] = describedBy(box);
    expect(document.getElementById(hintId as string)?.textContent).toBe("Không bắt buộc");
    await userEvent.click(screen.getByText("Tôi đồng ý đo lường"));
    expect(box.checked).toBe(true);
  });

  it("không gợi ý ⇒ không aria-describedby; defaultChecked theo trạng thái đã lưu", () => {
    render(<CheckboxField label="Đồng ý" defaultChecked />);
    const box = screen.getByLabelText("Đồng ý") as HTMLInputElement;
    expect(box.hasAttribute("aria-describedby")).toBe(false);
    expect(box.checked).toBe(true);
  });
});
