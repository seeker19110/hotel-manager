// Metric HTTP kiểu RED (PLAN đợt 5 T-406; OPS-OBS-003, XC-PERF-004; docs/ops/SLO.md):
//   hm_http_requests_total{route,method,status}                    — counter
//   hm_http_request_duration_seconds{route,method,status} (le=…)   — histogram (giây)
// Lưu TRONG BỘ NHỚ tiến trình web (mỗi bản chạy một sổ; Prometheus scrape từng bản rồi tự cộng). Không phụ thuộc CSDL nên đo cả
// khi CSDL chết. `/api/metrics` xuất cùng các metric nghiệp vụ hiện có.
//
// Chống bùng nổ nhãn (cardinality): `route` luôn là MẪU route (`/api/v1/payment/confirm`, `/api/v1/commands/{id}`), không bao giờ
// là đường dẫn thật chứa id; mọi mã định danh trong nhãn bị đổi thành `{id}` (`normalizeRoute`), nhãn lạ → `other`; `method` giới hạn
// trong tập chuẩn; `status` là mã HTTP 100–599. Số chuỗi (series) có trần cứng `MAX_SERIES` — vượt thì gộp vào chuỗi tràn
// `route="other", method="other", status="Nxx"` (tối đa 6 chuỗi: không bao giờ mất mẫu, không bao giờ phình bộ nhớ vì đầu vào của
// kẻ tấn công). Tổng số chuỗi ≤ MAX_SERIES + OVERFLOW_SERIES.
import { msToSecondsExact } from "@hm/domain";
import { withRequestTrace } from "../logging/index.ts";
import type { Sample } from "./metrics.ts";

/** Biên histogram (giây). Có 0,8 và 1,5 để SLI "≤ 800 ms" (SLO-LAT) và "≤ 1,5 s" (SLO-HOLD) tính được bằng `le` (docs/ops/SLO.md). */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 1.5, 2.5, 5, 10,
] as const;
/** Trần số chuỗi (route × method × status) — OPS-OBS-003: dưới 10k; mặc định chặt hơn nhiều. */
export const MAX_SERIES = 1000;
/** Chuỗi tràn tối đa (status theo lớp 0xx…5xx). */
export const OVERFLOW_SERIES = 6;

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const OTHER = "other";
const ROUTE_OK = /^[A-Za-z0-9_\-/{}[\].:]{1,100}$/;
const UUID_SEG = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Đoạn toàn số, hoặc băm/token dài (≥ 16 ký tự hex/base64url) — coi là mã định danh.
const NUMERIC_SEG = /^\d+$/;
const TOKEN_SEG = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Đổi một đường dẫn thành mẫu route: UUID/số/token dài → `{id}`; bỏ query/fragment. Dùng làm lưới chặn cuối — route đúng nên được
 * truyền sẵn dạng mẫu; hàm này bảo đảm một đường dẫn thật lọt vào cũng không tạo chuỗi mới theo id.
 */
export function normalizeRoute(route: string): string {
  const path = (route.split(/[?#]/, 1)[0] ?? "").replace(UUID_SEG, "{id}");
  const out = path
    .split("/")
    .map((seg) => (NUMERIC_SEG.test(seg) || (TOKEN_SEG.test(seg) && /\d/.test(seg)) ? "{id}" : seg))
    .join("/");
  return ROUTE_OK.test(out) ? out : OTHER;
}

interface Series {
  route: string;
  method: string;
  status: string;
  count: number;
  sum: number;
  /** Số quan sát tích luỹ ≤ từng biên (cùng thứ tự HTTP_DURATION_BUCKETS). */
  buckets: number[];
}

export interface HttpMetrics {
  observe(route: string, method: string, status: number, seconds: number): void;
  /** Mẫu Prometheus: `_total` + histogram (`_bucket`/`_sum`/`_count`). */
  samples(): Sample[];
  /** Số chuỗi hiện có (test/kiểm cardinality). */
  seriesCount(): number;
  reset(): void;
}

export function createHttpMetrics(maxSeries: number = MAX_SERIES): HttpMetrics {
  const series = new Map<string, Series>();

  function seriesFor(route: string, method: string, status: string): Series {
    const key = `${route}\u0000${method}\u0000${status}`;
    const found = series.get(key);
    if (found) return found;
    if (series.size >= maxSeries && route !== OTHER) {
      // Đầy: gộp vào chuỗi tràn theo lớp status (mẫu vẫn được đếm, số chuỗi không tăng thêm quá OVERFLOW_SERIES).
      return seriesFor(OTHER, OTHER, `${status.slice(0, 1)}xx`);
    }
    const s: Series = {
      route,
      method,
      status,
      count: 0,
      sum: 0,
      buckets: new Array<number>(HTTP_DURATION_BUCKETS.length).fill(0),
    };
    series.set(key, s);
    return s;
  }

  return {
    observe(route, method, status, seconds) {
      const m = method.toUpperCase();
      const st = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "0";
      // Thời lượng âm/NaN (đồng hồ lùi, lỗi đo) không được làm hỏng tổng: coi là 0.
      const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      const s = seriesFor(normalizeRoute(route), METHODS.has(m) ? m : OTHER, st);
      s.count += 1;
      s.sum += sec;
      HTTP_DURATION_BUCKETS.forEach((le, i) => {
        if (sec <= le) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
      });
    },
    samples() {
      const out: Sample[] = [];
      for (const s of series.values()) {
        const base = { route: s.route, method: s.method, status: s.status };
        out.push({ name: "hm_http_requests_total", labels: base, value: s.count });
        HTTP_DURATION_BUCKETS.forEach((le, i) => {
          out.push({
            name: "hm_http_request_duration_seconds_bucket",
            labels: { ...base, le: String(le) },
            value: s.buckets[i] ?? 0,
          });
        });
        out.push({
          name: "hm_http_request_duration_seconds_bucket",
          labels: { ...base, le: "+Inf" },
          value: s.count,
        });
        out.push({ name: "hm_http_request_duration_seconds_sum", labels: base, value: s.sum });
        out.push({ name: "hm_http_request_duration_seconds_count", labels: base, value: s.count });
      }
      return out;
    },
    seriesCount: () => series.size,
    reset: () => series.clear(),
  };
}

/** Sổ metric của tiến trình web. */
export const httpMetrics: HttpMetrics = createHttpMetrics();

/**
 * Đo một handler HTTP: thời gian xử lý (đồng hồ đơn điệu), status của Response; handler ném lỗi ⇒ ghi 500 rồi ném tiếp (Next trả 500).
 * `route` là MẪU route do mã gọi chọn (không lấy từ URL của request).
 */
export async function observeHttp(
  route: string,
  method: string,
  fn: () => Promise<Response>,
  registry: HttpMetrics = httpMetrics,
  clock: () => number = () => performance.now(),
): Promise<Response> {
  const t0 = clock();
  try {
    const res = await fn();
    registry.observe(route, method, res.status, msToSecondsExact(clock() - t0));
    return res;
  } catch (err) {
    registry.observe(route, method, 500, msToSecondsExact(clock() - t0));
    throw err;
  }
}

/**
 * Bọc một route handler của Next (`(req, ctx) => Response`) bằng `observeHttp` với mẫu route cố định, và đặt nó trong ngữ cảnh
 * trace của request (`traceparent` đến/mới, mọi log mang `trace_id`/`span_id`, phản hồi trả lại `traceparent`).
 */
export function withHttpMetrics<A extends unknown[]>(
  route: string,
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return (req, ...rest) =>
    observeHttp(route, req.method, () => withRequestTrace(req, async () => handler(req, ...rest)));
}
