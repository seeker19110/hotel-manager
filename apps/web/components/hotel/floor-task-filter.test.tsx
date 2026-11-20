// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FloorTaskFilter } from "./floor-task-filter.tsx";

afterEach(cleanup);

const props = {
  propertyId: "p1",
  floors: [
    { id: "one", name: "Tầng một" },
    { id: "two", name: "Tầng hai" },
  ],
  label: "Lọc công việc theo tầng tại cơ sở A",
  all: "Tất cả các tầng",
};

it("lọc và xoá bằng liên kết cùng cơ sở, chỉ đánh dấu lựa chọn đang xem", () => {
  const { rerender } = render(<FloorTaskFilter {...props} selected={undefined} />);
  const nav = within(screen.getByRole("navigation", { name: props.label }));
  const all = nav.getByRole("link", { name: props.all });
  const two = nav.getByRole("link", { name: "Tầng hai" });
  expect(all.getAttribute("aria-current")).toBe("page");
  expect(two.getAttribute("href")).toBe("/buong-phong?property=p1&floor=two#h-p1");
  rerender(<FloorTaskFilter {...props} selected="two" />);
  expect(two.getAttribute("aria-current")).toBe("page");
  expect(all.hasAttribute("aria-current")).toBe(false);
  expect(all.getAttribute("href")).toBe("/buong-phong#h-p1");
});

it("ẩn bộ lọc khi có tối đa một tầng, vẫn cho bỏ lựa chọn từ liên kết đã lưu", () => {
  const floors = props.floors.slice(0, 1);
  const { rerender } = render(<FloorTaskFilter {...props} floors={floors} selected={undefined} />);
  expect(screen.queryByRole("navigation")).toBeNull();
  rerender(<FloorTaskFilter {...props} floors={floors} selected="one" />);
  expect(screen.getByRole("link", { name: props.all })).toBeTruthy();
});
