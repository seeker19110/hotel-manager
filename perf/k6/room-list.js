// Luồng nóng 2: danh sách phòng — trang /phong (HTML render phía server) + tóm tắt hôm nay + lịch đặt phòng 7 ngày.
// Cần phiên có sẵn: K6_COOKIE="__Host-hm.session_token=…; hm_org=…" (đăng nhập tay một lần, kể cả MFA), ORG_ID, PROPERTY_ID.
//   k6 run -e BASE_URL=http://127.0.0.1:3100 -e K6_COOKIE="…" -e ORG_ID=… -e PROPERTY_ID=… perf/k6/room-list.js
import { check } from "k6";
import http from "k6/http";
import {
  assertSafeTarget,
  BASE_URL,
  dateOffset,
  queryHeaders,
  requireEnv,
  scenarios,
  thresholds,
} from "./lib.js";

export const options = {
  scenarios: scenarios("roomList"),
  thresholds: {
    ...thresholds("rooms-page"),
    ...thresholds("today-summary"),
    ...thresholds("reservation-list"),
  },
};

export function setup() {
  assertSafeTarget();
  requireEnv("K6_COOKIE", "ORG_ID", "PROPERTY_ID");
}

export function roomList() {
  const page = http.get(`${BASE_URL}/phong`, { headers: queryHeaders(), tags: { name: "rooms-page" } });
  check(page, { "trang phòng 200": (r) => r.status === 200 });

  const today = http.get(`${BASE_URL}/api/v1/today/getSummary?property_id=${__ENV.PROPERTY_ID}`, {
    headers: queryHeaders(),
    tags: { name: "today-summary" },
  });
  check(today, { "tóm tắt 200": (r) => r.status === 200 });

  const list = http.get(
    `${BASE_URL}/api/v1/reservation/list?property_id=${__ENV.PROPERTY_ID}&from=${dateOffset(0)}&to=${dateOffset(7)}`,
    { headers: queryHeaders(), tags: { name: "reservation-list" } },
  );
  check(list, { "lịch đặt phòng 200": (r) => r.status === 200 });
}
