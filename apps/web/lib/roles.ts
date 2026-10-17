/** Nhãn vai trò hiển thị (một nguồn cho các màn quản trị). */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  owner: "Chủ sở hữu",
  manager: "Quản lý",
  front_desk: "Lễ tân",
  accountant: "Kế toán",
  housekeeping: "Buồng phòng",
  maintenance: "Kỹ thuật",
  tenant: "Người thuê",
};

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  active: "Đang hoạt động",
  suspended: "Tạm khoá",
  invited: "Đã mời",
};

/** Vai trò mà manager mời/đổi được (ma trận 5.3). */
export const STAFF_LOW = ["front_desk", "housekeeping", "maintenance"] as const;
export const STAFF_ALL = [
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
] as const;
