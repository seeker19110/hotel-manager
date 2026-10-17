// Luồng nóng 3: tạo giữ phòng = `reservation.create` (nháp) → `reservation.hold` (giữ chỗ). SLO-HOLD: p95 < 1,5 s ở tải kiểm thử.
// Mỗi vòng dùng một phòng trong UNIT_IDS (danh sách, phân tách dấu phẩy) và một cửa sổ ngày ngẫu nhiên trong 300 ngày để hạn chế
// đụng chỗ giữa các VU; 409/422 do đụng chỗ KHÔNG tính là lỗi hệ thống (đó là hành vi đúng) nhưng bị đếm riêng ở `hm_hold_conflicts`.
// Cần phiên vai trò lễ tân/quản lý (có MFA): K6_COOKIE, ORG_ID, UNIT_IDS.
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import {
  assertSafeTarget,
  dateOffset,
  LIMITS,
  postCommand,
  requireEnv,
  scenarios,
  thresholds,
} from "./lib.js";

const conflicts = new Counter("hm_hold_conflicts");

// 409/422 do đụng chỗ/vượt dư nợ là hành vi đúng của nghiệp vụ — không tính vào `http_req_failed`.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409, 422));

export const options = {
  scenarios: scenarios("createHold"),
  thresholds: {
    ...thresholds("reservation-create"),
    ...thresholds("reservation-hold", LIMITS.holdP95Ms, LIMITS.holdP99Ms),
  },
};

export function setup() {
  assertSafeTarget();
  requireEnv("K6_COOKIE", "ORG_ID", "UNIT_IDS");
}

export function createHold() {
  const units = __ENV.UNIT_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unit = units[Math.floor(Math.random() * units.length)];
  const start = 30 + Math.floor(Math.random() * 300);
  const created = postCommand(
    "reservation.create",
    "/api/v1/reservation/create",
    {
      unit_id: unit,
      arrival_date: dateOffset(start),
      departure_date: dateOffset(start + 1 + Math.floor(Math.random() * 3)),
      guests: 1,
      source: "direct",
      booker: {
        full_name: `Khách k6 ${__VU}-${__ITER}`,
        phone: `09${String(10000000 + ((__VU * 100003 + __ITER) % 89999999))}`,
      },
    },
    "reservation-create",
  );
  if (created.status === 409 || created.status === 422) {
    conflicts.add(1);
    return;
  }
  if (!check(created, { "tạo đặt phòng 201": (r) => r.status === 201 })) return;
  const reservationId = created.json("data.reservationId");
  if (!check(reservationId, { "có reservation id": (v) => typeof v === "string" })) return;
  const held = postCommand(
    "reservation.hold",
    "/api/v1/reservation/hold",
    { reservation_id: reservationId },
    "reservation-hold",
  );
  check(held, { "giữ chỗ 200": (r) => r.status === 200 });
}
