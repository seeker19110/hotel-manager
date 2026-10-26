// @vitest-environment happy-dom
// D-133: biểu ngữ truy cập hỗ trợ không có JS client — không nút/form; owner có liên kết tới khối quản lý ở /nhat-ky (thu hồi một
// bước ở đó), manager có liên kết xem nhật ký của hỗ trợ, vai trò khác (kể cả chính người hỗ trợ) không có liên kết.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SupportBanner } from "./support-banner.tsx";

const rows = [
  {
    invitationId: "00000000-0000-0000-0000-000000000001",
    state: "active" as const,
    name: "Người hỗ trợ",
    email: null,
    reason: "Kiểm tra lỗi",
    until: new Date("2026-10-27T03:00:00Z"),
  },
];

afterEach(cleanup);

describe("SupportBanner", () => {
  it("owner: liên kết tới khối Truy cập hỗ trợ của /nhat-ky; không có nút", () => {
    render(<SupportBanner rows={rows} viewerRole="owner" />);
    expect(
      screen.getByRole("link", { name: "Thu hồi hoặc quản lý truy cập hỗ trợ" }).getAttribute("href"),
    ).toBe("/nhat-ky#truy-cap-ho-tro");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("Kiểm tra lỗi");
  });

  it("manager: liên kết xem thao tác của hỗ trợ trong nhật ký, không có liên kết quản lý", () => {
    render(<SupportBanner rows={rows} viewerRole="manager" />);
    expect(
      screen.getByRole("link", { name: "Xem thao tác của hỗ trợ trong nhật ký" }).getAttribute("href"),
    ).toBe("/nhat-ky?actor=platform_support");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it.each(["platform_support", "front_desk", "accountant"])("%s: không có liên kết nào", (role) => {
    render(<SupportBanner rows={rows} viewerRole={role} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
