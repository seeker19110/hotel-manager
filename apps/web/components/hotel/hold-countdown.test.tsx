// @vitest-environment happy-dom
// FE-TEST-003: thời gian giả (`vi.useFakeTimers` + `setSystemTime`) — kết quả không phụ thuộc đồng hồ máy/múi giờ.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldCountdown } from "./hold-countdown.tsx";

const NOW = "2026-10-17T10:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const until = (secondsFromNow: number) => new Date(Date.parse(NOW) + secondsFromNow * 1000).toISOString();

describe("HoldCountdown", () => {
  it("luôn hiện hạn tuyệt đối bằng chữ; đếm ngược phút:giây theo đồng hồ giả", () => {
    render(<HoldCountdown until={until(125)} untilText="10:02 ngày 17/10" />);
    expect(screen.getByText(/Giữ phòng đến 10:02 ngày 17\/10/)).toBeTruthy();
    expect(screen.getByText(/còn 2 phút 05 giây/)).toBeTruthy();
  });

  it("mỗi giây giảm một giây; giây một chữ số có số 0 đệm", () => {
    render(<HoldCountdown until={until(61)} untilText="x" />);
    expect(screen.getByText(/còn 1 phút 01 giây/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/còn 0 phút 59 giây/)).toBeTruthy();
  });

  it("đúng lúc hết hạn: hiện chữ hết hạn (không hiện số âm) và dừng đếm", () => {
    render(<HoldCountdown until={until(2)} untilText="x" />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/đã hết hạn giữ phòng/)).toBeTruthy();
    expect(screen.queryByText(/còn \d+ phút/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/đã hết hạn giữ phòng/)).toBeTruthy();
  });

  it("hạn đã qua từ trước: hiện hết hạn ngay, không âm", () => {
    render(<HoldCountdown until={until(-3600)} untilText="x" />);
    expect(screen.getByText(/đã hết hạn giữ phòng/)).toBeTruthy();
  });

  it("gỡ khỏi trang thì huỷ bộ đếm (không còn timer treo)", () => {
    const { unmount } = render(<HoldCountdown until={until(90)} untilText="x" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
