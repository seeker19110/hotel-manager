// Luồng nóng 1: đăng nhập → danh sách tổ chức → chọn tổ chức (XC-PERF-004, QA-PERF-002/010).
// Dùng tài khoản KHÔNG bắt MFA (vai trò buồng phòng/bảo trì) vì k6 không nhập được mã TOTP. Better Auth giới hạn tần suất đăng nhập
// theo IP: đo tải thật cần tắt giới hạn IP ở môi trường đo hoặc phân tán IP (ghi lại trong báo cáo).
//   k6 run -e BASE_URL=http://127.0.0.1:3100 -e USER_EMAIL=… -e USER_PASSWORD=… -e ORG_ID=… perf/k6/login-select-org.js
import { check } from "k6";
import http from "k6/http";
import { assertSafeTarget, BASE_URL, requireEnv, scenarios, thresholds, uuidv4 } from "./lib.js";

export const options = {
  scenarios: scenarios("loginSelectOrg"),
  thresholds: {
    ...thresholds("sign-in"),
    ...thresholds("me"),
    ...thresholds("switchOrganization"),
  },
};

export function setup() {
  assertSafeTarget();
  requireEnv("USER_EMAIL", "USER_PASSWORD", "ORG_ID");
}

export function loginSelectOrg() {
  const json = { "content-type": "application/json", origin: BASE_URL };
  const signIn = http.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: __ENV.USER_EMAIL, password: __ENV.USER_PASSWORD }),
    { headers: json, tags: { name: "sign-in" } },
  );
  check(signIn, { "đăng nhập 200": (r) => r.status === 200 });

  const me = http.get(`${BASE_URL}/api/v1/me`, { tags: { name: "me" } });
  check(me, {
    "me 200": (r) => r.status === 200,
    "me có tổ chức": (r) => String(r.body).includes(__ENV.ORG_ID),
  });

  const pick = http.post(
    `${BASE_URL}/api/v1/session/switchOrganization`,
    JSON.stringify({ organization_id: __ENV.ORG_ID }),
    { headers: { ...json, "idempotency-key": uuidv4() }, tags: { name: "switchOrganization" } },
  );
  check(pick, { "chọn tổ chức 200": (r) => r.status === 200 });
}
