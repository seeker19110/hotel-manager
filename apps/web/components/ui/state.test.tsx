// @vitest-environment happy-dom
// FE-TEST-001: truy vấn theo vai trò/nhãn (Testing Library). AUD-XFEAT-001: danh sách chạm trần SQL phải báo, không im lặng.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TruncatedNotice } from "./truncated-notice.tsx";

afterEach(cleanup);

describe("TruncatedNotice", () => {
  it("chạm trần (shown = limit) → role=status nêu đúng số trần và cách xem đủ", () => {
    render(<TruncatedNotice shown={200} limit={200} />);
    const s = screen.getByRole("status");
    expect(s.textContent).toContain("200 mục đầu tiên");
    expect(s.textContent).toContain("Thu hẹp khoảng ngày");
  });

  it("dưới trần (kể cả 0 và limit − 1) → không hiện gì", () => {
    for (const shown of [0, 1, 199]) {
      render(<TruncatedNotice shown={shown} limit={200} />);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText(/mục đầu tiên/)).toBeNull();
      cleanup();
    }
  });
});
