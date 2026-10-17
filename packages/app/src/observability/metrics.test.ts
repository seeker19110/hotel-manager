// PLAN đợt 3 T-225 — định dạng Prometheus, token metrics, kiểm sẵn sàng (thuần, không CSDL).
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { handleMetrics, metricsAuthorized, metricsToken, readiness, renderPrometheus } from "./metrics.ts";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("renderPrometheus", () => {
  it("nhóm theo tên, một HELP/TYPE mỗi nhóm, nhãn được escape, tên sai dạng bị bỏ", () => {
    const text = renderPrometheus([
      { name: "hm_up", value: 1 },
      { name: "hm_export_jobs", labels: { status: "failed" }, value: 2 },
      { name: "hm_export_jobs", labels: { status: 'a"b\\c\nd' }, value: 0 },
      { name: "bad name", value: 9 },
      { name: "notification_dead_total", value: 3 },
    ]);
    expect(text).toBe(
      [
        "# HELP hm_up Ứng dụng đang trả lời (1).",
        "# TYPE hm_up gauge",
        "hm_up 1",
        "# HELP hm_export_jobs Job xuất dữ liệu theo trạng thái.",
        "# TYPE hm_export_jobs gauge",
        'hm_export_jobs{status="failed"} 2',
        'hm_export_jobs{status="a\\"b\\\\c\\nd"} 0',
        "# HELP notification_dead_total Lần gửi email đã hết lượt thử (dead).",
        "# TYPE notification_dead_total counter",
        "notification_dead_total 3",
        "",
      ].join("\n"),
    );
  });
});

describe("token metrics", () => {
  it("dẫn xuất tất định từ bí mật; Bearer đúng → true; sai/thiếu/khác bí mật → false", () => {
    const tok = metricsToken(SECRET);
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(metricsToken(SECRET)).toBe(tok);
    expect(metricsAuthorized(`Bearer ${tok}`, SECRET)).toBe(true);
    expect(metricsAuthorized(`Bearer ${tok}x`, SECRET)).toBe(false);
    expect(metricsAuthorized(tok, SECRET)).toBe(false);
    expect(metricsAuthorized(null, SECRET)).toBe(false);
    expect(metricsAuthorized(`Bearer ${tok}`, `${SECRET}?`)).toBe(false);
  });

  it("không token → 401, không chạm CSDL", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("không được đọc CSDL");
        },
      },
    ) as Kysely<unknown>;
    const r = await handleMetrics(new Request("http://x/api/metrics"), { db, secret: SECRET });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  });
});

describe("readiness", () => {
  const okDb = { executeQuery: async () => ({ rows: [] }) } as unknown as Kysely<unknown>;
  it("kho lỗi → not ready + storage fail; máy quét treo → timeout; không lộ thông điệp lỗi", async () => {
    const r = await readiness(
      {
        db: okDb,
        storage: { ping: () => Promise.reject(new Error("bí mật nội bộ")) },
        scanner: { scan: () => new Promise(() => {}) },
      },
      50,
    );
    expect(r.ready).toBe(false);
    expect(r.checks.storage).toBe("fail");
    expect(r.checks.scanner).toBe("timeout");
    expect(JSON.stringify(r)).not.toContain("bí mật");
  });
});
