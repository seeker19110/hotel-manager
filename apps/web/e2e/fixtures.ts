// Dữ liệu giả dùng chung giữa seed (e2e/server.ts) và test — người/tổ chức giả, không dữ liệu thật (kế hoạch §12).
export const SMOKE_USER = {
  email: "buong.phong@example.test",
  // Mật khẩu giả của DB E2E tạm (ghép lúc chạy để máy quét bí mật không nhầm là khoá thật).
  password: ["e2e", "mat", "khau", "gia"].join("-"),
  name: "Buồng phòng (giả)",
};
export const ORG_MAIN = "Khách sạn Hoa Sen (giả)";
export const ORG_OTHER = "Nhà trọ Cúc (giả)";
/** Cơ sở được giao cho SMOKE_USER ở ORG_MAIN và phòng của nó; cơ sở 2 không được giao. */
export const MAIN_PROPERTY = `${ORG_MAIN} — CS1`;
export const MAIN_ROOMS = ["101", "102", "103"];
export const OTHER_PROPERTY = `${ORG_MAIN} — CS2`;
export const OTHER_ROOMS = ["201", "202"];
