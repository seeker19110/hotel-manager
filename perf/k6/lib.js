// Dùng chung cho các kịch bản k6 (T-608; XC-PERF-004, QA-PERF-002/007/010). Không phải kịch bản — k6 không chạy file này trực tiếp.
//
// Biến môi trường (xem docs/perf/README.md):
//   BASE_URL            bắt buộc; host phải nằm trong K6_ALLOWED_HOSTS (QA-PERF-007: KHÔNG tải vào production)
//   K6_ALLOWED_HOSTS    mặc định "localhost,127.0.0.1,[::1]"; staging thêm vào đây có chủ đích
//   K6_PROFILE          smoke (mặc định, 1 VU × 30 s) | load (tăng dần tới K6_VUS, mặc định 200 — PROJECT.md §5) | spike
//   K6_VUS, K6_DURATION chỉnh quy mô profile load/smoke
import http from "k6/http";

export const BASE_URL = (__ENV.BASE_URL || "").replace(/\/+$/, "");

/** Ngưỡng theo PROJECT.md §5 / docs/ops/SLO.md: API thường p95 < 800 ms; tạo giữ phòng p95 < 1,5 s; lỗi < 1%. */
export const LIMITS = { apiP95Ms: 800, apiP99Ms: 2000, holdP95Ms: 1500, holdP99Ms: 3000, failRate: 0.01 };

/** Dừng ngay nếu BASE_URL thiếu hoặc không thuộc danh sách host cho phép (mặc định chỉ máy cục bộ). */
export function assertSafeTarget() {
  if (!BASE_URL) throw new Error("Thiếu BASE_URL (ví dụ http://127.0.0.1:3100)");
  const m = /^https?:\/\/([^/:]+|\[[^\]]+\])(?::\d+)?(?:\/|$)/.exec(BASE_URL);
  if (!m) throw new Error(`BASE_URL không hợp lệ: ${BASE_URL}`);
  const allowed = (__ENV.K6_ALLOWED_HOSTS || "localhost,127.0.0.1,[::1]").split(",").map((s) => s.trim());
  if (!allowed.includes(m[1])) {
    throw new Error(
      `BASE_URL ${m[1]} không nằm trong K6_ALLOWED_HOSTS (${allowed.join(",")}) — không tải vào production`,
    );
  }
}

/** Cấu hình scenario theo K6_PROFILE cho hàm `exec`. */
export function scenarios(exec) {
  const profile = __ENV.K6_PROFILE || "smoke";
  const vus = Number(__ENV.K6_VUS || 200);
  if (profile === "load") {
    return {
      [exec]: {
        executor: "ramping-vus",
        exec,
        startVUs: 1,
        stages: [
          { duration: "1m", target: Math.max(1, Math.round(vus / 4)) },
          { duration: __ENV.K6_DURATION || "5m", target: vus },
          { duration: "1m", target: 0 },
        ],
        gracefulRampDown: "30s",
      },
    };
  }
  if (profile === "spike") {
    return {
      [exec]: {
        executor: "ramping-arrival-rate",
        exec,
        startRate: 1,
        timeUnit: "1s",
        preAllocatedVUs: 50,
        maxVUs: Math.max(100, vus),
        stages: [
          { duration: "30s", target: 5 },
          { duration: "10s", target: 100 },
          { duration: "1m", target: 100 },
          { duration: "30s", target: 5 },
        ],
      },
    };
  }
  return {
    [exec]: {
      executor: "constant-vus",
      exec,
      vus: Number(__ENV.K6_VUS || 1),
      duration: __ENV.K6_DURATION || "30s",
    },
  };
}

/** Ngưỡng chuẩn: phân vị (p95/p99) và tỷ lệ lỗi — KHÔNG dùng trung bình làm cổng (XC-PERF-004). `tag` = nhãn `name` của request. */
export function thresholds(tag, p95 = LIMITS.apiP95Ms, p99 = LIMITS.apiP99Ms) {
  return {
    http_req_failed: [{ threshold: `rate<${LIMITS.failRate}`, abortOnFail: true, delayAbortEval: "10s" }],
    checks: ["rate>0.99"],
    [`http_req_duration{name:${tag}}`]: [`p(95)<${p95}`, `p(99)<${p99}`],
  };
}

export function uuidv4() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else if (i === 19) s += hex[8 + Math.floor(Math.random() * 4)];
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return s;
}

/** Header cho lệnh ghi: Origin cùng nguồn (CSRF), Idempotency-Key mới mỗi lần, cookie phiên (K6_COOKIE) và tổ chức. */
export function commandHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    origin: BASE_URL,
    "idempotency-key": uuidv4(),
    ...(__ENV.K6_COOKIE ? { cookie: __ENV.K6_COOKIE } : {}),
    ...(__ENV.ORG_ID ? { "x-org-id": __ENV.ORG_ID } : {}),
    ...extra,
  };
}

export function queryHeaders() {
  return {
    ...(__ENV.K6_COOKIE ? { cookie: __ENV.K6_COOKIE } : {}),
    ...(__ENV.ORG_ID ? { "x-org-id": __ENV.ORG_ID } : {}),
  };
}

export function postCommand(name, path, body, tag) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: commandHeaders(),
    tags: { name: tag || name },
  });
}

export function requireEnv(...names) {
  for (const n of names)
    if (!__ENV[n]) throw new Error(`Thiếu biến môi trường ${n} (xem docs/perf/README.md)`);
}

/** Ngày YYYY-MM-DD cách hôm nay `offset` ngày (UTC) — dùng cho đặt phòng thử. */
export function dateOffset(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}
