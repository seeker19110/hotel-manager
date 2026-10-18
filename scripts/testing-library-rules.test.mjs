// FE-TEST-001: rào truy vấn Testing Library — mỗi luật phải ĐỎ trên mẫu vi phạm và XANH trên mẫu đúng, rồi quét repo thật.
import { describe, expect, it } from "vitest";
import {
  countQueries,
  MAX_TESTID_RATIO,
  scanRepo,
  usesTestingLibrary,
  violationsIn,
} from "./testing-library-rules.mjs";

const rules = (src) => violationsIn(src).map((v) => v.rule);

describe("prefer-screen-queries", () => {
  it("lấy truy vấn từ render() → đỏ (một dòng và xuống dòng)", () => {
    expect(rules("const { getByRole } = render(<A />);")).toEqual(["prefer-screen-queries"]);
    expect(rules("const {\n  getByLabelText,\n  queryByText,\n} = render(<A />);")).toEqual([
      "prefer-screen-queries",
    ]);
  });
  it("gán kết quả render() cho biến rồi gọi view.getByRole(…) → đỏ (kể cả await/let, truy vấn All/find)", () => {
    expect(rules("const view = render(<A />);\nview.getByRole('button');")).toEqual([
      "prefer-screen-queries",
    ]);
    expect(rules("let v = await render(<A />); await v.findAllByText('x');")).toEqual([
      "prefer-screen-queries",
    ]);
    expect(rules("const $r = render(<A />); $r.queryByLabelText('x');")).toEqual(["prefer-screen-queries"]);
  });
  it("view.rerender/unmount, hoặc biến khác không phải kết quả render → xanh", () => {
    expect(rules("const view = render(<A />); view.rerender(<A />); view.unmount();")).toEqual([]);
    expect(rules("const view = render(<A />); other.getByRole('button'); screen.getByRole('x');")).toEqual(
      [],
    );
    expect(rules("const el = screen.getByRole('b'); el.getByRole('c');")).toEqual([]);
  });
  it("dùng screen, hoặc chỉ lấy `unmount`/`rerender` từ render() → xanh", () => {
    expect(rules("render(<A />); screen.getByRole('button');")).toEqual([]);
    expect(rules("const { unmount, rerender } = render(<A />);")).toEqual([]);
  });
  it("chuỗi/comment giống mã vi phạm không làm đỏ", () => {
    expect(rules('const s = "const { getByRole } = render(";')).toEqual([]);
    expect(rules("// const { getByRole } = render(<A />);")).toEqual([]);
  });
});

describe("no-container", () => {
  it("container.querySelector hoặc destructure container → đỏ", () => {
    expect(rules("const x = container.querySelector('.a');")).toEqual(["no-container"]);
    expect(rules("const { container } = render(<A />);")).toEqual(["no-container"]);
    expect(rules("expect(baseElement.firstChild).toBeTruthy();")).toEqual(["no-container"]);
  });
  it("view.container / view.baseElement (không gọi tiếp phương thức) cũng đỏ", () => {
    expect(rules("const view = render(<A />); expect(view.container).toBeTruthy();")).toEqual([
      "no-container",
    ]);
    expect(rules("const root = view.baseElement;")).toEqual(["no-container"]);
  });
  it("biến tên khác (vd `containers`, `btn.querySelector`) → xanh", () => {
    expect(rules("const containers = []; btn.querySelector('.spinner');")).toEqual([]);
  });
});

describe("getByTestId chỉ khi có lý do", () => {
  it("không chú thích → đỏ; chú thích cùng dòng hoặc dòng trên → xanh", () => {
    expect(rules("screen.getByTestId('x');")).toEqual(["testid-needs-reason"]);
    expect(rules("screen.getByTestId('x'); // testid: ô không có vai trò")).toEqual([]);
    expect(rules("// testid: ô không có vai trò\nscreen.getAllByTestId('x');")).toEqual([]);
  });
  it("chú thích rỗng lý do vẫn đỏ", () => {
    expect(rules("screen.getByTestId('x'); // testid:")).toEqual(["testid-needs-reason"]);
  });
});

describe("tỷ lệ testid", () => {
  it("đếm đúng tổng truy vấn và testid (bỏ qua chuỗi/comment)", () => {
    const src = `screen.getByRole('a'); screen.findAllByText('b'); screen.queryByTestId('c'); // getByRole
      const s = "getByLabelText";`;
    expect(countQueries(src)).toEqual({ total: 3, testId: 1 });
  });
  it("file không có truy vấn → 0/0, không chia cho 0", () => {
    expect(countQueries("const a = 1;")).toEqual({ total: 0, testId: 0 });
  });
  it("chỉ file import Testing Library chịu rào", () => {
    expect(usesTestingLibrary('import { screen } from "@testing-library/react";')).toBe(true);
    expect(usesTestingLibrary('import { expect } from "vitest";')).toBe(false);
  });
});

describe("repo thật", () => {
  const r = scanRepo();
  it("có test component dùng Testing Library và không vi phạm luật nào", () => {
    expect(r.files).toBeGreaterThanOrEqual(5);
    expect(r.total).toBeGreaterThan(30);
    expect(r.violations).toEqual([]);
  });
  it(`getByTestId ≤ ${MAX_TESTID_RATIO * 100}% tổng truy vấn`, () => {
    expect(r.ratio).toBeLessThanOrEqual(MAX_TESTID_RATIO);
  });
});
