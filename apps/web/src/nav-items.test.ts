// SPEC-pwa S-014: điều hướng dưới — đúng 5 điểm vào theo thứ tự cho manager/hotel; menu theo vai trò; ca biên vai trò lạ/không quyền.
import { describe, expect, it } from "vitest";
import { activeKey, moreLinks, primaryNav, scopeLabel } from "../components/rental/nav-items.ts";

const HOTEL = { hotel: true, rental: false };
const RENTAL = { hotel: false, rental: true };
const labels = (role: string, kinds = HOTEL) => primaryNav(role, kinds).map((e) => e.label);

describe("primaryNav", () => {
  it("manager + hotel: đúng 5 mục theo thứ tự Hôm nay · Phòng/Lịch · Thu tiền · Công việc · Thêm", () => {
    expect(labels("manager")).toEqual(["Hôm nay", "Phòng/Lịch", "Thu tiền", "Công việc", "Thêm"]);
    expect(primaryNav("manager", HOTEL).map((e) => e.href)).toEqual([
      "/",
      "/lich-phong",
      "/thu-tien",
      "/buong-phong",
      "/them",
    ]);
  });
  it("housekeeping không thấy Thu tiền; kế toán không thấy Công việc; kỹ thuật vào thẳng Sự cố", () => {
    expect(labels("housekeeping")).toEqual(["Hôm nay", "Phòng/Lịch", "Công việc", "Thêm"]);
    expect(labels("accountant")).toEqual(["Hôm nay", "Phòng/Lịch", "Thu tiền", "Thêm"]);
    expect(primaryNav("maintenance", HOTEL).find((e) => e.key === "work")?.href).toBe("/su-co");
  });
  it("nhà trọ: Phòng/Lịch trỏ danh sách phòng (không có lịch khách sạn)", () => {
    expect(primaryNav("manager", RENTAL).find((e) => e.key === "rooms")?.href).toBe("/phong");
  });
  it("không bao giờ quá 5 mục, luôn có Hôm nay đầu và Thêm cuối; vai trò lạ chỉ còn hai mục đó", () => {
    for (const role of ["owner", "manager", "front_desk", "accountant", "housekeeping", "maintenance"])
      expect(primaryNav(role).length, role).toBeLessThanOrEqual(5);
    expect(labels("tenant")).toEqual(["Hôm nay", "Thêm"]);
    expect(labels("")).toEqual(["Hôm nay", "Thêm"]);
  });
});

describe("moreLinks / activeKey", () => {
  it("Thêm chứa các màn còn lại và KHÔNG lặp mục đã có ở thanh dưới", () => {
    const primary = new Set(primaryNav("manager", HOTEL).map((e) => e.href));
    const more = moreLinks("manager", HOTEL).map((l) => l.href);
    expect(more).toContain("/dat-phong");
    expect(more).toContain("/su-co");
    expect(more).toContain("/thong-bao");
    for (const h of more) expect(primary.has(h), h).toBe(false);
  });
  it("housekeeping không có liên kết tiền/đặt phòng trong Thêm", () => {
    const more = moreLinks("housekeeping", HOTEL).map((l) => l.href);
    for (const h of ["/dat-phong", "/thu-tien", "/hop-dong", "/ky-thu", "/doi-soat"])
      expect(more).not.toContain(h);
  });
  it("route thuộc nhóm nào thì nhóm đó sáng; route khác ⇒ Thêm", () => {
    const e = primaryNav("manager", HOTEL);
    expect(activeKey(e, "/")).toBe("today");
    expect(activeKey(e, "/lich-phong")).toBe("rooms");
    expect(activeKey(e, "/su-co")).toBe("work");
    expect(activeKey(e, "/dat-phong")).toBe("more");
    expect(activeKey(e, "/them")).toBe("more");
  });
});

describe("scopeLabel (cơ sở đang thao tác ở header)", () => {
  it("0, 1, 2, nhiều cơ sở", () => {
    expect(scopeLabel([])).toBe("Chưa có cơ sở được giao");
    expect(scopeLabel(["A"])).toBe("A");
    expect(scopeLabel(["A", "B"])).toBe("A, B");
    expect(scopeLabel(["A", "B", "C", "D"])).toBe("A, B +2");
  });
});
