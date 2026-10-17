// T-406 (OPS-OBS-003, XC-PERF-004) — metric HTTP trong bộ nhớ: histogram thời gian xử lý + counter theo route/method/status,
// không nhãn cardinality cao, trần số chuỗi; xuất Prometheus đúng định dạng histogram. Thuần, không CSDL.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createHttpMetrics,
  HTTP_DURATION_BUCKETS,
  MAX_SERIES,
  normalizeRoute,
  OVERFLOW_SERIES,
  observeHttp,
  withHttpMetrics,
} from "./http-metrics.ts";
import { handleHealth, handleMetrics, metricsToken, renderPrometheus } from "./metrics.ts";

const value = (m: ReturnType<typeof createHttpMetrics>, name: string, labels: Record<string, string>) =>
  m
    .samples()
    .find(
      (s) =>
        s.name === name &&
        Object.entries(labels).every(([k, v]) => (s.labels as Record<string, string>)[k] === v),
    )?.value;

describe("http-metrics — đếm và histogram", () => {
  it("quan sát một request: counter +1, sum cộng thời gian, bucket tích luỹ đúng biên (le=0.8 có mặt cho SLO 800 ms)", () => {
    const m = createHttpMetrics();
    m.observe("/api/v1/payment/confirm", "POST", 200, 0.3);
    m.observe("/api/v1/payment/confirm", "POST", 200, 0.9);
    const l = { route: "/api/v1/payment/confirm", method: "POST", status: "200" };
    expect(value(m, "hm_http_requests_total", l)).toBe(2);
    expect(value(m, "hm_http_request_duration_seconds_count", l)).toBe(2);
    expect(value(m, "hm_http_request_duration_seconds_sum", l)).toBeCloseTo(1.2, 10);
    expect(HTTP_DURATION_BUCKETS).toContain(0.8);
    expect(value(m, "hm_http_request_duration_seconds_bucket", { ...l, le: "0.5" })).toBe(1);
    expect(value(m, "hm_http_request_duration_seconds_bucket", { ...l, le: "0.8" })).toBe(1);
    expect(value(m, "hm_http_request_duration_seconds_bucket", { ...l, le: "1" })).toBe(2);
    expect(value(m, "hm_http_request_duration_seconds_bucket", { ...l, le: "+Inf" })).toBe(2);
    // Bucket tích luỹ không giảm theo biên.
    const b = m
      .samples()
      .filter((s) => s.name === "hm_http_request_duration_seconds_bucket")
      .map((s) => s.value);
    expect([...b].sort((x, y) => x - y)).toEqual(b);
  });

  it("status/method khác nhau là chuỗi khác; method lạ → OTHER; status ngoài 100–599 → 0; thời lượng âm/NaN/Infinity coi là 0", () => {
    const m = createHttpMetrics();
    m.observe("/x", "get", 404, 0.01);
    m.observe("/x", "BREW", 200, 0.01);
    m.observe("/x", "GET", 999, Number.NaN);
    m.observe("/x", "GET", 200, -5);
    m.observe("/x", "GET", 200, Number.POSITIVE_INFINITY);
    expect(value(m, "hm_http_requests_total", { route: "/x", method: "GET", status: "404" })).toBe(1);
    expect(value(m, "hm_http_requests_total", { route: "/x", method: "other", status: "200" })).toBe(1);
    expect(value(m, "hm_http_requests_total", { route: "/x", method: "GET", status: "0" })).toBe(1);
    const l = { route: "/x", method: "GET", status: "200" };
    expect(value(m, "hm_http_request_duration_seconds_sum", l)).toBe(0);
    expect(value(m, "hm_http_requests_total", l)).toBe(2);
  });

  it("rỗng: chưa quan sát gì thì không có mẫu nào", () => {
    expect(createHttpMetrics().samples()).toEqual([]);
  });
});

describe("http-metrics — nhãn route không chứa id; trần số chuỗi", () => {
  it("normalizeRoute: UUID, số, token dài → {id}; bỏ query; ký tự lạ → other; mẫu route đúng giữ nguyên", () => {
    const id = "6f1c2b3a-1111-4222-8333-444455556666";
    expect(normalizeRoute(`/api/v1/commands/${id}`)).toBe("/api/v1/commands/{id}");
    expect(normalizeRoute("/api/v1/portal/guest/stays/12345?x=1#f")).toBe("/api/v1/portal/guest/stays/{id}");
    expect(normalizeRoute("/api/v1/webhooks/sim/abcdef0123456789abcdef")).toBe("/api/v1/webhooks/sim/{id}");
    expect(normalizeRoute("/api/v1/commands/{id}")).toBe("/api/v1/commands/{id}");
    expect(normalizeRoute("/api/v1/session/switchOrganization")).toBe("/api/v1/session/switchOrganization");
    expect(normalizeRoute("/api/auth/[...all]")).toBe("/api/auth/[...all]");
    expect(normalizeRoute('/a"b\nc')).toBe("other");
    expect(normalizeRoute("")).toBe("other");
    expect(normalizeRoute("x".repeat(500))).toBe("other");
  });

  it("10.000 đường dẫn có id khác nhau ⇒ vẫn một chuỗi (không phình theo id)", () => {
    const m = createHttpMetrics();
    for (let i = 0; i < 10_000; i++) m.observe(`/api/v1/commands/${crypto.randomUUID()}`, "GET", 200, 0.01);
    expect(m.seriesCount()).toBe(1);
    expect(value(m, "hm_http_requests_total", { route: "/api/v1/commands/{id}" })).toBe(10_000);
  });

  it(`kẻ tấn công thử 100.000 route lạ ⇒ số chuỗi không vượt trần (${MAX_SERIES}); mẫu không mất (gộp vào route=other)`, () => {
    const m = createHttpMetrics();
    for (let i = 0; i < 100_000; i++)
      m.observe(`/probe/seg${i % 997}-${i}x/${"abcdefghij"[i % 10]}`, "GET", 404, 0.001);
    expect(m.seriesCount()).toBeLessThanOrEqual(MAX_SERIES + OVERFLOW_SERIES);
    const total = m
      .samples()
      .filter((s) => s.name === "hm_http_requests_total")
      .reduce((a, s) => a + s.value, 0);
    expect(total).toBe(100_000);
    expect(
      value(m, "hm_http_requests_total", { route: "other", method: "other", status: "4xx" }),
    ).toBeGreaterThan(0);
  });

  it("trần nhỏ: chuỗi đã có vẫn cập nhật khi đã đầy; route mới gộp vào chuỗi tràn theo lớp status, không mất mẫu", () => {
    const m = createHttpMetrics(2);
    m.observe("/a", "GET", 200, 0.1);
    m.observe("/b", "GET", 200, 0.1);
    m.observe("/c", "GET", 200, 0.1);
    m.observe("/d", "POST", 503, 0.1);
    m.observe("/a", "GET", 200, 0.1);
    expect(m.seriesCount()).toBe(4); // a, b + tràn 2xx + tràn 5xx
    expect(value(m, "hm_http_requests_total", { route: "/a" })).toBe(2);
    expect(value(m, "hm_http_requests_total", { route: "other", method: "other", status: "2xx" })).toBe(1);
    expect(value(m, "hm_http_requests_total", { route: "other", method: "other", status: "5xx" })).toBe(1);
  });
});

describe("http-metrics — đo handler", () => {
  const clockOf = (...ticks: number[]) => {
    let i = 0;
    return () => ticks[i++] ?? 0;
  };

  it("observeHttp: status của Response + thời gian theo đồng hồ đơn điệu (ms → giây)", async () => {
    const m = createHttpMetrics();
    const res = await observeHttp(
      "/api/v1/me",
      "GET",
      async () => new Response("x", { status: 401 }),
      m,
      clockOf(1000, 1250),
    );
    expect(res.status).toBe(401);
    const l = { route: "/api/v1/me", method: "GET", status: "401" };
    expect(value(m, "hm_http_request_duration_seconds_sum", l)).toBeCloseTo(0.25, 10);
  });

  it("handler ném lỗi ⇒ ghi 500 rồi ném tiếp (Next trả 500), không nuốt lỗi", async () => {
    const m = createHttpMetrics();
    await expect(
      observeHttp(
        "/api/v1/me",
        "POST",
        async () => {
          throw new Error("hỏng");
        },
        m,
        clockOf(0, 100),
      ),
    ).rejects.toThrow("hỏng");
    expect(value(m, "hm_http_requests_total", { route: "/api/v1/me", method: "POST", status: "500" })).toBe(
      1,
    );
  });

  it("withHttpMetrics: nhãn route là mẫu cố định, KHÔNG lấy từ URL của request", async () => {
    // Dùng sổ toàn cục qua observeHttp mặc định sẽ lẫn test khác ⇒ kiểm qua observeHttp + registry riêng ở trên; ở đây kiểm
    // wrapper chuyển tiếp đối số và trả Response nguyên vẹn.
    const wrapped = withHttpMetrics(
      "/api/v1/portal/guest/stays/{id}",
      async (req: Request, ctx: { id: string }) =>
        Response.json({ url: req.url, id: ctx.id }, { status: 200 }),
    );
    const r = await wrapped(
      new Request("http://x/api/v1/portal/guest/stays/6f1c2b3a-1111-4222-8333-444455556666"),
      {
        id: "abc",
      },
    );
    expect(await r.json()).toMatchObject({ id: "abc" });
  });
});

describe("http-metrics — xuất Prometheus", () => {
  it("histogram: một HELP/TYPE ở tên gốc, _bucket có le tăng dần + +Inf, rồi _sum/_count; counter riêng", () => {
    const m = createHttpMetrics();
    m.observe("/api/v1/me", "GET", 200, 0.02);
    const text = renderPrometheus([{ name: "hm_up", value: 1 }, ...m.samples()]);
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("# TYPE hm_http_request_duration_seconds "))).toEqual([
      "# TYPE hm_http_request_duration_seconds histogram",
    ]);
    expect(lines.filter((l) => l.startsWith("# TYPE hm_http_requests_total "))).toEqual([
      "# TYPE hm_http_requests_total counter",
    ]);
    expect(text).not.toContain("# TYPE hm_http_request_duration_seconds_bucket");
    expect(text).toContain(
      'hm_http_request_duration_seconds_bucket{route="/api/v1/me",method="GET",status="200",le="0.025"} 1',
    );
    expect(text).toContain(
      'hm_http_request_duration_seconds_bucket{route="/api/v1/me",method="GET",status="200",le="0.01"} 0',
    );
    expect(text).toContain(
      'hm_http_request_duration_seconds_bucket{route="/api/v1/me",method="GET",status="200",le="+Inf"} 1',
    );
    expect(text).toContain(
      'hm_http_request_duration_seconds_count{route="/api/v1/me",method="GET",status="200"} 1',
    );
    expect(text).toContain('hm_http_requests_total{route="/api/v1/me",method="GET",status="200"} 1');
  });

  it("/api/metrics vẫn xuất metric HTTP và hm_metrics_db_ok 0 khi CSDL lỗi (SLI khả dụng cần đúng lúc đó)", async () => {
    const secret = "test-secret-at-least-32-characters-long!!";
    const deadDb = {
      getExecutor: () => {
        throw new Error("CSDL chết");
      },
      executeQuery: () => Promise.reject(new Error("CSDL chết")),
    } as unknown as Kysely<unknown>;
    const res = await handleMetrics(
      new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${metricsToken(secret)}` } }),
      { db: deadDb, secret },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hm_up 1");
    expect(text).toContain("hm_metrics_db_ok 0");
    expect(text).not.toContain("CSDL chết");
  });
});

describe("liveness /api/health — tĩnh (OPS-OBS-006)", () => {
  it("không nhận phụ thuộc, 200 {status:ok}, no-store; không đọc CSDL/cấu hình/env", async () => {
    expect(handleHealth.length).toBe(0);
    const res = handleHealth();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
