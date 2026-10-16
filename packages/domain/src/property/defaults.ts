// Giá trị mặc định theo mẫu cơ sở (PLAN đợt 3 D-002/D-005; SPEC-access Q-01/Q-03, SPEC-reservation Q-01, SPEC-inventory Q-01).
// Cột tương ứng ở `properties` (ERD): business_day_cutoff, check_in_time, check_out_time, hold_ttl_minutes.
// DB giữ mặc định trung lập (00:00, NULL, 15); lệnh tạo cơ sở và dữ liệu mẫu lấy giá trị theo mẫu từ đây.

export type PropertyTemplate = "rental" | "hotel" | "mixed";

export interface PropertyDefaults {
  /** Giờ chốt ngày kinh doanh, giờ địa phương `HH:MM`. Khách nhận phòng trước giờ này tính vào đêm hôm trước. */
  businessDayCutoff: string;
  /** Giờ nhận/trả phòng mặc định; `null` với cơ sở chỉ cho thuê dài hạn. */
  checkInTime: string | null;
  checkOutTime: string | null;
  /** TTL giữ phòng tại quầy (phút). */
  holdTtlMinutes: number;
}

const HOTEL: PropertyDefaults = {
  businessDayCutoff: "04:00",
  checkInTime: "14:00",
  checkOutTime: "12:00",
  holdTtlMinutes: 15,
};

const RENTAL: PropertyDefaults = {
  businessDayCutoff: "00:00",
  checkInTime: null,
  checkOutTime: null,
  holdTtlMinutes: 15,
};

export function propertyDefaults(template: PropertyTemplate): PropertyDefaults {
  // `mixed` có phòng bán theo đêm nên theo mốc giờ của khách sạn.
  return { ...(template === "rental" ? RENTAL : HOTEL) };
}
